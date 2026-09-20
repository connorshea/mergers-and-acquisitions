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
//   2. Cheap pre-filter: a Buffer search for `"numeric-id":7889` (video game,
//      followed by a non-digit) and for lines that start `{"type":"property"`.
//      Everything else — ~99.7% of the bytes — is never decoded or parsed.
//   3. Hit lines are JSON.parsed, converted with the shared entityToItem, and
//      kept if a best-rank P31 really is the class (a mention of Q7889 in any
//      other statement is discarded here).
//   4. Items are upserted in batches; each item's external ids are rebuilt
//      wholesale (the schema's "rebuilt for an item on each sync" contract).
//      Property entities become `properties` rows via the existing sync path.
//   5. After a complete pass, items that were not in the dump any more (merged
//      away, deleted, retyped) are pruned and their open candidates settled.
//
// Everything is an idempotent upsert, so a job killed mid-way (a node drain,
// say) is simply re-run.
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { externalIds, items, mergeCandidates } from "../db/schema.ts";
import { syncProperties } from "./properties-sync.ts";
import { toSqlDatetime } from "./auth/time.ts";
import type { Item } from "../src/lib/compare.ts";
import type { PropertyRow } from "../src/lib/sparql.ts";
import { externalIdRows, primaryLabel, primaryType } from "../src/lib/wikidata.ts";
import {
  type Entity,
  entityToItem,
  isInstanceOf,
  propertyRowFromEntity,
} from "../src/lib/wikibase.ts";

/** "video game" — the class whose instances the mirror holds. */
export const VIDEO_GAME = "Q7889";

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
  /** Class QID an item's best-rank P31 must include (VIDEO_GAME). */
  classQid: string;
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
  if (path.endsWith(".bz2")) {
    throw new Error(`${path}: use the .gz dump (bzip2 is ~10x slower to inflate)`);
  }
  const file = createReadStream(path, { highWaterMark: CHUNK_SIZE });
  if (!path.endsWith(".gz")) return file;
  const gunzip = createGunzip({ chunkSize: CHUNK_SIZE });
  // pipe() does not forward errors; a vanished NFS file must fail the job.
  file.on("error", (err) => gunzip.destroy(err));
  return file.pipe(gunzip);
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
 * Stream a Wikidata entity JSON dump and hand every item of `classQid` (and
 * every property entity) to the callbacks. Resolves with the scan statistics.
 */
export async function scanDump(source: Readable, opts: ScanOptions): Promise<ScanStats> {
  const classNeedle = Buffer.from(`"numeric-id":${opts.classQid.replace(/^Q/, "")}`);
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
    if (!isInstanceOf(item, opts.classQid)) return;
    stats.matched++;
    await opts.onItem(item, entity);
  };

  const handleRegion = async (region: Buffer): Promise<boolean> => {
    // Count lines cheaply; most regions have no hit and are otherwise skipped.
    let nl = -1;
    while ((nl = region.indexOf(NL, nl + 1)) !== -1) stats.lines++;

    hits.clear();
    hitLines(region, classNeedle, { wordBoundary: true }, hits);
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
 * Returns the number of external-id rows written.
 */
export async function upsertItems(
  batch: Item[],
  stamp = toSqlDatetime(new Date()),
): Promise<number> {
  if (batch.length === 0) return 0;
  const rows = batch.map((item) => ({
    qid: item.id,
    primaryLabel: primaryLabel(item) ?? null,
    primaryType: primaryType(item) ?? null,
    data: item,
    lastSyncedAt: stamp,
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
  /** An already-open stream of inflated dump bytes (tests). */
  source?: Readable;
  classQid?: string;
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
 * Delete every item not in `keep`, with its external ids, and settle the open
 * candidates that referenced it. Returns [items, candidates].
 */
async function pruneMissing(
  keep: Set<string>,
  opts: { force: boolean; log: (m: string) => void },
): Promise<[number, number]> {
  const gone: string[] = [];
  let total = 0;
  let after = "";
  for (;;) {
    const page = await db
      .select({ qid: items.qid })
      .from(items)
      .where(after ? gt(items.qid, after) : sql`1 = 1`)
      .orderBy(asc(items.qid))
      .limit(READ_PAGE);
    if (page.length === 0) break;
    total += page.length;
    for (const r of page) if (!keep.has(r.qid)) gone.push(r.qid);
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
  const classQid = opts.classQid ?? VIDEO_GAME;
  const source = opts.source ?? openDump(opts.path ?? DEFAULT_DUMP_PATH);
  const prune = opts.prune ?? opts.limit === undefined;
  const stamp = toSqlDatetime(new Date());

  const seen = new Set<string>();
  const propertyRows: PropertyRow[] = [];
  let batch: Item[] = [];
  let upserted = 0;
  let idRows = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    idRows += await upsertItems(batch, stamp);
    upserted += batch.length;
    batch = [];
  };

  const scan = await scanDump(source, {
    classQid,
    limit: opts.limit,
    progressEveryBytes: opts.progressEveryBytes,
    onItem: async (item) => {
      seen.add(item.id);
      batch.push(item);
      if (batch.length >= ITEM_BATCH) await flush();
    },
    onProperty: (entity) => {
      const row = propertyRowFromEntity(entity);
      if (row) propertyRows.push(row);
    },
    onProgress: (s) =>
      log(
        `import-dump: ${(s.bytes / 1e9).toFixed(0)} GB inflated, ${s.lines} lines, ` +
          `${s.matched} matched, ${s.properties} properties, ${(s.bytes / 1e6 / s.seconds).toFixed(0)} MB/s, ` +
          `rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`,
      ),
  });
  await flush();

  const propertyCount = await syncProperties(propertyRows);
  if (scan.stopped) {
    log(`import-dump: stopped at limit ${opts.limit}; properties synced so far only`);
  }

  let pruned = 0;
  let settled = 0;
  if (prune && !scan.stopped) {
    if (scan.matched === 0) {
      log("import-dump: matched nothing — not pruning (wrong file?)");
    } else {
      [pruned, settled] = await pruneMissing(seen, { force: opts.forcePrune ?? false, log });
    }
  }

  return { ...scan, upserted, externalIds: idRows, propertyRows: propertyCount, pruned, settled };
}
