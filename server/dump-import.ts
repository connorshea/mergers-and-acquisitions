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
//   2. Cheap pre-filter: one Buffer search for `"numeric-id":`, keeping the
//      lines where the number that follows is one of IMPORT_CLASSES, and one for
//      lines that start `{"type":"property"`. Everything else is never decoded
//      or parsed.
//   3. Hit lines are JSON.parsed, converted with the shared entityToItem, and
//      kept if a best-rank P31 really is one of the classes (a mention of a
//      class QID in any other statement is discarded here).
//   4. Items are upserted in batches; each changed item's external ids are
//      made to match the dump, deleting and inserting only the rows that
//      differ.
//      Property entities become `properties` rows via the existing sync path.
//   5. After a complete pass, items that were not in the dump any more (merged
//      away, deleted, retyped) are pruned and their open candidates settled.
//
// Everything is an idempotent upsert, so a job killed mid-way (a node drain,
// say) is simply re-run. One bad entity doesn't stop the pass: an unparseable
// line, or an item the database refuses (a batch that fails is retried item by
// item), is logged and skipped. Past `maxSkipped` of those the run aborts,
// since that many points at an outage or a bug rather than bad data.
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
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { constants as zlibConstants, createGunzip, inflateRawSync } from "node:zlib";
import { and, asc, count, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { refreshCandidateItemInfo } from "./candidate-item-info.ts";
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
  /** Pre-filter hits that couldn't be parsed or converted (see `onSkip`). */
  skipped: number;
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
  /**
   * Called for a hit line that fails to parse or convert, which is then
   * skipped; it may throw to abort the scan. Without it the error is thrown.
   */
  onSkip?: (what: string, err: unknown) => void;
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
 * `needle` at the start of the line. `region` must end with `\n`.
 */
function lineStartHits(region: Buffer, needle: Buffer, into: Map<number, number>): void {
  let from = 0;
  while (from < region.length) {
    const idx = region.indexOf(needle, from);
    if (idx === -1) break;
    const start = region.lastIndexOf(NL, idx) + 1;
    const end = region.indexOf(NL, idx);
    if (start === idx) into.set(start, end);
    from = end + 1;
  }
}

const NUMERIC_ID_NEEDLE = Buffer.from('"numeric-id":');

/**
 * Find the [start, end) byte ranges of the lines in `region` that mention an
 * entity whose numeric id is in `ids` (`"numeric-id":7889`, and not Q78890).
 * One search for the shared `"numeric-id":` prefix, reading the digits after
 * each hit, rather than a pass per class: a region is ~1 MB, and with a dozen
 * classes the per-class passes cost ~7x the single one. `region` must end with `\n`.
 */
function classHits(region: Buffer, ids: ReadonlySet<number>, into: Map<number, number>): void {
  let from = 0;
  while (from < region.length) {
    const idx = region.indexOf(NUMERIC_ID_NEEDLE, from);
    if (idx === -1) break;
    let at = idx + NUMERIC_ID_NEEDLE.length;
    let id = 0;
    // Wikidata ids stay far below 2^53, so the running number is exact.
    while (at < region.length && isDigit(region[at])) id = id * 10 + (region[at++] - 0x30);
    if (at === idx + NUMERIC_ID_NEEDLE.length || !ids.has(id)) {
      from = at;
      continue;
    }
    const start = region.lastIndexOf(NL, idx) + 1;
    const end = region.indexOf(NL, at);
    into.set(start, end);
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
  const classIds = new Set(opts.classQids.map((qid) => Number(qid.replace(/^Q/, ""))));
  const classSet = new Set(opts.classQids);
  const progressEvery = opts.progressEveryBytes ?? 5e9;
  const started = Date.now();
  const stats: ScanStats = {
    bytes: 0,
    lines: 0,
    parsed: 0,
    matched: 0,
    skipped: 0,
    properties: 0,
    stopped: false,
    seconds: 0,
  };
  let nextProgress = progressEvery;
  let carry: Buffer = Buffer.alloc(0);
  const hits = new Map<number, number>();

  const skip = (what: string, err: unknown): void => {
    if (!opts.onSkip) throw err;
    stats.skipped++;
    opts.onSkip(what, err);
  };

  const handleLine = async (line: Buffer): Promise<void> => {
    let entity: Entity | null;
    try {
      entity = parseLine(line);
    } catch (err) {
      skip(`unparseable line ${JSON.stringify(line.subarray(0, 80).toString("utf8"))}…`, err);
      return;
    }
    if (!entity) return;
    stats.parsed++;
    if (entity.type === "property") {
      stats.properties++;
      await opts.onProperty?.(entity);
      return;
    }
    if (entity.type !== "item") return;
    let item: Item;
    try {
      item = entityToItem(entity);
    } catch (err) {
      skip(`${entity.id} (unconvertible)`, err);
      return;
    }
    if (!isInstanceOfAny(item, classSet)) return;
    stats.matched++;
    await opts.onItem(item, entity);
  };

  const handleRegion = async (region: Buffer): Promise<boolean> => {
    // Count lines cheaply; most regions have no hit and are otherwise skipped.
    let nl = -1;
    while ((nl = region.indexOf(NL, nl + 1)) !== -1) stats.lines++;

    hits.clear();
    classHits(region, classIds, hits);
    if (opts.onProperty) lineStartHits(region, PROPERTY_NEEDLE, hits);
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
/**
 * `external_ids.value` is varchar(512). Longer values are junk (e.g. prose
 * pasted into an identifier property) that no identifier match would use, so
 * they're skipped instead of failing the whole batch with ER_DATA_TOO_LONG.
 * UTF-16 length is never under MariaDB's code-point count, so nothing too long
 * gets through (a rare astral-heavy value near the cap is dropped early).
 */
const MAX_ID_VALUE_CHARS = 512;
/** Default cap on skipped entities (bad lines + unwritable items) per run. */
export const MAX_SKIPPED = 100;
/** Items paged per read when pruning (keyset over the PK). */
const READ_PAGE = 10000;
/**
 * Refuse to prune more than this fraction of the mirror in one run unless
 * forced: a truncated or wrong dump would otherwise empty the database.
 */
export const MAX_PRUNE_FRACTION = 0.2;

/** Recursively sort object keys so equal values serialize identically, whatever order they were built in. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * SHA-1 (hex) of everything upsertItems stores for an item: its denormalized
 * columns, its data, and the external-id rows it keeps. Hashing the converted
 * output rather than using the entity's revision id means a change to the
 * adapter (entityToItem, externalIdRows) also counts as a change.
 */
export function itemHash(
  label: string | null,
  type: string | null,
  item: Item,
  ids: readonly { property: string; value: string }[],
): string {
  const ordered = [label, type, item, ids.map((r) => [r.property, r.value])];
  return createHash("sha1")
    .update(JSON.stringify(canonical(ordered)))
    .digest("hex");
}

/** Plain code-unit order, close to the `utf8mb4_bin` order the indexes use. */
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What upsertItems did with a batch. */
export interface UpsertResult {
  /** Items written in full (new, changed, or without a stored hash). */
  written: number;
  /** Items whose stored hash matched, only restamped. */
  unchanged: number;
  /** External-id rows written for the written items. */
  externalIds: number;
}

/**
 * Upsert items and rebuild their external ids — the one write path shared by
 * the dump import and the single-item importer, so both store the same shape.
 * An item whose hash (see `itemHash`) matches the stored one is only
 * restamped: rewriting its JSON and deleting and re-inserting its external
 * ids would store exactly what is already there, and most items don't change
 * from one weekly dump to the next.
 * `dump` stamps the rows as seen in that dump; without it (the single-item
 * importer) an existing row keeps its stamp.
 */
export async function upsertItems(
  batch: Item[],
  stamp = toSqlDatetime(new Date()),
  dump?: string,
): Promise<UpsertResult> {
  if (batch.length === 0) return { written: 0, unchanged: 0, externalIds: 0 };
  // Each item's row and external ids (deduped on the (qid, property, value)
  // key), and the hash of the two.
  const prepared = batch.map((item) => {
    const label = primaryLabel(item) ?? null;
    const type = primaryType(item) ?? null;
    const ids: (typeof externalIds.$inferInsert)[] = [];
    const seen = new Set<string>();
    for (const r of externalIdRows(item)) {
      if (r.value.length > MAX_ID_VALUE_CHARS) continue;
      const key = `${r.property} ${r.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ids.push({ qid: item.id, property: r.property, value: r.value });
    }
    const row = {
      qid: item.id,
      primaryLabel: label,
      primaryType: type,
      data: item,
      lastSyncedAt: stamp,
      lastDump: dump ?? null,
      dataHash: itemHash(label, type, item, ids),
    };
    return { row, ids };
  });

  // One transaction, so a batch that fails leaves every item as it was (not,
  // say, updated with its external ids already deleted) and can be retried.
  // READ COMMITTED drops the gap locks REPEATABLE READ takes on the external-id
  // index ranges, and keeps the reads below lock-free.
  return db.transaction(
    async (tx) => {
      const stored = new Map(
        (
          await tx
            .select({ qid: items.qid, dataHash: items.dataHash })
            .from(items)
            .where(
              inArray(
                items.qid,
                prepared.map((p) => p.row.qid),
              ),
            )
        ).map((r) => [r.qid, r.dataHash]),
      );
      const changed = prepared.filter((p) => stored.get(p.row.qid) !== p.row.dataHash);
      const unchanged = prepared
        .filter((p) => stored.get(p.row.qid) === p.row.dataHash)
        .map((p) => p.row.qid);

      if (unchanged.length > 0) {
        await tx
          .update(items)
          .set({ lastSyncedAt: stamp, ...(dump ? { lastDump: dump } : {}) })
          .where(inArray(items.qid, unchanged));
      }
      if (changed.length === 0) return { written: 0, unchanged: unchanged.length, externalIds: 0 };

      // Written in key order so concurrent shards take their locks in the same
      // order.
      changed.sort((a, b) => compareKeys(a.row.qid, b.row.qid));
      const rows = changed.map((p) => p.row);
      for (let i = 0; i < rows.length; i += ITEM_BATCH) {
        await tx
          .insert(items)
          .values(rows.slice(i, i + ITEM_BATCH))
          .onDuplicateKeyUpdate({
            set: {
              primaryLabel: sql`values(${items.primaryLabel})`,
              primaryType: sql`values(${items.primaryType})`,
              data: sql`values(${items.data})`,
              lastSyncedAt: sql`values(${items.lastSyncedAt})`,
              lastDump: sql`coalesce(values(${items.lastDump}), ${items.lastDump})`,
              dataHash: sql`values(${items.dataHash})`,
            },
          });
      }

      // Bring the changed items' external ids in line with the dump, touching
      // only the rows that differ: most items' ids are the same from one dump
      // to the next, and deleting and re-inserting all of them is what
      // concurrent shards deadlocked on. The read takes no locks under READ
      // COMMITTED and is answered from idx_external_ids_unique alone.
      const idRows = changed.flatMap((p) => p.ids);
      const idKey = (r: { qid: string; property: string; value: string }) =>
        `${r.qid}\t${r.property}\t${r.value}`;
      const wanted = new Set(idRows.map(idKey));
      const stale: number[] = [];
      const present = new Set<string>();
      for (const r of await tx
        .select({
          id: externalIds.id,
          qid: externalIds.qid,
          property: externalIds.property,
          value: externalIds.value,
        })
        .from(externalIds)
        .where(
          inArray(
            externalIds.qid,
            rows.map((r) => r.qid),
          ),
        )) {
        if (wanted.has(idKey(r))) present.add(idKey(r));
        else stale.push(r.id);
      }
      stale.sort((a, b) => a - b);
      for (let i = 0; i < stale.length; i += ID_BATCH) {
        await tx.delete(externalIds).where(inArray(externalIds.id, stale.slice(i, i + ID_BATCH)));
      }
      const added = idRows
        .filter((r) => !present.has(idKey(r)))
        .sort((a, b) => compareKeys(idKey(a), idKey(b)));
      for (let i = 0; i < added.length; i += ID_BATCH) {
        await tx.insert(externalIds).values(added.slice(i, i + ID_BATCH));
      }
      return { written: changed.length, unchanged: unchanged.length, externalIds: idRows.length };
    },
    { isolationLevel: "read committed" },
  );
}

/** Driver error codes for losing a lock race: the transaction was rolled back and can simply be re-run. */
const LOCK_CONFLICT_CODES = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);
/** Re-runs of a batch that lost a lock race before it falls back to one item at a time. */
const LOCK_RETRIES = 3;

/** True when `err` (or an error it wraps, e.g. a DrizzleQueryError) is a deadlock or lock-wait timeout. */
export function isLockConflict(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (LOCK_CONFLICT_CODES.has((e as { code?: string }).code ?? "")) return true;
  }
  return false;
}

/**
 * Run `write`, re-running it up to LOCK_RETRIES times when it loses a lock race
 * with another shard (with a short, jittered backoff so the two don't collide
 * again). Any other error, or a conflict past the retries, is thrown.
 */
async function withLockRetry<T>(
  write: () => Promise<T>,
  onRetry: (attempt: number, err: unknown) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (attempt > LOCK_RETRIES || !isLockConflict(err)) throw err;
      onRetry(attempt, err);
      await new Promise((r) => setTimeout(r, 100 * 2 ** attempt * (0.5 + Math.random())));
    }
  }
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
  /** Abort once more than this many entities were skipped (MAX_SKIPPED). */
  maxSkipped?: number;
  log?: (message: string) => void;
  progressEveryBytes?: number;
}

export interface ImportStats extends ScanStats {
  /** Items upserted (written in full, or restamped as unchanged). */
  upserted: number;
  /** Of those, items whose stored hash matched, so only their dump stamp was updated. */
  unchanged: number;
  /** External-id rows written. */
  externalIds: number;
  /** Matched items the database refused, skipped (their QIDs are logged). */
  failed: number;
  /** Writes re-run after losing a lock race (deadlock or lock-wait timeout) with another shard. */
  lockRetries: number;
  /** Seconds the scan sat waiting for the previous batch's write to finish. */
  writeWaitSeconds: number;
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
 * Stamp items that failed to write as seen in `dump` anyway, so the prune
 * keeps their existing (previous-dump) rows instead of deleting items that are
 * still in the dump. A refused item that isn't in the mirror yet stays absent.
 */
async function keepSeen(qids: string[], dump: string): Promise<void> {
  if (qids.length === 0) return;
  await db.update(items).set({ lastDump: dump }).where(inArray(items.qid, qids));
}

/**
 * A one-line reason for the log. A DrizzleQueryError's own message embeds the
 * whole statement and its parameters (thousands of placeholders), so prefer
 * the driver error it wraps.
 */
function errorSummary(err: unknown): string {
  const e = (err instanceof Error && err.cause instanceof Error ? err.cause : err) as {
    code?: string;
    message?: string;
  };
  const text = `${e.code ? `${e.code}: ` : ""}${e.message ?? String(err)}`;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
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
  let unchanged = 0;
  let idRows = 0;

  let failed = 0;
  let skipped = 0;
  const maxSkipped = opts.maxSkipped ?? MAX_SKIPPED;
  // Shared by the scan (bad lines) and the write path (refused items).
  const onSkip = (what: string, err: unknown): void => {
    log(`${tag} skipped ${what}: ${errorSummary(err)}`);
    if (++skipped > maxSkipped) {
      throw new Error(`${tag} more than ${maxSkipped} entities skipped; aborting`, { cause: err });
    }
  };

  let lockRetries = 0;
  const upsert = (pending: Item[]): Promise<UpsertResult> =>
    withLockRetry(
      () => upsertItems(pending, stamp, dump),
      (attempt, err) => {
        lockRetries++;
        log(
          `${tag} ${pending.length === 1 ? pending[0].id : `batch of ${pending.length}`} lost a lock race ` +
            `(${errorSummary(err)}); retry ${attempt}/${LOCK_RETRIES}`,
        );
      },
    );

  const tally = (r: UpsertResult): void => {
    idRows += r.externalIds;
    upserted += r.written + r.unchanged;
    unchanged += r.unchanged;
  };

  let writing: Promise<void> = Promise.resolve();
  // Time the scan spends blocked on the previous batch's write: when this is a
  // large share of the run, the database (not the inflate) sets the pace.
  let writeWaitMs = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const pending = batch;
    batch = [];
    try {
      tally(await upsert(pending));
      return;
    } catch (err) {
      // Find the item(s) at fault; the rest of the batch still lands.
      log(`${tag} batch of ${pending.length} failed (${errorSummary(err)}); retrying one by one`);
    }
    const refused: string[] = [];
    for (const item of pending) {
      try {
        tally(await upsert([item]));
      } catch (err) {
        failed++;
        refused.push(item.id);
        onSkip(item.id, err);
      }
    }
    await keepSeen(refused, dump);
  };

  // The progress line shows both the rate over the last interval (what the job
  // is doing now) and the cumulative average (which a slow first minute drags
  // down for hours, so on its own it looks like the job keeps speeding up).
  // With a file on disk, its size and the compressed bytes read so far also
  // give the fraction done and an ETA from the compressed rate over the last
  // interval (inflated bytes can't be compared to the size on disk).
  let last = { bytes: 0, seconds: 0, read: 0, writeWaitMs: 0 };
  const mbps = (bytes: number, seconds: number): string =>
    seconds > 0 ? (bytes / 1e6 / seconds).toFixed(0) : "?";

  const scan = await scanDump(source, {
    classQids,
    limit: opts.limit,
    progressEveryBytes: opts.progressEveryBytes,
    onSkip,
    onItem: async (item) => {
      batch.push(item);
      if (batch.length < ITEM_BATCH) return;
      // Write this batch while the scan inflates the next one: wait only for
      // the previous write, so one batch is in flight at a time and the scan
      // never waits on a database round-trip it could have overlapped.
      const waitStart = performance.now();
      await writing;
      writeWaitMs += performance.now() - waitStart;
      writing = flush();
      // Handled when awaited above or after the scan; this just stops Node
      // treating a failure in between as an unhandled rejection.
      writing.catch(() => {});
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
      const interval = s.seconds - last.seconds;
      const waited = (writeWaitMs - last.writeWaitMs) / 1000;
      const waitPct = interval > 0 ? `${Math.round((100 * waited) / interval)}%` : "?";
      last = { bytes: s.bytes, seconds: s.seconds, read, writeWaitMs };
      log(
        `${tag} ${pct}${(s.bytes / 1e9).toFixed(0)} GB inflated, ${s.lines} lines, ` +
          `${s.matched} matched (${unchanged} unchanged), ${s.properties} properties, ` +
          `${now} MB/s now (${mbps(s.bytes, s.seconds)} avg), ${eta}` +
          `write wait ${waited.toFixed(0)}s (${waitPct}), ` +
          `rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`,
      );
    },
  });
  await writing;
  await flush();

  const propertyCount = await syncProperties(propertyRows);
  // Items this pass relabelled or retyped: bring the candidates' copies in line.
  const refreshed = await refreshCandidateItemInfo(db);
  log(`${tag} refreshed item type/label on ${refreshed} candidate rows`);
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

  return {
    ...scan,
    upserted,
    unchanged,
    externalIds: idRows,
    failed,
    lockRetries,
    writeWaitSeconds: writeWaitMs / 1000,
    propertyRows: propertyCount,
    pruned,
    settled,
  };
}
