// Import the in-scope items from a Wikidata *entity JSON dump* into `items` +
// `external_ids` (+ `properties`), replacing the QLever-driven Ruby dumper and
// db/seed.ts as the way the mirror is (re)built.
//
// On Toolforge the weekly dump is on the read-only NFS mount at
//   /public/dumps/public/wikidatawiki/entities/latest-all.json.gz
// (~156 GB gzip, ~1.6 TB inflated, ~118M entities, one per line, weekly). A
// build-service job only sees it with `mount: all`. The whole file is streamed
// once, on one CPU, in a few hours:
//
//   1. Inflate (in-process zlib) into ~1 MB chunks; only complete lines are
//      handled, the tail is carried into the next chunk.
//   2. Cheap pre-filter: a Buffer search for `"numeric-id":<n>` (each imported
//      class in IMPORT_CLASSES, followed by a non-digit) and for lines that
//      start `{"type":"property"`. Everything else is never decoded or parsed.
//   3. Hit lines are JSON.parsed, converted with the shared entityToItem, and
//      kept if a best-rank P31 really is one of the classes (a mention of a
//      class QID in any other statement is discarded here).
//   4. Items are upserted in batches; each item's external ids are rebuilt
//      wholesale (the schema's "rebuilt for an item on each sync" contract).
//      Property entities become `properties` rows via the existing sync path.
//   5. After a complete pass, items that were not in the dump any more (merged
//      away, deleted, retyped) are pruned and their open candidates settled.
//
// Everything is an idempotent upsert, so a job killed mid-way (a node drain,
// say) is simply re-run.
//
// The pass can be split across N jobs ("shards"). The dump's .gz is not one
// stream: the generator (operations/dumps, dumpwikibasejson.sh) gzips each
// 65k-entity batch on its own and `cat`s them together with tiny `[`, `,` and
// `]` members between, ~2,000 independent members that each start on a line
// boundary. Shard i/N takes the N-th of the compressed bytes starting at the
// first member header at or past i*size/N and ending at the first one at or
// past (i+1)*size/N, so every byte is read by exactly one shard and no index
// pass is needed. Each shard upserts on its own; items are stamped with the
// dump they were seen in, and the shard that completes the set for a dump
// (see `dump_import_runs`) prunes the rows the dump no longer contains.
import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { constants as zlibConstants, createGunzip, inflateRawSync } from "node:zlib";
import { and, asc, count, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { dumpImportRuns, externalIds, items, mergeCandidates } from "../db/schema.ts";
import { syncProperties } from "./properties-sync.ts";
import { toSqlDatetime } from "./auth/time.ts";
import type { Item } from "../src/lib/compare.ts";
import type { PropertyRow } from "../src/lib/sparql.ts";
import { externalIdRows, primaryLabel, primaryType } from "../src/lib/wikidata.ts";
import {
  type Entity,
  entityToItem,
  isInstanceOfAny,
  propertyRowFromEntity,
} from "../src/lib/wikibase.ts";
import { IMPORT_CLASSES } from "../src/lib/import-classes.ts";

// The class list lives in src/lib so the candidates list's type filter can
// share it; re-exported here for the jobs and tests that import it from here.
export { IMPORT_CLASSES, VIDEO_GAME } from "../src/lib/import-classes.ts";

/** Where Toolforge mounts the latest weekly JSON dump (needs `mount: all`). */
export const DEFAULT_DUMP_PATH = "/public/dumps/public/wikidatawiki/entities/latest-all.json.gz";

// ---------------------------------------------------------------------------
// Streaming scan
// ---------------------------------------------------------------------------

const NL = 0x0a;
const PROPERTY_NEEDLE = Buffer.from('{"type":"property"');
const CHUNK_SIZE = 1 << 20;

const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;

export interface ScanStats {
  /** Inflated bytes consumed. */
  bytes: number;
  /** Dump lines seen (≈ entities; the `[` / `]` lines are counted too). */
  lines: number;
  /** Lines that passed the pre-filter and were parsed. */
  parsed: number;
  /** Items whose best-rank P31 is the class. */
  matched: number;
  /** Property entities handed to onProperty. */
  properties: number;
  /** True when the scan stopped at `limit` rather than at the end of the dump. */
  stopped: boolean;
  /** Wall-clock seconds so far. */
  seconds: number;
}

export interface ScanOptions {
  /** Class QIDs an item's best-rank P31 must include one of (IMPORT_CLASSES). */
  classQids: readonly string[];
  /** Called with every matching item, in dump order, awaited (backpressure). */
  onItem: (item: Item, entity: Entity) => void | Promise<void>;
  /** Called with every property entity (there are ~13k, interleaved). */
  onProperty?: (entity: Entity) => void | Promise<void>;
  /** Stop after this many matching items (a quick validation run). */
  limit?: number;
  /** Progress callback, invoked every `progressEveryBytes` inflated bytes. */
  onProgress?: (stats: ScanStats) => void;
  progressEveryBytes?: number;
}

/**
 * Open a dump file as a stream of inflated bytes. `.gz` is inflated in-process
 * (as fast as piping `gzip -dc`, and one less thing the image must ship);
 * anything else is read as-is. The `.bz2` dump is refused — bzip2 inflates far
 * too slowly for a one-CPU job.
 */
export function openDump(path: string): Readable {
  return openDumpFile(path).source;
}

/** Which N-th of a dump to read: `index` is 0-based. `{ index: 0, count: 1 }` is the whole file. */
export interface DumpShard {
  index: number;
  count: number;
}

export const WHOLE_DUMP: DumpShard = { index: 0, count: 1 };

/** An open dump (or one shard of it): the inflated stream plus its place in the file on disk. */
export interface DumpFile {
  source: Readable;
  /** First byte of this shard's slice of the file. */
  start: number;
  /** One past the last byte of the slice; `end - start === size`. */
  end: number;
  /** Bytes on disk in this slice (compressed, for a .gz). The whole file for one shard. */
  size: number;
  /** Bytes read from the slice so far (compressed, for a .gz); equals `size` at the end. */
  read: () => number;
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b, 0x08]);
const SEARCH_CHUNK = 4 << 20;
/** Deflate bytes to trial-inflate when deciding whether a magic hit is a real member. */
const PROBE_BYTES = 4096;

/**
 * Length of the gzip header starting at `buf[0]`, or -1 when the bytes are not
 * a well-formed header (RFC 1952: magic, CM=8, no reserved flags, then the
 * optional FEXTRA / FNAME / FCOMMENT / FHCRC fields).
 */
function gzipHeaderLength(buf: Buffer): number {
  if (buf.length < 10 || buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 0x08) return -1;
  const flags = buf[3];
  if (flags & 0xe0) return -1;
  let n = 10;
  if (flags & 0x04) {
    if (buf.length < n + 2) return -1;
    n += 2 + buf.readUInt16LE(n);
  }
  for (const bit of [0x08, 0x10]) {
    if (!(flags & bit)) continue;
    const nul = buf.indexOf(0, n);
    if (nul === -1) return -1;
    n = nul + 1;
  }
  if (flags & 0x02) n += 2;
  return n <= buf.length ? n : -1;
}

/** True when a gzip member really starts at `offset`: valid header, and its first deflate bytes inflate. */
function isMemberStart(fd: number, offset: number): boolean {
  const buf = Buffer.alloc(PROBE_BYTES + 1024);
  const n = readSync(fd, buf, 0, buf.length, offset);
  const header = gzipHeaderLength(buf.subarray(0, n));
  if (header === -1) return false;
  try {
    // A truncated valid stream inflates to a prefix; the pseudo-random deflate
    // bytes that follow a chance `1f 8b 08` inside a member fail within bytes.
    inflateRawSync(buf.subarray(header, n), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first gzip member boundary at or after `from` (`size` when there is none
 * before the end of the file). Scans the compressed bytes for the magic, which
 * runs at memory speed; each hit is verified with a trial inflate. The dump's
 * members are ~70 MB, so a search reads ~35 MB on average.
 */
export function findMemberStart(path: string, from: number): number {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const buf = Buffer.alloc(SEARCH_CHUNK);
    let pos = from;
    while (pos < size) {
      const n = readSync(fd, buf, 0, SEARCH_CHUNK, pos);
      if (n === 0) break;
      const chunk = buf.subarray(0, n);
      let at = -1;
      while ((at = chunk.indexOf(GZIP_MAGIC, at + 1)) !== -1) {
        if (isMemberStart(fd, pos + at)) return pos + at;
      }
      // Step back so a magic split across two reads is still seen whole.
      pos += Math.max(1, n - (GZIP_MAGIC.length - 1));
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

/** The first line start at or after `from` in a plain-text dump (`size` when there is none). */
function findLineStart(path: string, from: number): number {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    if (from === 0) return 0;
    const buf = Buffer.alloc(SEARCH_CHUNK);
    let pos = from;
    while (pos < size) {
      const n = readSync(fd, buf, 0, SEARCH_CHUNK, pos);
      if (n === 0) break;
      const nl = buf.subarray(0, n).indexOf(NL);
      if (nl !== -1) return Math.min(pos + nl + 1, size);
      pos += n;
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

/**
 * The byte range shard `index` of `count` reads: the N-th of the file, widened
 * to whole gzip members (or whole lines for a plain dump) so that the shards
 * partition the file exactly. Both ends are found by the same forward search
 * from the same nominal offsets, so shard i's end is shard i+1's start.
 */
export function dumpSlice(path: string, shard: DumpShard): { start: number; end: number } {
  const { index, count } = shard;
  if (!(Number.isInteger(count) && count >= 1 && Number.isInteger(index) && index >= 0)) {
    throw new Error(`bad shard ${index}/${count}`);
  }
  if (index >= count) throw new Error(`shard index ${index} is out of range for ${count} shards`);
  const size = statSync(path).size;
  if (count === 1) return { start: 0, end: size };
  const boundary = path.endsWith(".gz") ? findMemberStart : findLineStart;
  const nominal = (i: number) => Math.floor((size * i) / count);
  const start = index === 0 ? 0 : boundary(path, nominal(index));
  const end = index === count - 1 ? size : boundary(path, nominal(index + 1));
  return { start, end: Math.max(start, end) };
}

export function openDumpFile(path: string, shard: DumpShard = WHOLE_DUMP): DumpFile {
  if (path.endsWith(".bz2")) {
    throw new Error(`${path}: use the .gz dump (bzip2 is ~10x slower to inflate)`);
  }
  const { start, end } = dumpSlice(path, shard);
  const size = end - start;
  if (size === 0) {
    // More shards than members (or lines): this one has nothing to read.
    return { source: Readable.from([]), start, end, size, read: () => 0 };
  }
  const file = createReadStream(path, { start, end: end - 1, highWaterMark: CHUNK_SIZE });
  const read = () => file.bytesRead;
  if (!path.endsWith(".gz")) return { source: file, start, end, size, read };
  // One Gunzip inflates the whole slice: it carries on across member boundaries.
  const gunzip = createGunzip({ chunkSize: CHUNK_SIZE });
  // pipe() does not forward errors; a vanished NFS file must fail the job.
  file.on("error", (err) => gunzip.destroy(err));
  return { source: file.pipe(gunzip), start, end, size, read };
}

/** "3h 41m", "12m", or "<1m" (for the progress ETA). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Find the [start, end) byte ranges of the lines in `region` that contain
 * `needle`. With `wordBoundary`, a match directly followed by a digit is
 * skipped (so `"numeric-id":7889` does not hit Q78890); with `atLineStart`,
 * only a match at the start of its line counts. `region` must end with `\n`.
 */
function hitLines(
  region: Buffer,
  needle: Buffer,
  opts: { wordBoundary?: boolean; atLineStart?: boolean },
  into: Map<number, number>,
): void {
  let from = 0;
  while (from < region.length) {
    const idx = region.indexOf(needle, from);
    if (idx === -1) break;
    const after = idx + needle.length;
    if (opts.wordBoundary && after < region.length && isDigit(region[after])) {
      from = after;
      continue;
    }
    const start = region.lastIndexOf(NL, idx) + 1;
    const end = region.indexOf(NL, idx);
    if (!opts.atLineStart || start === idx) into.set(start, end);
    from = end + 1;
  }
}

/** Parse one dump line (`{...},`) into an entity; null for the `[` / `]` lines. */
function parseLine(line: Buffer): Entity | null {
  let text = line.toString("utf8").trim();
  if (text.endsWith(",")) text = text.slice(0, -1);
  if (text === "" || text === "[" || text === "]") return null;
  return JSON.parse(text) as Entity;
}

/**
 * Stream a Wikidata entity JSON dump and hand every item whose best-rank P31 is
 * one of `classQids` (and every property entity) to the callbacks. Resolves with
 * the scan statistics.
 */
export async function scanDump(source: Readable, opts: ScanOptions): Promise<ScanStats> {
  const classNeedles = opts.classQids.map((qid) =>
    Buffer.from(`"numeric-id":${qid.replace(/^Q/, "")}`),
  );
  const classSet = new Set(opts.classQids);
  const progressEvery = opts.progressEveryBytes ?? 5e9;
  const started = Date.now();
  const stats: ScanStats = {
    bytes: 0,
    lines: 0,
    parsed: 0,
    matched: 0,
    properties: 0,
    stopped: false,
    seconds: 0,
  };
  let nextProgress = progressEvery;
  let carry: Buffer = Buffer.alloc(0);
  const hits = new Map<number, number>();

  const handleLine = async (line: Buffer): Promise<void> => {
    const entity = parseLine(line);
    if (!entity) return;
    stats.parsed++;
    if (entity.type === "property") {
      stats.properties++;
      await opts.onProperty?.(entity);
      return;
    }
    if (entity.type !== "item") return;
    const item = entityToItem(entity);
    if (!isInstanceOfAny(item, classSet)) return;
    stats.matched++;
    await opts.onItem(item, entity);
  };

  const handleRegion = async (region: Buffer): Promise<boolean> => {
    // Count lines cheaply; most regions have no hit and are otherwise skipped.
    let nl = -1;
    while ((nl = region.indexOf(NL, nl + 1)) !== -1) stats.lines++;

    hits.clear();
    for (const needle of classNeedles) hitLines(region, needle, { wordBoundary: true }, hits);
    if (opts.onProperty) hitLines(region, PROPERTY_NEEDLE, { atLineStart: true }, hits);
    if (hits.size === 0) return false;
    // Dump order matters for nothing, but keep it anyway.
    for (const start of [...hits.keys()].sort((a, b) => a - b)) {
      await handleLine(region.subarray(start, hits.get(start)!));
      if (opts.limit !== undefined && stats.matched >= opts.limit) return true;
    }
    return false;
  };

  for await (const chunk of source as AsyncIterable<Buffer>) {
    stats.bytes += chunk.length;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const last = buf.lastIndexOf(NL);
    if (last === -1) {
      carry = Buffer.from(buf);
      continue;
    }
    // Copy the tail: `chunk` is pool memory the stream may reuse.
    carry = Buffer.from(buf.subarray(last + 1));
    const done = await handleRegion(buf.subarray(0, last + 1));
    stats.seconds = (Date.now() - started) / 1000;
    if (done) {
      stats.stopped = true;
      source.destroy();
      break;
    }
    if (stats.bytes >= nextProgress) {
      nextProgress += progressEvery;
      opts.onProgress?.(stats);
    }
  }
  if (!stats.stopped && carry.length > 0) {
    // A dump always ends in "\n"; tolerate one that doesn't.
    await handleRegion(Buffer.concat([carry, Buffer.from("\n")]));
  }
  stats.seconds = (Date.now() - started) / 1000;
  return stats;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

// MariaDB caps params per statement (65535) and packet size (max_allowed_packet).
// Item rows carry a JSON blob each, so keep those batches modest.
const ITEM_BATCH = 500;
const ID_BATCH = 2000;
/** Items paged per read when pruning (keyset over the PK). */
const READ_PAGE = 10000;
/**
 * Refuse to prune more than this fraction of the mirror in one run unless
 * forced: a truncated or wrong dump would otherwise empty the database.
 */
export const MAX_PRUNE_FRACTION = 0.2;

/**
 * Upsert items and rebuild their external ids — the one write path shared by
 * the dump import and the single-item importer, so both store the same shape.
 * `dump` stamps the rows as seen in that dump; without it (the single-item
 * importer) an existing row keeps its stamp. Returns the number of external-id
 * rows written.
 */
export async function upsertItems(
  batch: Item[],
  stamp = toSqlDatetime(new Date()),
  dump?: string,
): Promise<number> {
  if (batch.length === 0) return 0;
  const rows = batch.map((item) => ({
    qid: item.id,
    primaryLabel: primaryLabel(item) ?? null,
    primaryType: primaryType(item) ?? null,
    data: item,
    lastSyncedAt: stamp,
    lastDump: dump ?? null,
  }));
  for (let i = 0; i < rows.length; i += ITEM_BATCH) {
    await db
      .insert(items)
      .values(rows.slice(i, i + ITEM_BATCH))
      .onDuplicateKeyUpdate({
        set: {
          primaryLabel: sql`values(${items.primaryLabel})`,
          primaryType: sql`values(${items.primaryType})`,
          data: sql`values(${items.data})`,
          lastSyncedAt: sql`values(${items.lastSyncedAt})`,
          lastDump: sql`coalesce(values(${items.lastDump}), ${items.lastDump})`,
        },
      });
  }

  // Rebuild external ids wholesale, deduped on the (qid, property, value) key.
  const qids = batch.map((item) => item.id);
  await db.delete(externalIds).where(inArray(externalIds.qid, qids));
  const idRows: (typeof externalIds.$inferInsert)[] = [];
  const seen = new Set<string>();
  for (const item of batch) {
    for (const r of externalIdRows(item)) {
      const key = `${item.id} ${r.property} ${r.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      idRows.push({ qid: item.id, property: r.property, value: r.value });
    }
  }
  for (let i = 0; i < idRows.length; i += ID_BATCH) {
    await db.insert(externalIds).values(idRows.slice(i, i + ID_BATCH));
  }
  return idRows.length;
}

export interface ImportOptions {
  /** Dump file to read (DEFAULT_DUMP_PATH on Toolforge). Ignored with `source`. */
  path?: string;
  /** Read only this N-th of the file (see the header comment); the whole file by default. */
  shard?: DumpShard;
  /**
   * Identifies the dump for the seen-stamp and the shard bookkeeping. Derived
   * from the file (`wikidata-20260914-all.json.gz` → "20260914") when not given.
   */
  dump?: string;
  /** An already-open stream of inflated dump bytes (tests). */
  source?: Readable;
  /** Class QIDs whose instances to import (defaults to IMPORT_CLASSES). */
  classQids?: readonly string[];
  /** Stop after this many matching items; implies no pruning. */
  limit?: number;
  /** Delete items absent from a complete pass (default true without `limit`). */
  prune?: boolean;
  /** Prune even past MAX_PRUNE_FRACTION. */
  forcePrune?: boolean;
  log?: (message: string) => void;
  progressEveryBytes?: number;
}

export interface ImportStats extends ScanStats {
  /** Items upserted. */
  upserted: number;
  /** External-id rows written. */
  externalIds: number;
  /** Property rows synced. */
  propertyRows: number;
  /** Items deleted because they were no longer in the dump. */
  pruned: number;
  /** Open candidates settled because one side was pruned. */
  settled: number;
}

/**
 * The identifier a dump file is stamped with: the date in its name
 * (`wikidata-20260914-all.json.gz` → "20260914"), else its mtime and size,
 * which every shard of the same file agrees on.
 */
export function dumpIdFor(path: string): string {
  const dated = /\d{8}/.exec(basename(path));
  if (dated) return dated[0];
  const st = statSync(path);
  return `${Math.floor(st.mtimeMs)}-${st.size}`;
}

/**
 * Record that shard `index` of `count` finished a complete pass over `dump`,
 * and report whether that completes the set. Two shards finishing together
 * could both see the set complete and both prune; the second prune finds
 * nothing to do, so no lock is needed.
 */
async function recordShardDone(
  dump: string,
  shard: DumpShard,
  matched: number,
): Promise<{ complete: boolean; matched: number }> {
  await db
    .insert(dumpImportRuns)
    .values({ dump, shard: shard.index, shards: shard.count, matched })
    .onDuplicateKeyUpdate({
      // A retry, or the same dump re-run with another shard count.
      set: { shards: shard.count, matched, finishedAt: sql`current_timestamp` },
    });
  const [row] = await db
    .select({ shards: count(), matched: sql<number>`coalesce(sum(${dumpImportRuns.matched}), 0)` })
    .from(dumpImportRuns)
    .where(and(eq(dumpImportRuns.dump, dump), eq(dumpImportRuns.shards, shard.count)));
  return { complete: row.shards >= shard.count, matched: Number(row.matched) };
}

/**
 * Delete every item not stamped as seen in `dump`, with its external ids, and
 * settle the open candidates that referenced it. Returns [items, candidates].
 */
async function pruneMissing(
  dump: string,
  opts: { force: boolean; log: (m: string) => void },
): Promise<[number, number]> {
  const [{ total }] = await db.select({ total: count() }).from(items);
  const gone: string[] = [];
  let after = "";
  for (;;) {
    const page = await db
      .select({ qid: items.qid })
      .from(items)
      .where(
        and(
          or(isNull(items.lastDump), ne(items.lastDump, dump)),
          after ? gt(items.qid, after) : sql`1 = 1`,
        ),
      )
      .orderBy(asc(items.qid))
      .limit(READ_PAGE);
    if (page.length === 0) break;
    for (const r of page) gone.push(r.qid);
    after = page[page.length - 1].qid;
    if (page.length < READ_PAGE) break;
  }
  if (gone.length === 0) return [0, 0];
  if (!opts.force && gone.length > total * MAX_PRUNE_FRACTION) {
    opts.log(
      `import-dump: NOT pruning ${gone.length} of ${total} items (> ${MAX_PRUNE_FRACTION * 100}%); ` +
        "is the dump complete? Set DUMP_PRUNE_FORCE=1 to prune anyway.",
    );
    return [0, 0];
  }

  const stamp = toSqlDatetime(new Date());
  let settled = 0;
  for (let i = 0; i < gone.length; i += ID_BATCH) {
    const qids = gone.slice(i, i + ID_BATCH);
    await db.transaction(async (tx) => {
      await tx.delete(externalIds).where(inArray(externalIds.qid, qids));
      await tx.delete(items).where(inArray(items.qid, qids));
      const [result] = await tx
        .update(mergeCandidates)
        .set({
          status: "dismissed",
          resolvedAt: stamp,
          resolution: "item no longer in the Wikidata dump (merged, deleted, or retyped)",
        })
        .where(
          and(
            or(inArray(mergeCandidates.fromQid, qids), inArray(mergeCandidates.intoQid, qids)),
            eq(mergeCandidates.status, "open"),
          ),
        );
      settled += result.affectedRows;
    });
  }
  return [gone.length, settled];
}

/**
 * Full import: scan the dump, upsert every matching item in batches, sync the
 * property entities, then (after a complete, uncapped pass) prune the items
 * the dump no longer contains.
 */
export async function runDumpImport(opts: ImportOptions = {}): Promise<ImportStats> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const classQids = opts.classQids ?? IMPORT_CLASSES;
  const shard = opts.shard ?? WHOLE_DUMP;
  const path = opts.path ?? DEFAULT_DUMP_PATH;
  const file = opts.source ? undefined : openDumpFile(path, shard);
  const source = opts.source ?? file!.source;
  const prune = opts.prune ?? opts.limit === undefined;
  const stamp = toSqlDatetime(new Date());
  // A stream has no file to derive the id from: stamp with the moment instead,
  // which still tells this pass apart from every earlier one for the prune.
  const dump = opts.dump ?? (file ? dumpIdFor(path) : stamp);
  // "import-dump:" for the usual single shard; "import-dump 3/8:" otherwise.
  const tag = shard.count === 1 ? "import-dump:" : `import-dump ${shard.index + 1}/${shard.count}:`;
  if (file && shard.count > 1) {
    log(
      `${tag} bytes ${file.start}-${file.end} of ${statSync(path).size} ` +
        `(${(file.size / 1e9).toFixed(2)} GB compressed)` +
        (file.size === 0 ? " — empty slice, more shards than members?" : ""),
    );
  }

  const propertyRows: PropertyRow[] = [];
  let batch: Item[] = [];
  let upserted = 0;
  let idRows = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    idRows += await upsertItems(batch, stamp, dump);
    upserted += batch.length;
    batch = [];
  };

  // The progress line shows both the rate over the last interval (what the job
  // is doing now) and the cumulative average (which a slow first minute drags
  // down for hours, so on its own it looks like the job keeps speeding up).
  // With a file on disk, its size and the compressed bytes read so far also
  // give the fraction done and an ETA from the compressed rate over the last
  // interval (inflated bytes can't be compared to the size on disk).
  let last = { bytes: 0, seconds: 0, read: 0 };
  const mbps = (bytes: number, seconds: number): string =>
    seconds > 0 ? (bytes / 1e6 / seconds).toFixed(0) : "?";

  const scan = await scanDump(source, {
    classQids,
    limit: opts.limit,
    progressEveryBytes: opts.progressEveryBytes,
    onItem: async (item) => {
      batch.push(item);
      if (batch.length >= ITEM_BATCH) await flush();
    },
    onProperty: (entity) => {
      const row = propertyRowFromEntity(entity);
      if (row) propertyRows.push(row);
    },
    onProgress: (s) => {
      const now = mbps(s.bytes - last.bytes, s.seconds - last.seconds);
      const read = file?.read() ?? 0;
      let pct = "";
      let eta = "";
      if (file && file.size > 0) {
        pct = `[${((100 * read) / file.size).toFixed(1)}%] `;
        const rate = (read - last.read) / (s.seconds - last.seconds); // compressed B/s
        eta = `ETA ${rate > 0 ? formatDuration((file.size - read) / rate) : "?"}, `;
      }
      last = { bytes: s.bytes, seconds: s.seconds, read };
      log(
        `${tag} ${pct}${(s.bytes / 1e9).toFixed(0)} GB inflated, ${s.lines} lines, ` +
          `${s.matched} matched, ${s.properties} properties, ` +
          `${now} MB/s now (${mbps(s.bytes, s.seconds)} avg), ${eta}` +
          `rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`,
      );
    },
  });
  await flush();

  const propertyCount = await syncProperties(propertyRows);
  if (scan.stopped) {
    log(`${tag} stopped at limit ${opts.limit}; properties synced so far only`);
  }

  let pruned = 0;
  let settled = 0;
  if (!scan.stopped) {
    // Only a complete pass counts towards the dump's shard set.
    const set = await recordShardDone(dump, shard, scan.matched);
    if (prune) {
      if (!set.complete) {
        log(`${tag} done; the prune waits for the other shards of dump ${dump}`);
      } else if (set.matched === 0) {
        log(`${tag} matched nothing — not pruning (wrong file?)`);
      } else {
        [pruned, settled] = await pruneMissing(dump, { force: opts.forcePrune ?? false, log });
      }
    }
  }

  return { ...scan, upserted, externalIds: idRows, propertyRows: propertyCount, pruned, settled };
}
