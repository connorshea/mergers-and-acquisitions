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
//      or parsed. A selective class (SELECTIVE_IMPORT_CLASSES: humans) only
//      counts for a line whose own QID a mirrored item links to (read from
//      the mirror before the pass, loadLinkedQids), or that names one of the
//      class's occupations or id properties, so the ~13M humans outside video
//      games are passed over like any other line.
//   3. A hit line for an item the mirror already holds at the same revision,
//      converted by the current converter (`item_sync.source_revid` and
//      `converter_version`, loaded up front into a compact index), is not
//      parsed at all: its QID and `"lastrevid"` are read from the raw bytes and
//      the row is only restamped as seen. Most items aren't edited in a week.
//      Other hit lines are JSON.parsed, converted with the shared entityToItem, and
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
// The pass is split across several jobs. The dump's .gz is not one stream:
// the generator (operations/dumps, dumpwikibasejson.sh) gzips each 65k-entity
// batch on its own and `cat`s them together with tiny `[`, `,` and `]` members
// between, ~2,000 independent members that each start on a line boundary.
// Slice i of N is the N-th of the compressed bytes starting at the first
// member header at or past i*size/N and ending at the first one at or past
// (i+1)*size/N, so the N slices read every byte exactly once and no index pass
// is needed.
//
// The jobs are identical workers (`worker`) sharing a queue of K such slices
// ("segments", DEFAULT_SEGMENTS) in `dump_import_segments`: each claims the
// lowest free segment (SELECT … FOR UPDATE SKIP LOCKED), scans it, marks it
// done, and claims the next, so a fast worker takes on more of the file
// instead of sitting idle while a slow one finishes a fixed share. A claim is
// kept alive by a heartbeat; one gone stale (its worker died), or held under
// the worker's own name (a retry of the same job), is taken over, so a retry
// redoes one segment rather than a share of the dump. A worker with nothing
// left to claim waits for the others' segments to finish, to take over any
// that go stale. Items are stamped with the dump they were seen in, and the
// worker that marks the set's last segment done prunes the rows the dump no
// longer contains. `--shard i/N` (one fixed slice per job, recorded as segment
// i of an N-segment set) remains for local and one-off runs.
import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { constants as zlibConstants, crc32, createGunzip, inflateRawSync } from "node:zlib";
import { and, asc, count, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { refreshCandidateItemInfo } from "./candidate-item-info.ts";
import {
  dumpImportLinked,
  dumpImportSegments,
  externalIds,
  itemSync,
  items,
  mergeCandidates,
} from "../db/schema.ts";
import type { Connection as CoreConnection } from "mysql2";
import type { RowDataPacket } from "mysql2/promise";
import { syncProperties } from "./properties-sync.ts";
import { CONVERTER_VERSION } from "./converter-version.ts";
import { toSqlDatetime } from "./auth/time.ts";
import { STALE_CLAIM_SECONDS } from "./import-claims.ts";
import { storedBlockingKey, type Item } from "../src/lib/compare.ts";
import type { PropertyRow } from "../src/lib/sparql.ts";
import { externalIdRows, primaryLabel, primaryType } from "../src/lib/wikidata.ts";
import {
  type Entity,
  entityToItem,
  isInstanceOfAny,
  propertyRowFromEntity,
} from "../src/lib/wikibase.ts";
import {
  IMPORT_CLASSES,
  SELECTIVE_IMPORT_CLASSES,
  type SelectiveImport,
  type SelectiveImportClass,
} from "../src/lib/import-classes.ts";

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
  /** Items whose best-rank P31 is the class (`unedited` included). */
  matched: number;
  /**
   * Matched items skipped without parsing: the mirror already holds them at
   * this revision, converted by the current converter (see `isUnedited`).
   */
  unedited: number;
  /** Pre-filter hits that couldn't be parsed or converted (see `onSkip`). */
  skipped: number;
  /** Property entities handed to onProperty. */
  properties: number;
  /** True when the scan stopped at `limit` rather than at the end of the dump. */
  stopped: boolean;
  /** Wall-clock seconds so far. */
  seconds: number;
}

/** Classes of which only some instances are imported (see SELECTIVE_IMPORT_CLASSES). */
export interface SelectiveScan {
  classes: readonly (Pick<SelectiveImport, "occupations" | "idProperties"> & { qid: string })[];
  /** Numeric ids of the items mirrored items link to (loadLinkedQids). */
  linkedQids: ReadonlySet<number>;
}

export interface ScanOptions {
  /** Class QIDs an item's best-rank P31 must include one of (IMPORT_CLASSES). */
  classQids: readonly string[];
  /**
   * Classes of which only some instances are imported: those linked from the
   * mirror (`linkedQids`), with one of the class's occupations, or with one of
   * its id properties. A line naming such a class (and none of `classQids`)
   * is only a hit when the raw line already shows one of those, so the other
   * ~13M humans are never parsed.
   */
  selective?: SelectiveScan;
  /** Called with every matching item, in dump order, awaited (backpressure). */
  onItem: (item: Item, entity: Entity) => void | Promise<void>;
  /**
   * Checked for every pre-filter hit that names an item and its revision,
   * before the line is parsed: true when the mirror already holds that item at
   * that revision, converted by the current converter. Such a line is counted
   * as matched and handed to `onUnedited` instead of being parsed.
   */
  isUnedited?: (qid: number, revid: number) => boolean;
  /** Called with the QID of every item `isUnedited` skipped, awaited. */
  onUnedited?: (qid: string) => void | Promise<void>;
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

/** Inflated bytes a probe that hasn't reached its member's end must yield to be judged. */
const PROBE_MIN_TEXT = 256;

/**
 * True when `out` reads like dump text: JSON lines, so no control byte but the
 * newline (the JSON escapes every other one). Inflated random bytes are ~12%
 * control bytes, so a few hundred of them never pass.
 */
function isDumpText(out: Buffer): boolean {
  if (out.length < PROBE_MIN_TEXT) return false;
  for (const byte of out) if (byte < 0x20 && byte !== 0x0a) return false;
  return true;
}

/**
 * True when a gzip member really starts at `offset`: a valid header, then
 * deflate bytes that either end the member within the probe with a trailer
 * whose CRC-32 and length match what they inflated to (the tiny `[` / `,`
 * members), or inflate to dump text. A chance `1f 8b 08` inside a member is
 * followed by pseudo-random bytes, which mostly fail to inflate at all — but
 * ~0.6% of the time they decode as a final block that ends at once, which
 * inflates without error, so success alone is not enough: that false boundary
 * cut a segment mid-member ("unexpected end of file").
 */
function isMemberStart(fd: number, offset: number): boolean {
  const buf = Buffer.alloc(PROBE_BYTES + 1024);
  const n = readSync(fd, buf, 0, buf.length, offset);
  const header = gzipHeaderLength(buf.subarray(0, n));
  if (header === -1) return false;
  let out: Buffer;
  let used: number;
  try {
    // A truncated valid stream inflates to a prefix, so the probe needn't hold a whole member.
    // `info: true` (untyped in @types/node) also returns the engine, whose
    // bytesWritten is the deflate input consumed: less than given when the stream ended.
    const { buffer, engine } = inflateRawSync(buf.subarray(header, n), {
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    out = buffer;
    used = engine.bytesWritten;
  } catch {
    return false;
  }
  if (used >= n - header) return isDumpText(out);
  // The deflate stream ended inside the probe: check the 8-byte trailer after it.
  const trailer = Buffer.alloc(8);
  if (readSync(fd, trailer, 0, 8, offset + header + used) < 8) return false;
  return trailer.readUInt32LE(0) === crc32(out) && trailer.readUInt32LE(4) === out.length >>> 0;
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

function refuseBz2(path: string): void {
  if (path.endsWith(".bz2")) {
    throw new Error(`${path}: use the .gz dump (bzip2 is ~10x slower to inflate)`);
  }
}

export function openDumpFile(path: string, shard: DumpShard = WHOLE_DUMP): DumpFile {
  refuseBz2(path);
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
 * classes the per-class passes cost ~7x the single one. Any other id is put
 * to `other(id, lineStart, at)` (the selective classes); on false the search
 * carries on along the line. `region` must end with `\n`.
 */
function classHits(
  region: Buffer,
  ids: ReadonlySet<number>,
  into: Map<number, number>,
  other?: (id: number, start: number, at: number) => boolean,
): void {
  let from = 0;
  // The line holding the current hit, found once per line: a big item's line
  // has hundreds of `"numeric-id":` mentions, and searching back to its start
  // from each one made the scan quadratic in the line's length.
  let start = 0;
  let end = -1;
  while (from < region.length) {
    const idx = region.indexOf(NUMERIC_ID_NEEDLE, from);
    if (idx === -1) break;
    let at = idx + NUMERIC_ID_NEEDLE.length;
    let id = 0;
    // Wikidata ids stay far below 2^53, so the running number is exact.
    while (at < region.length && isDigit(region[at])) id = id * 10 + (region[at++] - 0x30);
    if (at === idx + NUMERIC_ID_NEEDLE.length) {
      from = at;
      continue;
    }
    if (idx > end) {
      start = region.lastIndexOf(NL, idx) + 1;
      end = region.indexOf(NL, at);
    }
    if (!ids.has(id) && !other?.(id, start, at)) {
      from = at;
      continue;
    }
    into.set(start, end);
    from = end + 1;
  }
}

const ITEM_ID_NEEDLE = Buffer.from('"id":"Q');
const LASTREVID_NEEDLE = Buffer.from('"lastrevid":');
/** How far into a line the top-level `"id"` may start (it follows `"type"`). */
const ID_WINDOW = 256;

/**
 * The item's numeric id and revision, read from a raw dump line without
 * parsing it: `{"type":"item","id":"Q42",…,"lastrevid":123,…}`. Null when the
 * line isn't an item or either value can't be found, which just means the line
 * is parsed as usual. Neither key can be matched inside a string value, where
 * the quotes around it would be escaped. The top-level id is the first
 * `"id":"Q` on the line whether it comes right after `"type"` (the dump's order)
 * or after the page fields (Special:EntityData's), since both precede the
 * claims. `"lastrevid"` is a top-level key no nested object has, so there is
 * only one; it sits near the end of a dump line, where lastIndexOf finds it
 * quickly.
 */
export function lineRevision(line: Buffer): { qid: number; revid: number } | null {
  const qid = lineItemId(line);
  if (qid === null) return null;

  const revAt = line.lastIndexOf(LASTREVID_NEEDLE);
  if (revAt === -1) return null;
  let at = revAt + LASTREVID_NEEDLE.length;
  let revid = 0;
  while (at < line.length && isDigit(line[at])) revid = revid * 10 + (line[at++] - 0x30);
  if (at === revAt + LASTREVID_NEEDLE.length) return null;
  return { qid, revid };
}

/**
 * The item's numeric id, read from the start of a raw dump line (see
 * lineRevision); null when the line isn't an item. Only the first ID_WINDOW
 * bytes are read, so `line` may be cut short after them.
 */
export function lineItemId(line: Buffer): number | null {
  const idAt = line.subarray(0, ID_WINDOW).indexOf(ITEM_ID_NEEDLE);
  if (idAt === -1) return null;
  let at = idAt + ITEM_ID_NEEDLE.length;
  let qid = 0;
  while (at < line.length && isDigit(line[at])) qid = qid * 10 + (line[at++] - 0x30);
  if (at === idAt + ITEM_ID_NEEDLE.length || line[at] !== 0x22) return null;
  return qid;
}

const PROPERTY_ID_NEEDLE = Buffer.from('"P');

/**
 * Whether `line` mentions one of `properties` (numeric ids) as a quoted
 * `"P<id>"`, as a claim key or a snak's `property` does. One pass over the
 * line whatever the number of properties, where a needle per property would
 * scan it once each. A mention in a string value matches too, which the
 * parsed-item check then turns down.
 */
function mentionsProperty(line: Buffer, properties: ReadonlySet<number>): boolean {
  let at = line.indexOf(PROPERTY_ID_NEEDLE);
  while (at !== -1) {
    let end = at + PROPERTY_ID_NEEDLE.length;
    let pid = 0;
    while (end < line.length && isDigit(line[end])) pid = pid * 10 + (line[end++] - 0x30);
    if (end > at + PROPERTY_ID_NEEDLE.length && line[end] === 0x22 && properties.has(pid)) {
      return true;
    }
    at = line.indexOf(PROPERTY_ID_NEEDLE, end);
  }
  return false;
}

/**
 * The selective classes' two checks: `line`, on the raw bytes, for the
 * pre-filter (a mention of `"numeric-id":<id>` at `at` on the line starting
 * at `start`), and `item`, on the parsed item, for the verdict. `line` may let
 * through a line `item` turns down (an occupation mentioned outside P106, an
 * id property only as a qualifier), never the reverse.
 */
function selectiveMatcher(scan: SelectiveScan) {
  const numeric = (id: string) => Number(id.slice(1)); // Q5 → 5, P8286 → 8286
  const byClass = new Map(
    scan.classes.map((c) => [numeric(c.qid), new Set(c.idProperties.map(numeric))]),
  );
  const occupations = new Set(scan.classes.flatMap((c) => c.occupations.map(numeric)));
  const classSets = scan.classes.map((c) => [c, new Set([c.qid])] as const);
  // A line can mention its class many times (Q5 in references, say): look at
  // each line once.
  let checked = -1;
  let checkedIn: Buffer | undefined;
  return {
    line(region: Buffer, id: number, start: number, at: number): boolean {
      if (occupations.has(id)) return true;
      const idProperties = byClass.get(id);
      if (!idProperties || (checkedIn === region && checked === start)) return false;
      checkedIn = region;
      checked = start;
      if (scan.linkedQids.has(lineItemId(region.subarray(start, at)) ?? -1)) return true;
      const end = region.indexOf(NL, at);
      const line = region.subarray(start, end);
      return mentionsProperty(line, idProperties);
    },
    item(item: Item): boolean {
      return classSets.some(
        ([c, set]) =>
          isInstanceOfAny(item, set) &&
          (scan.linkedQids.has(numeric(item.id)) ||
            (item.statements.P106 ?? []).some(
              (v) => v.type === "item" && c.occupations.includes(v.value),
            ) ||
            c.idProperties.some((p) => (item.statements[p]?.length ?? 0) > 0)),
      );
    },
  };
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
  const numeric = (qid: string) => Number(qid.replace(/^Q/, ""));
  const classIds = new Set(opts.classQids.map(numeric));
  const classSet = new Set(opts.classQids);
  const selective = opts.selective;
  const inSelective = selective && selectiveMatcher(selective);
  const progressEvery = opts.progressEveryBytes ?? 5e9;
  const started = Date.now();
  const stats: ScanStats = {
    bytes: 0,
    lines: 0,
    parsed: 0,
    matched: 0,
    unedited: 0,
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
    if (opts.isUnedited) {
      const rev = lineRevision(line);
      if (rev && opts.isUnedited(rev.qid, rev.revid)) {
        stats.matched++;
        stats.unedited++;
        await opts.onUnedited?.(`Q${rev.qid}`);
        return;
      }
    }
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
    if (!isInstanceOfAny(item, classSet) && !inSelective?.item(item)) return;
    stats.matched++;
    await opts.onItem(item, entity);
  };

  const handleRegion = async (region: Buffer): Promise<boolean> => {
    // Count lines cheaply; most regions have no hit and are otherwise skipped.
    let nl = -1;
    while ((nl = region.indexOf(NL, nl + 1)) !== -1) stats.lines++;

    hits.clear();
    classHits(
      region,
      classIds,
      hits,
      inSelective && ((id, s, at) => inSelective.line(region, id, s, at)),
    );
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
/** Unedited items restamped per statement (only their QIDs are sent). */
const RESTAMP_BATCH = 5000;
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

/** What upsertItems stores for an item, besides its bookkeeping columns. */
export interface PreparedRow {
  label: string | null;
  type: string | null;
  /** External-id rows, deduped on the (qid, property, value) key, over-long values dropped. */
  ids: { qid: string; property: string; value: string }[];
  /** `itemHash` of the above and the item. */
  dataHash: string;
}

/**
 * The denormalized columns, external-id rows, and hash upsertItems stores for
 * an item. Pure, so the converter-version test hashes exactly what is stored
 * (see server/converter-version.ts).
 */
export function prepareRow(item: Item): PreparedRow {
  const label = primaryLabel(item) ?? null;
  const type = primaryType(item) ?? null;
  const ids: PreparedRow["ids"] = [];
  const seen = new Set<string>();
  for (const r of externalIdRows(item)) {
    if (r.value.length > MAX_ID_VALUE_CHARS) continue;
    const key = `${r.property} ${r.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push({ qid: item.id, property: r.property, value: r.value });
  }
  return { label, type, ids, dataHash: itemHash(label, type, item, ids) };
}

/**
 * The items the mirror holds at a known revision, converted by the current
 * converter, as two parallel typed arrays sorted by numeric QID: ~12 bytes an
 * item, where a Map of the same would take ~50x that.
 */
export class RevisionIndex {
  private readonly qids: Uint32Array;
  private readonly revids: Float64Array;

  constructor(qids: Uint32Array, revids: Float64Array) {
    this.qids = qids;
    this.revids = revids;
  }

  get size(): number {
    return this.qids.length;
  }

  /** True when item Q`qid` is stored at revision `revid`. */
  has(qid: number, revid: number): boolean {
    let lo = 0;
    let hi = this.qids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const at = this.qids[mid];
      if (at === qid) return this.revids[mid] === revid;
      if (at < qid) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  /** Build from unsorted parallel lists (the load reads them in string order of QID). */
  static from(qids: ArrayLike<number>, revids: ArrayLike<number>): RevisionIndex {
    const order = Uint32Array.from({ length: qids.length }, (_, i) => i).sort(
      (a, b) => qids[a] - qids[b],
    );
    return new RevisionIndex(
      Uint32Array.from(order, (i) => qids[i]),
      Float64Array.from(order, (i) => revids[i]),
    );
  }
}

/**
 * The numeric ids of every item that a mirrored item of one of `sources`
 * names in an item-valued statement: the instances of the selective classes
 * this pass imports because they are linked. Read from the mirror before the pass, so an item that
 * starts being linked this week is imported with next week's dump. MariaDB
 * pulls the values out of `data` itself (JSON_TABLE), so only the distinct
 * QIDs cross the wire.
 */
export async function loadLinkedQids(sources: readonly string[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (sources.length === 0) return out;
  const [rows] = (await db.execute(sql`
    select distinct jt.qid from ${items} i,
      json_table(i.data, '$.statements.*[*]' columns (
        type varchar(16) path '$.type',
        qid varchar(32) path '$.value'
      )) jt
    where i.primary_type in (${sql.join(
      sources.map((q) => sql`${q}`),
      sql`, `,
    )})
      and jt.type = 'item'`)) as unknown as [{ qid: string }[]];
  for (const { qid } of rows) {
    if (/^Q\d+$/.test(qid)) out.add(Number(qid.slice(1)));
  }
  return out;
}

/** How long a worker waits for another to finish reading the set's linked QIDs. */
const LINKED_LOCK_WAIT_SECONDS = 900;

/**
 * loadLinkedQids, read once per worker pass and shared: the first worker of a
 * segment set to get here runs the query (about a minute on a full mirror)
 * under a named lock and stores the result in `dump_import_linked`; the rest
 * wait on the lock and read it back. The pass reads the mirror as it stood
 * before the pass either way, since no worker scans (or writes) until it has
 * the set. A redo of the set (resetFinishedSet) drops the stored one. A worker
 * that times out waiting on the lock reads the mirror itself.
 */
export async function sharedLinkedQids(
  dump: string,
  segments: number,
  sources: readonly string[],
): Promise<{ qids: Set<number>; shared: boolean }> {
  if (sources.length === 0) return { qids: new Set(), shared: false };
  const key = [...sources].sort().join(",");
  const linkedRow = and(eq(dumpImportLinked.dump, dump), eq(dumpImportLinked.segments, segments));
  // GET_LOCK belongs to the session that took it: hold one connection throughout.
  const conn = await pool.getConnection();
  const lock = `mna:linked:${dump}:${segments}`;
  try {
    const [[{ got }]] = await conn.query<({ got: number | null } & RowDataPacket)[]>(
      "select get_lock(?, ?) as got",
      [lock, LINKED_LOCK_WAIT_SECONDS],
    );
    if (got !== 1) return { qids: await loadLinkedQids(sources), shared: false };
    try {
      const [stored] = await db
        .select({ sources: dumpImportLinked.sources, qids: dumpImportLinked.qids })
        .from(dumpImportLinked)
        .where(linkedRow);
      if (stored?.sources === key) {
        const qids = new Set<number>();
        for (const id of stored.qids.split(",")) if (id) qids.add(Number(id));
        return { qids, shared: true };
      }
      const qids = await loadLinkedQids(sources);
      const row = { dump, segments, sources: key, qids: [...qids].sort((a, b) => a - b).join(",") };
      await db
        .insert(dumpImportLinked)
        .values(row)
        .onDuplicateKeyUpdate({
          set: { sources: row.sources, qids: row.qids, createdAt: sql`CURRENT_TIMESTAMP` },
        });
      // Earlier dumps' sets are done with theirs.
      await db.delete(dumpImportLinked).where(ne(dumpImportLinked.dump, dump));
      return { qids, shared: false };
    } finally {
      await conn.query("select release_lock(?)", [lock]);
    }
  } finally {
    conn.release();
  }
}

/**
 * Load the revision index for a dump pass: every item stored at a known
 * revision by the current converter whose primary type is still one of
 * `classQids`. The type check keeps a class dropped from IMPORT_CLASSES from
 * being carried forward: its items aren't in the index, so they are parsed,
 * found out of scope, and pruned. (primaryType is a best-rank P31 value, so a
 * row whose type is a class really is in scope at that revision.) An item left
 * out for any reason is only parsed as before, never skipped wrongly.
 *
 * One streamed read of idx_item_sync_revision, as arrays rather than row
 * objects. It holds every column the read needs, including item_sync's copy
 * of the type; joining `items` for it instead costs a primary-key lookup per
 * in-scope item, ~7x slower at ~3M items.
 */
export async function loadRevisionIndex(classQids: readonly string[]): Promise<RevisionIndex> {
  const qids: number[] = [];
  const revids: number[] = [];
  if (classQids.length === 0) return RevisionIndex.from(qids, revids);
  const conn = await pool.getConnection();
  // The callback-API connection under the promise wrapper, which alone can stream.
  const core = conn.connection as unknown as CoreConnection;
  const stream = core
    .query({
      sql: `select qid, source_revid from item_sync force index (idx_item_sync_revision)
            where converter_version = ? and primary_type in (?) and source_revid is not null`,
      values: [CONVERTER_VERSION, classQids],
      rowsAsArray: true,
    })
    .stream({ highWaterMark: 5000 });
  // A stream-mode query reports a dropped connection only on the connection
  // (see streamRows in server/hunt.ts); forward it, or the loop would wait on
  // rows that never come.
  const onError = (err: Error) => stream.destroy(err);
  core.on("error", onError);
  let ok = false;
  try {
    for await (const [qid, revid] of stream as AsyncIterable<[string, number | string]>) {
      qids.push(Number(qid.slice(1)));
      revids.push(Number(revid));
    }
    ok = true;
  } finally {
    core.off("error", onError);
    // A connection whose stream failed part-way isn't fit to go back in the pool.
    if (ok) conn.release();
    else conn.destroy();
  }
  return RevisionIndex.from(qids, revids);
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
 * `revids` gives the Wikidata revision each item was converted from, recorded
 * with the converter version so a later dump pass can skip the item unparsed
 * while it stays at that revision. An item without one is stored with no
 * revision, and is never skipped.
 */
export async function upsertItems(
  batch: Item[],
  stamp = toSqlDatetime(new Date()),
  dump?: string,
  revids?: ReadonlyMap<string, number>,
): Promise<UpsertResult> {
  if (batch.length === 0) return { written: 0, unchanged: 0, externalIds: 0 };
  const prepared = batch.map((item) => {
    const { label, type, ids, dataHash } = prepareRow(item);
    const row = {
      qid: item.id,
      primaryLabel: label,
      blockingKey: storedBlockingKey(label),
      primaryType: type,
      data: item,
    };
    const sync = {
      qid: item.id,
      lastSyncedAt: stamp,
      lastDump: dump ?? null,
      dataHash,
      sourceRevid: revids?.get(item.id) ?? null,
      converterVersion: CONVERTER_VERSION,
      primaryType: type,
    };
    return { row, sync, ids };
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
            .select({
              qid: itemSync.qid,
              dataHash: itemSync.dataHash,
              sourceRevid: itemSync.sourceRevid,
              converterVersion: itemSync.converterVersion,
            })
            .from(itemSync)
            .where(
              inArray(
                itemSync.qid,
                prepared.map((p) => p.row.qid),
              ),
            )
        ).map((r) => [r.qid, r]),
      );
      const isUnchanged = (p: (typeof prepared)[number]) =>
        stored.get(p.row.qid)?.dataHash === p.sync.dataHash;
      const changed = prepared.filter((p) => !isUnchanged(p));
      const unchanged = prepared.filter(isUnchanged).map((p) => p.row.qid);

      if (unchanged.length > 0) {
        await tx
          .update(itemSync)
          .set({ lastSyncedAt: stamp, ...(dump ? { lastDump: dump } : {}) })
          .where(inArray(itemSync.qid, unchanged));
      }
      // An unchanged item at a new revision (an edit the conversion drops, such
      // as a label in a language we don't keep), or first seen by this
      // converter version, stores exactly what this revision converts to now:
      // record the revision so the next pass can skip it unparsed. Its stored
      // primary_type needs no update: the hash covers the type, and every write
      // of a hash writes the type it was taken over.
      const revised = prepared.filter((p) => {
        if (!isUnchanged(p) || p.sync.sourceRevid === null) return false;
        const s = stored.get(p.row.qid)!;
        return s.sourceRevid !== p.sync.sourceRevid || s.converterVersion !== CONVERTER_VERSION;
      });
      if (revised.length > 0) {
        await tx
          .update(itemSync)
          .set({
            sourceRevid: sql`case ${itemSync.qid} ${sql.join(
              revised.map((p) => sql`when ${p.row.qid} then ${p.sync.sourceRevid}`),
              sql` `,
            )} end`,
            converterVersion: CONVERTER_VERSION,
          })
          .where(
            inArray(
              itemSync.qid,
              revised.map((p) => p.row.qid),
            ),
          );
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
              blockingKey: sql`values(${items.blockingKey})`,
              primaryType: sql`values(${items.primaryType})`,
              data: sql`values(${items.data})`,
            },
          });
      }
      const syncs = changed.map((p) => p.sync);
      for (let i = 0; i < syncs.length; i += ITEM_BATCH) {
        await tx
          .insert(itemSync)
          .values(syncs.slice(i, i + ITEM_BATCH))
          .onDuplicateKeyUpdate({
            set: {
              lastSyncedAt: sql`values(${itemSync.lastSyncedAt})`,
              lastDump: sql`coalesce(values(${itemSync.lastDump}), ${itemSync.lastDump})`,
              dataHash: sql`values(${itemSync.dataHash})`,
              sourceRevid: sql`values(${itemSync.sourceRevid})`,
              converterVersion: sql`values(${itemSync.converterVersion})`,
              primaryType: sql`values(${itemSync.primaryType})`,
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
   * Run as a queue worker under this name instead of reading one shard: claim
   * segments of the file from `dump_import_segments` until none is left (see
   * the header comment). The name must be unique among the workers running
   * together, and stable across a retry of the same worker (the job name).
   */
  worker?: string;
  /** Segments a worker pass splits the file into (DEFAULT_SEGMENTS); every worker must agree. */
  segments?: number;
  /** Seconds without a heartbeat after which a claim is taken over (STALE_CLAIM_SECONDS). */
  staleClaimSeconds?: number;
  /** How often a worker waiting on other workers' segments checks again (tests). */
  waitPollMs?: number;
  /** How often a worker refreshes its claim while it scans (tests). */
  heartbeatMs?: number;
  /**
   * Import a dump again whose segment set is already complete (a worker
   * otherwise finds nothing to do): a token naming this re-import (DUMP_REDO),
   * the same for all its workers. The set is reset once per token, so a
   * worker that starts after the others have finished doesn't start it over.
   */
  redo?: string;
  /**
   * Identifies the dump for the seen-stamp and the shard bookkeeping. Derived
   * from the file (`wikidata-20260914-all.json.gz` → "20260914") when not given.
   */
  dump?: string;
  /** An already-open stream of inflated dump bytes (tests). */
  source?: Readable;
  /** Class QIDs whose instances to import (defaults to IMPORT_CLASSES). */
  classQids?: readonly string[];
  /** Classes of which only some instances are imported (defaults to SELECTIVE_IMPORT_CLASSES). */
  selectiveClasses?: readonly SelectiveImportClass[];
  /** Stop after this many matching items; implies no pruning. */
  limit?: number;
  /** Delete items absent from a complete pass (default true without `limit`). */
  prune?: boolean;
  /** Prune even past MAX_PRUNE_FRACTION. */
  forcePrune?: boolean;
  /** Abort once more than this many entities were skipped (MAX_SKIPPED). */
  maxSkipped?: number;
  /**
   * Parse every hit, even items the mirror already holds at the dump's
   * revision (DUMP_FULL=1): the escape hatch for a conversion change that
   * CONVERTER_VERSION missed.
   */
  full?: boolean;
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
  /** Segments this run scanned in full (one for a shard run). */
  segmentsScanned: number;
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

// ---------------------------------------------------------------------------
// Segment work queue (`dump_import_segments`)
// ---------------------------------------------------------------------------

/**
 * Segments a worker pass splits the dump into (~600 MB of .gz each). Matches
 * are spread unevenly through the dump (at 64, one segment matched 126k items
 * and another 1k), and a dense segment takes far longer to write, so small
 * segments keep the pass from waiting on one dense segment at the end: at 64,
 * one segment took 7 of the pass's 8.6 minutes. Sets are keyed by their
 * segment count, so changing this re-imports a dump already imported under the
 * old count.
 */
export const DEFAULT_SEGMENTS = 256;
/** How often a worker refreshes its claim while it scans. */
const HEARTBEAT_MS = 60_000;
/** How often a worker with nothing to claim checks on the segments still being scanned. */
const WAIT_POLL_MS = 30_000;

/** The rows of one segment set: `dump` split into `segments`. */
const inSet = (dump: string, segments: number) =>
  and(eq(dumpImportSegments.dump, dump), eq(dumpImportSegments.segments, segments));
const segmentRow = (dump: string, segments: number, segment: number) =>
  and(inSet(dump, segments), eq(dumpImportSegments.segment, segment));

/** Create the set's rows, unless another worker already has. */
async function ensureSegments(dump: string, segments: number): Promise<void> {
  const rows = Array.from({ length: segments }, (_, segment) => ({ dump, segments, segment }));
  for (let i = 0; i < rows.length; i += ID_BATCH) {
    await db
      .insert(dumpImportSegments)
      .ignore()
      .values(rows.slice(i, i + ID_BATCH));
  }
}

/**
 * Put a finished set back to unclaimed, for a pass over a dump that was already
 * imported (with DUMP_FULL=1 after a converter change, say), and record the
 * pass's `token` on it. Each token resets the set once: a worker of the same
 * pass that starts after the others have finished (it sat Pending, or it's a
 * retry) finds the token already there and leaves the set alone, rather than
 * re-importing the whole dump on its own. The set's rows are locked while it
 * is checked, so of several workers starting together only the first resets
 * it; the rest find it in progress and join in.
 */
async function resetFinishedSet(dump: string, segments: number, token: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ doneAt: dumpImportSegments.doneAt, pass: dumpImportSegments.pass })
      .from(dumpImportSegments)
      .where(inSet(dump, segments))
      .for("update");
    if (rows.length === 0 || rows.some((r) => r.doneAt === null)) return false;
    if (rows.every((r) => r.pass === token)) return false;
    await tx
      .update(dumpImportSegments)
      .set({
        claimedBy: null,
        claim: null,
        claimedAt: null,
        doneAt: null,
        matched: null,
        pass: token,
      })
      .where(inSet(dump, segments));
    // The redo reads the mirror afresh for its linked QIDs (sharedLinkedQids).
    await tx
      .delete(dumpImportLinked)
      .where(and(eq(dumpImportLinked.dump, dump), eq(dumpImportLinked.segments, segments)));
    return true;
  });
}

export interface SegmentClaim {
  segment: number;
  /** Token identifying this claim, for its heartbeat. */
  claim: string;
  /** Who held the segment before, when this claim took it over (a retry, or a stale claim). */
  from: { worker: string; at: string } | null;
}

/**
 * Claim the lowest segment of the set that nobody is working on: unclaimed,
 * or claimed by this worker's name (an earlier pod of the same job that
 * died), or claimed by anyone with a heartbeat older than `staleSeconds`. Rows
 * other workers are claiming at the same moment are skipped, not waited on.
 */
async function claimSegment(
  dump: string,
  segments: number,
  worker: string,
  staleSeconds: number,
): Promise<SegmentClaim | null> {
  const staleBefore = sql`current_timestamp - interval ${sql.raw(String(Math.max(0, Math.floor(staleSeconds))))} second`;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        segment: dumpImportSegments.segment,
        claimedBy: dumpImportSegments.claimedBy,
        claimedAt: dumpImportSegments.claimedAt,
      })
      .from(dumpImportSegments)
      .where(
        and(
          inSet(dump, segments),
          isNull(dumpImportSegments.doneAt),
          or(
            isNull(dumpImportSegments.claimedAt),
            eq(dumpImportSegments.claimedBy, worker),
            lt(dumpImportSegments.claimedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(dumpImportSegments.segment))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    const claim = randomBytes(8).toString("hex");
    await tx
      .update(dumpImportSegments)
      .set({ claimedBy: worker, claim, claimedAt: sql`current_timestamp` })
      .where(segmentRow(dump, segments, row.segment));
    return {
      segment: row.segment,
      claim,
      from:
        row.claimedBy !== null && row.claimedAt !== null
          ? { worker: row.claimedBy, at: row.claimedAt }
          : null,
    };
  });
}

/** Refresh a claim's heartbeat, unless it has since been taken over or finished. */
async function heartbeat(dump: string, segments: number, claim: SegmentClaim): Promise<void> {
  await db
    .update(dumpImportSegments)
    .set({ claimedAt: sql`current_timestamp` })
    .where(
      and(
        segmentRow(dump, segments, claim.segment),
        eq(dumpImportSegments.claim, claim.claim),
        isNull(dumpImportSegments.doneAt),
      ),
    );
}

interface SetProgress {
  segments: number;
  done: number;
  /** Claimed, not done (being scanned, or abandoned and not stale yet). */
  claimed: number;
  /** Items matched by the done segments. */
  matched: number;
}

async function setProgress(dump: string, segments: number): Promise<SetProgress> {
  const [row] = await db
    .select({
      done: count(dumpImportSegments.doneAt),
      claimed: sql<number>`coalesce(sum(${dumpImportSegments.doneAt} is null and ${dumpImportSegments.claimedAt} is not null), 0)`,
      matched: sql<number>`coalesce(sum(${dumpImportSegments.matched}), 0)`,
    })
    .from(dumpImportSegments)
    .where(inSet(dump, segments));
  return {
    segments,
    done: Number(row.done),
    claimed: Number(row.claimed),
    matched: Number(row.matched),
  };
}

/**
 * Record that `segment` of the set was scanned in full and its writes have
 * landed, and report the set's progress. For workers, `completedNow` is true
 * for exactly one call per set: the one that marks its last undone segment
 * done, which is the one to prune. The set's rows are locked meanwhile, so two
 * workers finishing the last segments together see each other's update in
 * turn and only the second completes the set. A segment scanned twice (a
 * claim taken over while its first worker was still alive) is recorded again,
 * but never completes the set a second time. A `--shard` run is run by hand,
 * so with `repeat` a re-run of a finished set completes it again (a re-run
 * with DUMP_PRUNE_FORCE=1 after a refused prune).
 */
async function finishSegment(
  dump: string,
  segments: number,
  segment: number,
  matched: number,
  repeat: boolean,
): Promise<SetProgress & { completedNow: boolean }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        segment: dumpImportSegments.segment,
        doneAt: dumpImportSegments.doneAt,
        claimedAt: dumpImportSegments.claimedAt,
        matched: dumpImportSegments.matched,
      })
      .from(dumpImportSegments)
      .where(inSet(dump, segments))
      .for("update");
    await tx
      .update(dumpImportSegments)
      .set({ doneAt: sql`current_timestamp`, matched })
      .where(segmentRow(dump, segments, segment));
    const others = rows.filter((r) => r.segment !== segment);
    const wasDone = rows.some((r) => r.segment === segment && r.doneAt !== null);
    const done = others.filter((r) => r.doneAt !== null).length + 1;
    return {
      segments,
      done,
      claimed: others.filter((r) => r.doneAt === null && r.claimedAt !== null).length,
      matched: others.reduce((n, r) => n + (r.matched ?? 0), 0) + matched,
      completedNow: (repeat || !wasDone) && done >= segments,
    };
  });
}

/**
 * Delete every item not stamped as seen in `dump`, with its external ids, and
 * settle the open candidates that referenced it. Returns [items, candidates].
 * Read from `item_sync`, which is small enough to scan whole; deleting the
 * items deletes their rows there too (through its foreign key).
 */
async function pruneMissing(
  dump: string,
  opts: { force: boolean; log: (m: string) => void },
): Promise<[number, number]> {
  const [{ total }] = await db.select({ total: count() }).from(itemSync);
  const gone: string[] = [];
  let after = "";
  for (;;) {
    const page = await db
      .select({ qid: itemSync.qid })
      .from(itemSync)
      .where(
        and(
          or(isNull(itemSync.lastDump), ne(itemSync.lastDump, dump)),
          after ? gt(itemSync.qid, after) : sql`1 = 1`,
        ),
      )
      .orderBy(asc(itemSync.qid))
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
  // A plain read, not INSERT … SELECT: that would take shared locks on the
  // `items` rows ahead of the item_sync ones, the reverse of upsertItems.
  const present = (
    await db.select({ qid: items.qid }).from(items).where(inArray(items.qid, qids))
  ).map((r) => r.qid);
  if (present.length === 0) return;
  // Key order, so concurrent shards take their locks in the same order.
  present.sort(compareKeys);
  // IGNORE: an item deleted since the read (a merge, say) fails the foreign
  // key, and is skipped rather than failing the rest.
  await db
    .insert(itemSync)
    .ignore()
    .values(present.map((qid) => ({ qid, lastDump: dump })))
    .onDuplicateKeyUpdate({ set: { lastDump: dump } });
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
  const runStart = performance.now();
  const log = opts.log ?? ((m: string) => console.log(m));
  const classQids = opts.classQids ?? IMPORT_CLASSES;
  const selectiveClasses = opts.selectiveClasses ?? SELECTIVE_IMPORT_CLASSES;
  const path = opts.path ?? DEFAULT_DUMP_PATH;
  const worker = opts.worker;
  if (worker !== undefined && (opts.source || opts.shard || opts.limit !== undefined)) {
    throw new Error("a worker reads whole segments of `path`: no `source`, `shard` or `limit`");
  }
  if (!opts.source) refuseBz2(path);
  const shard = opts.shard ?? WHOLE_DUMP;
  // A shard run is one segment of a set of `shard.count`.
  const segments = worker !== undefined ? (opts.segments ?? DEFAULT_SEGMENTS) : shard.count;
  const prune = opts.prune ?? opts.limit === undefined;
  const stamp = toSqlDatetime(new Date());
  // A stream has no file to derive the id from: stamp with the moment instead,
  // which still tells this pass apart from every earlier one for the prune.
  const dump = opts.dump ?? (opts.source ? stamp : dumpIdFor(path));
  // "import-dump:" for the usual single shard; "import-dump 3/8:" for a shard,
  // "import-dump <worker>:" for a worker.
  const tag =
    worker !== undefined
      ? `import-dump ${worker}:`
      : shard.count === 1
        ? "import-dump:"
        : `import-dump ${shard.index + 1}/${shard.count}:`;

  await ensureSegments(dump, segments);
  if (
    worker !== undefined &&
    opts.redo !== undefined &&
    (await resetFinishedSet(dump, segments, opts.redo))
  ) {
    log(`${tag} dump ${dump} was imported before; importing it again (redo ${opts.redo})`);
  }
  // Workers started on a dump that is already imported have nothing to scan.
  // Asked to force the prune (after one refused at the cap), they do just that.
  let alreadyDone: SetProgress | undefined;
  if (worker !== undefined) {
    const progress = await setProgress(dump, segments);
    if (progress.done >= segments) {
      alreadyDone = progress;
      log(
        `${tag} dump ${dump} is already imported (all ${segments} segments done)` +
          (opts.forcePrune ? "; pruning it as forced" : "; nothing to do"),
      );
    }
  }

  // The items the mirror's items of the selective classes' sources link to:
  // one way in for a selective class's instance. All selective classes share
  // one set, drawn from all their sources.
  // Workers share one read of them per pass (sharedLinkedQids); a worker with
  // nothing to scan needs neither load.
  let selective: SelectiveScan | undefined;
  if (selectiveClasses.length > 0 && !alreadyDone) {
    const loadStart = performance.now();
    const sources = [...new Set(selectiveClasses.flatMap((c) => c.linkedFrom))];
    const { qids: linkedQids, shared } =
      worker !== undefined
        ? await sharedLinkedQids(dump, segments, sources)
        : { qids: await loadLinkedQids(sources), shared: false };
    selective = { classes: selectiveClasses, linkedQids };
    log(
      `${tag} ${linkedQids.size} items linked from the mirror, ` +
        `${shared ? "read from the pass's first worker" : "loaded"} in ` +
        `${((performance.now() - loadStart) / 1000).toFixed(1)}s; instances of ` +
        `${selectiveClasses.map((c) => c.qid).join(", ")} among them are imported, ` +
        "as are those with one of the class's occupations or id properties",
    );
  }

  // Items the mirror already holds at a known revision, converted by the
  // current converter: a hit at the same revision is skipped unparsed.
  let revisions: RevisionIndex | undefined;
  if (alreadyDone) {
    // Nothing to scan.
  } else if (!opts.full) {
    const loadStart = performance.now();
    revisions = await loadRevisionIndex([...classQids, ...selectiveClasses.map((c) => c.qid)]);
    log(
      `${tag} ${revisions.size} items stored at a known revision, ` +
        `loaded in ${((performance.now() - loadStart) / 1000).toFixed(1)}s; ` +
        "unedited ones are restamped without parsing",
    );
  } else {
    log(`${tag} full pass: parsing every hit, unedited or not`);
  }

  const propertyRows: PropertyRow[] = [];
  let batch: Item[] = [];
  // The revision each batched item was converted from.
  let batchRevids = new Map<string, number>();
  // Unedited items to restamp as seen in this dump.
  let unedited: string[] = [];
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
  const upsert = (pending: Item[], revids: ReadonlyMap<string, number>): Promise<UpsertResult> =>
    withLockRetry(
      () => upsertItems(pending, stamp, dump, revids),
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
  const restamp = async (qids: string[]): Promise<void> => {
    // Key order, so concurrent shards take their locks in the same order.
    qids.sort(compareKeys);
    for (let i = 0; i < qids.length; i += RESTAMP_BATCH) {
      const slice = qids.slice(i, i + RESTAMP_BATCH);
      await withLockRetry(
        () =>
          db
            .update(itemSync)
            .set({ lastSyncedAt: stamp, lastDump: dump })
            .where(inArray(itemSync.qid, slice)),
        (attempt, err) => {
          lockRetries++;
          log(
            `${tag} restamp of ${slice.length} lost a lock race ` +
              `(${errorSummary(err)}); retry ${attempt}/${LOCK_RETRIES}`,
          );
        },
      );
    }
  };
  const flush = async (): Promise<void> => {
    if (unedited.length > 0) {
      const qids = unedited;
      unedited = [];
      await restamp(qids);
    }
    if (batch.length === 0) return;
    const pending = batch;
    const revids = batchRevids;
    batch = [];
    batchRevids = new Map();
    try {
      tally(await upsert(pending, revids));
      return;
    } catch (err) {
      // Find the item(s) at fault; the rest of the batch still lands.
      log(`${tag} batch of ${pending.length} failed (${errorSummary(err)}); retrying one by one`);
    }
    const refused: string[] = [];
    for (const item of pending) {
      try {
        tally(await upsert([item], revids));
      } catch (err) {
        failed++;
        refused.push(item.id);
        onSkip(item.id, err);
      }
    }
    await withLockRetry(
      () => keepSeen(refused, dump),
      (attempt, err) => {
        lockRetries++;
        log(
          `${tag} keeping ${refused.length} refused item(s) lost a lock race ` +
            `(${errorSummary(err)}); retry ${attempt}/${LOCK_RETRIES}`,
        );
      },
    );
  };

  // The progress line shows both the rate over the last interval (what the job
  // is doing now) and the cumulative average (which a slow first minute drags
  // down for hours, so on its own it looks like the job keeps speeding up).
  // With a file on disk, its size and the compressed bytes read so far also
  // give the fraction done and an ETA from the compressed rate over the last
  // interval (inflated bytes can't be compared to the size on disk).
  // `parsed` is the pre-filter hits that were decoded, properties included;
  // the ones neither matched nor a property are false positives (an item that
  // mentions a class QID somewhere other than its best-rank P31).
  let last = { bytes: 0, seconds: 0, read: 0, writeWaitMs: 0 };
  const mbps = (bytes: number, seconds: number): string =>
    seconds > 0 ? (bytes / 1e6 / seconds).toFixed(0) : "?";

  // Write the pending items while the scan inflates the next ones: wait only
  // for the previous write, so one is in flight at a time and the scan never
  // waits on a database round-trip it could have overlapped.
  const maybeFlush = async (): Promise<void> => {
    if (batch.length < ITEM_BATCH && unedited.length < RESTAMP_BATCH) return;
    const waitStart = performance.now();
    await writing;
    writeWaitMs += performance.now() - waitStart;
    writing = flush();
    // Handled when awaited above or after the scan; this just stops Node
    // treating a failure in between as an unhandled rejection.
    writing.catch(() => {});
  };

  // Every segment this run scanned, summed.
  const total: ScanStats = {
    bytes: 0,
    lines: 0,
    parsed: 0,
    matched: 0,
    unedited: 0,
    skipped: 0,
    properties: 0,
    stopped: false,
    seconds: 0,
  };
  let segmentsScanned = 0;
  // Set when this run finished the set's last segment: it is the one to prune.
  let completed = opts.forcePrune ? alreadyDone : undefined;
  let waiting = false;

  while (!alreadyDone) {
    let claim: SegmentClaim | null = null;
    let segment = shard.index;
    if (worker !== undefined) {
      claim = await claimSegment(
        dump,
        segments,
        worker,
        opts.staleClaimSeconds ?? STALE_CLAIM_SECONDS,
      );
      if (!claim) {
        const progress = await setProgress(dump, segments);
        if (progress.done >= segments) break;
        // The rest are being scanned. Stay until they are done, to take over
        // any whose worker dies (its claim goes stale), rather than leave the
        // set unfinished and the prune undone.
        if (!waiting) {
          log(
            `${tag} nothing left to claim; waiting on the ${segments - progress.done} ` +
              "segment(s) other workers are scanning",
          );
        }
        waiting = true;
        await new Promise((r) => setTimeout(r, opts.waitPollMs ?? WAIT_POLL_MS));
        continue;
      }
      waiting = false;
      segment = claim.segment;
    }

    const file = opts.source ? undefined : openDumpFile(path, { index: segment, count: segments });
    const source = opts.source ?? file!.source;
    const segTag = worker !== undefined ? `import-dump ${worker} ${segment + 1}/${segments}:` : tag;
    if (file && segments > 1) {
      log(
        `${segTag} bytes ${file.start}-${file.end} of ${statSync(path).size} ` +
          `(${(file.size / 1e9).toFixed(2)} GB compressed)` +
          (file.size === 0 ? " — empty slice, more segments than members?" : "") +
          (claim?.from
            ? `, taken over from ${claim.from.worker} (last heartbeat ${claim.from.at})`
            : ""),
      );
    }
    last = { bytes: 0, seconds: 0, read: 0, writeWaitMs };
    const held = claim;
    const beat = held
      ? setInterval(() => {
          heartbeat(dump, segments, held).catch((err) =>
            log(`${segTag} heartbeat failed: ${errorSummary(err)}`),
          );
        }, opts.heartbeatMs ?? HEARTBEAT_MS)
      : undefined;
    beat?.unref();

    let scan: ScanStats;
    try {
      scan = await scanDump(source, {
        classQids,
        selective,
        limit: opts.limit,
        progressEveryBytes: opts.progressEveryBytes,
        onSkip,
        isUnedited: revisions ? (qid, revid) => revisions.has(qid, revid) : undefined,
        onUnedited: async (qid) => {
          unedited.push(qid);
          await maybeFlush();
        },
        onItem: async (item, entity) => {
          batch.push(item);
          if (entity.lastrevid !== undefined) batchRevids.set(item.id, entity.lastrevid);
          await maybeFlush();
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
            `${segTag} ${pct}${(s.bytes / 1e9).toFixed(0)} GB inflated, ${s.lines} lines, ` +
              `${s.parsed} parsed, ${s.matched} matched (${s.unedited} unedited, ${unchanged} unchanged), ` +
              `${s.properties} properties, ` +
              `${now} MB/s now (${mbps(s.bytes, s.seconds)} avg), ${eta}` +
              `write wait ${waited.toFixed(0)}s (${waitPct}), ` +
              `rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`,
          );
        },
      });
      // The segment only counts as done once its writes have landed: the
      // prune, maybe run by another worker, relies on their dump stamps.
      await writing;
      await flush();
    } finally {
      clearInterval(beat);
    }

    for (const key of [
      "bytes",
      "lines",
      "parsed",
      "matched",
      "unedited",
      "skipped",
      "properties",
    ] as const) {
      total[key] += scan[key];
    }
    // Only a complete pass over the segment counts towards the set.
    if (scan.stopped) {
      total.stopped = true;
      break;
    }
    segmentsScanned++;
    const progress = await finishSegment(
      dump,
      segments,
      segment,
      scan.matched,
      worker === undefined,
    );
    if (worker !== undefined) {
      log(
        `${segTag} scanned in ${formatDuration(scan.seconds)}, ${scan.matched} matched; ` +
          `${progress.done}/${segments} segments of dump ${dump} done`,
      );
    }
    if (progress.completedNow) completed = progress;
    if (worker === undefined) break;
  }
  total.seconds = (performance.now() - runStart) / 1000;

  const propertyCount = await syncProperties(propertyRows);
  // Items this pass relabelled or retyped: bring the candidates' copies in line.
  const refreshed = await refreshCandidateItemInfo(db);
  log(`${tag} refreshed item type/label on ${refreshed} candidate rows`);
  if (total.stopped) {
    log(`${tag} stopped at limit ${opts.limit}; properties synced so far only`);
  }

  let pruned = 0;
  let settled = 0;
  if (prune && !total.stopped) {
    if (!completed) {
      log(
        worker !== undefined
          ? `${tag} done; the prune is left to whichever worker finishes dump ${dump}'s last segment`
          : `${tag} done; the prune waits for the other shards of dump ${dump}`,
      );
    } else if (completed.matched === 0) {
      log(`${tag} matched nothing — not pruning (wrong file?)`);
    } else {
      [pruned, settled] = await pruneMissing(dump, { force: opts.forcePrune ?? false, log });
    }
  }

  return {
    ...total,
    upserted,
    unchanged,
    externalIds: idRows,
    failed,
    lockRetries,
    writeWaitSeconds: writeWaitMs / 1000,
    segmentsScanned,
    propertyRows: propertyCount,
    pruned,
    settled,
  };
}
