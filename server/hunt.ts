// Candidate-hunting batch job.
//
// Finds likely-duplicate Wikidata item pairs and records them in
// `merge_candidates`. It never does an O(n²) all-pairs scan — pairs come only
// from two cheap "blocking" strategies:
//
//   1. Shared external id — qids that share the same `(property, value)` in
//      `external_ids` (SQL GROUP BY … HAVING count(distinct qid) > 1).
//   2. Label + type — items that share the same `items.blocking_key`
//      (`storedBlockingKey(primaryLabel)`) AND the same `primaryType` (both
//      non-null), grouped the same way in SQL.
//
// On Void this was a cron that enqueued a Cloudflare-Queues "scan" message,
// which fanned pairs out across many "score" messages — all to stay under a
// Worker's CPU/subrequest limits. Toolforge has no managed queue and no such
// limits, so the whole thing collapses into this single function: blocking
// queries → expand groups into a `hunt_pairs` temporary table → score it a
// window at a time → upsert. Nothing held in memory grows with the size of the
// mirror or the number of pairs: grouping, pair dedup, and finding stale and
// orphaned rows all happen in MariaDB. It runs as jobs/hunt.ts on a schedule.
//
// All writes are idempotent upserts, so re-running is always safe, and a pair a
// human already resolved (dismissed/merged, or mid-merge) is never rescored or resurrected
// (see `upsertCandidates`).
import mysql from "mysql2/promise";
import {
  createConnection as createCoreConnection,
  type Connection as CoreConnection,
} from "mysql2";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { items, mergeCandidates, properties } from "../db/schema.ts";
import { connConfig } from "./db-config.ts";
import type { Item, ScoreOptions } from "../src/lib/compare.ts";
import {
  BLOCKING_KEY_MAX,
  orderByAge,
  scoreCandidate,
  storedBlockingKey,
} from "../src/lib/compare.ts";
import { primaryLabel, primaryType } from "../src/lib/wikidata.ts";
import { encodeLanguageList, pairLanguages } from "../src/lib/languages.ts";
import { refreshCandidateItemInfo } from "./candidate-item-info.ts";
import { attachSitelinkRedirects } from "./sitelink-overlay.ts";
import { chunk } from "../src/lib/chunk.ts";
import { PROTECTED_STATUSES } from "../src/lib/api-types.ts";

// Accepts both the pool-backed handle and a dedicated-connection one (the hunt
// opens its own connection), so avoid the `$client` intersection the `drizzle()`
// return type carries.
type Db = MySql2Database<typeof schema>;

/** Minimum confidence for a pair to be persisted; anything below is dropped. */
export const MIN_CONFIDENCE = 0.4;

/**
 * Skip blocking groups larger than this. A single `(property, value)` or
 * `(label, type)` shared by very many items would reintroduce a near-O(n²)
 * pair explosion (and usually signals junk data, e.g. an empty-string id),
 * so it is dropped with a warning rather than expanded.
 */
const MAX_BLOCK_GROUP = 100;

/** Qids loaded per `inArray` item read. MariaDB has no tight bound-param cap. */
const ID_CHUNK = 1000;

/** Candidate rows per multi-row upsert / ids per stale-row DELETE. */
const WRITE_CHUNK = 500;

/**
 * Safety valve for orphan pruning: if more than this fraction of the open rows
 * (and more than `PRUNE_GUARD_MIN` of them) would be pruned as orphans, assume
 * the scan saw a broken or half-imported table and skip the prune. Set
 * `HUNT_FORCE_PRUNE=1` to prune anyway after an intentional blocking change.
 */
const PRUNE_GUARD_FRACTION = 0.5;
const PRUNE_GUARD_MIN = 100;

export interface HuntStats {
  pairs: number;
  scored: number;
  upserted: number;
  /** Stale open rows actually removed (pairs that fell below MIN_CONFIDENCE). */
  deleted: number;
  /**
   * Orphaned open rows actually removed: pairs the scan no longer produces at
   * all (e.g. after a blocking change), or whose item has left the table.
   */
  pruned: number;
  failed: number;
}

/** Seconds since `start` (a `performance.now()` reading), for progress logs. */
function secondsSince(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

/** Current V8 heap use, for progress logs (the job runs close to its heap cap). */
function heapMb(): string {
  return `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB heap`;
}

const qidNum = (id: string): number => parseInt(id.replace(/^Q/, ""), 10);

/**
 * Load the set of property ids that are genuine external identifiers (Wikidata
 * datatype = ExternalId), so blocking and scoring ignore non-id bare literals
 * like review scores (P444) whose values collide across unrelated games. Empty
 * until the property table is synced, in which case callers fall back to the
 * legacy "any external-id-shaped value counts" behaviour.
 */
async function loadIdentifierProps(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ pid: properties.pid })
    .from(properties)
    .where(eq(properties.datatype, "ExternalId"));
  return new Set(rows.map((r) => r.pid));
}

/**
 * Load the set of properties that mirror Wikidata (P31 = Q24075706 — their
 * external service sources ids *from* Wikidata, so each item gets its own id).
 * Passed to scoreCandidate so a shared or differing value on these counts
 * neither for nor against a match. Empty until the property table is synced.
 */
async function loadMirroredIdProps(db: Db): Promise<Set<string>> {
  const rows = await db
    .select({ pid: properties.pid })
    .from(properties)
    .where(eq(properties.mirrorsWikidata, true));
  return new Set(rows.map((r) => r.pid));
}

/** Items whose blocking key is filled in per round of `fillBlockingKeys`. */
const KEY_FILL_BATCH = 5000;

/**
 * Fill in `items.blocking_key` wherever it's missing: rows written before the
 * column existed, or by a writer other than the dump import. Label+type
 * blocking groups on the stored key, so a row without one would never pair.
 * Only the missing rows are read (via idx_items_blocking), so once the column
 * is backfilled this is a single empty query.
 *
 * The missing rows are read in one streamed pass on the reader connection, not
 * re-queried batch by batch: a filled row leaves a delete-marked entry in the
 * `blocking_key IS NULL` index range until InnoDB purges it, so each re-query
 * would walk every row filled before it (quadratic; minutes per 100k rows over
 * a full mirror). Each batch's keys go through a small temporary table and one
 * UPDATE … JOIN on the writer connection.
 */
async function fillBlockingKeys(conn: mysql.Connection, reader: CoreConnection): Promise<number> {
  const start = performance.now();
  await conn.query("drop temporary table if exists hunt_keys");
  await conn.query(`
    create temporary table hunt_keys (
      qid varchar(32) not null primary key,
      blocking_key varchar(${BLOCKING_KEY_MAX}) not null
    ) engine = InnoDB`);
  let filled = 0;
  let batch: [string, string][] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    await conn.query("truncate table hunt_keys");
    await conn.query("insert into hunt_keys (qid, blocking_key) values ?", [batch]);
    await conn.query(
      "update items i join hunt_keys k on k.qid = i.qid set i.blocking_key = k.blocking_key",
    );
    filled += batch.length;
    batch = [];
    if (filled % (KEY_FILL_BATCH * 20) === 0) {
      console.log(`hunt: filled ${filled} blocking keys so far (${secondsSince(start)})`);
    }
  };
  for await (const row of streamRows<{ qid: string; primary_label: string }>(
    reader,
    "select qid, primary_label from items where blocking_key is null and primary_label is not null",
  )) {
    batch.push([row.qid, storedBlockingKey(row.primary_label)!]);
    if (batch.length >= KEY_FILL_BATCH) await flush();
  }
  await flush();
  await conn.query("drop temporary table hunt_keys");
  return filled;
}

/** One blocking group as the scan queries return it. */
interface BlockRow {
  /** Comma-separated distinct qids. */
  qids: string;
  /** Number of distinct qids. */
  n: number;
}

/**
 * Stream a query's rows off a dedicated (callback-API) connection, so a
 * result with millions of groups is never held in memory at once. The consumer
 * can await other work between rows; the stream pauses while it does.
 */
async function* streamRows<T>(conn: CoreConnection, query: string): AsyncGenerator<T> {
  const stream = conn.query(query).stream({ highWaterMark: 1000 });
  // A stream-mode query has no result callback, so mysql2 reports a fatal
  // connection error (a dropped socket, a server restart) only as an 'error'
  // on the connection, never to the stream. Forward it, or the loop below
  // would wait on rows that are never coming.
  const onError = (err: Error) => stream.destroy(err);
  conn.on("error", onError);
  try {
    for await (const row of stream) yield row as T;
  } finally {
    conn.off("error", onError);
  }
}

/** Pair rows per `INSERT IGNORE` into hunt_pairs. */
const PAIR_INSERT_CHUNK = 1000;

/**
 * Collects blocked pairs into the connection's `hunt_pairs` temporary table.
 * The table's unique (a, b) key does the dedup, so a pair found by both
 * blocking strategies (or by two shared ids) is stored once. `seq` keeps
 * insertion order, which keeps each blocking group's pairs together for the
 * scoring windows.
 */
class PairSink {
  private buffer: [number, number][] = [];
  private readonly conn: mysql.Connection;

  constructor(conn: mysql.Connection) {
    this.conn = conn;
  }

  /** Expand a blocking group of qids into unordered pairs, if not oversized. */
  async addGroup(group: BlockRow, kind: string): Promise<void> {
    if (group.n < 2) return;
    if (group.n > MAX_BLOCK_GROUP) {
      console.warn(`hunt: skipping oversized ${kind} block of ${group.n} qids`);
      return;
    }
    const nums = Array.from(new Set(group.qids.split(",")), qidNum);
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const [a, b] = nums[i] < nums[j] ? [nums[i], nums[j]] : [nums[j], nums[i]];
        this.buffer.push([a, b]);
        if (this.buffer.length >= PAIR_INSERT_CHUNK) await this.flush();
      }
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    await this.conn.query("insert ignore into hunt_pairs (a, b) values ?", [rows]);
  }
}

async function countPairs(conn: mysql.Connection): Promise<number> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>("select count(*) as n from hunt_pairs");
  return Number(rows[0].n);
}

/**
 * Blocking: fill `hunt_pairs` with the deduped set of candidate pairs to
 * score. Both strategies group in SQL and only groups of two or more come back
 * (streamed), so memory doesn't grow with the size of the mirror.
 */
async function scan(db: Db, conn: mysql.Connection, reader: CoreConnection): Promise<number> {
  const start = performance.now();
  await conn.query("drop temporary table if exists hunt_pairs");
  await conn.query(`
    create temporary table hunt_pairs (
      seq bigint unsigned not null auto_increment primary key,
      a int unsigned not null,
      b int unsigned not null,
      -- 1 once scored below MIN_CONFIDENCE, so its open row goes as stale.
      stale tinyint not null default 0,
      unique key (a, b)
    ) engine = InnoDB`);
  const sink = new PairSink(conn);

  // 1. Shared external id: same (property, value) held by more than one qid.
  // Restrict to real identifier properties when the property table is synced —
  // otherwise non-ids like review scores (hundreds of games share "80/100")
  // form huge junk blocks. Fall back to all properties before the first sync.
  // GROUP_CONCAT is safe here: the reader connection raised
  // group_concat_max_len, and blocks are capped at MAX_BLOCK_GROUP anyway.
  const idProps = await loadIdentifierProps(db);
  console.log(
    idProps.size > 0
      ? `hunt scan: querying shared-id groups over ${idProps.size} identifier properties`
      : "hunt scan: property table not synced; querying shared-id groups over all properties",
  );
  const identifierFilter =
    idProps.size > 0
      ? "where property in (select pid from properties where datatype = 'ExternalId')"
      : "";
  let extGroups = 0;
  for await (const group of streamRows<BlockRow>(
    reader,
    `select group_concat(distinct qid) as qids, count(distinct qid) as n
     from external_ids ${identifierFilter}
     group by property, value
     having n > 1`,
  )) {
    extGroups++;
    await sink.addGroup(group, "shared-external-id");
  }
  await sink.flush();
  const extPairs = await countPairs(conn);
  console.log(
    `hunt scan: ${extGroups} shared-id groups -> ${extPairs} pairs (${secondsSince(start)}, ${heapMb()})`,
  );

  // 2. Label + type: same stored blocking key (storedBlockingKey of the
  // primary label) AND same primaryType, grouped from idx_items_blocking.
  const filled = await fillBlockingKeys(conn, reader);
  if (filled > 0)
    console.log(`hunt scan: filled ${filled} missing blocking keys (${secondsSince(start)})`);
  let labelGroups = 0;
  for await (const group of streamRows<BlockRow>(
    reader,
    `select group_concat(qid) as qids, count(*) as n
     from items
     where blocking_key is not null and primary_type is not null
     group by blocking_key, primary_type
     having n > 1`,
  )) {
    labelGroups++;
    await sink.addGroup(group, "label+type");
  }
  await sink.flush();
  const total = await countPairs(conn);
  console.log(
    `hunt scan: ${labelGroups} label+type groups -> ${total - extPairs} new pairs; ` +
      `${total} unique pairs total (${secondsSince(start)}, ${heapMb()})`,
  );
  return total;
}

type CandidateRow = typeof mergeCandidates.$inferInsert;

/**
 * Upsert a batch of scored candidates in one multi-row statement.
 *
 * MariaDB has no `ON CONFLICT … WHERE` (SQLite's `setWhere`), so guard each
 * updated column: if the existing row was resolved by a human, keep its stored
 * values untouched; otherwise take the freshly scored ones. `status` is omitted
 * from the SET entirely, so a resolved status never changes.
 */
async function upsertCandidates(db: Db, rows: CandidateRow[]): Promise<void> {
  const resolved = inArray(mergeCandidates.status, [...PROTECTED_STATUSES]);
  await db
    .insert(mergeCandidates)
    .values(rows)
    .onDuplicateKeyUpdate({
      set: {
        confidence: sql`IF(${resolved}, ${mergeCandidates.confidence}, values(${mergeCandidates.confidence}))`,
        reasons: sql`IF(${resolved}, ${mergeCandidates.reasons}, values(${mergeCandidates.reasons}))`,
        hasBlocker: sql`IF(${resolved}, ${mergeCandidates.hasBlocker}, values(${mergeCandidates.hasBlocker}))`,
        detectedAt: sql`IF(${resolved}, ${mergeCandidates.detectedAt}, CURRENT_TIMESTAMP)`,
        // Descriptive copies of the items, not review state: always refresh.
        fromType: sql`values(${mergeCandidates.fromType})`,
        intoType: sql`values(${mergeCandidates.intoType})`,
        fromLabel: sql`values(${mergeCandidates.fromLabel})`,
        intoLabel: sql`values(${mergeCandidates.intoLabel})`,
        clashLangs: sql`values(${mergeCandidates.clashLangs})`,
        fromLabelLangs: sql`values(${mergeCandidates.fromLabelLangs})`,
        intoLabelLangs: sql`values(${mergeCandidates.intoLabelLangs})`,
      },
    });
}

/** Pairs scored per window; only the items those pairs reference are loaded. */
const SCORE_WINDOW = 5000;

/**
 * The hunt_pairs row matching a candidate row `c`, whichever way round the
 * candidate stores its pair (hunt_pairs holds the lower QID number in `a`).
 */
const PAIR_MATCH = `
  p.a = least(cast(substring(c.from_qid, 2) as unsigned), cast(substring(c.into_qid, 2) as unsigned))
  and p.b = greatest(cast(substring(c.from_qid, 2) as unsigned), cast(substring(c.into_qid, 2) as unsigned))`;

/** Status filter for rows the hunt may change (never one a human resolved). */
const UNRESOLVED_SQL = `c.status not in (${PROTECTED_STATUSES.map((s) => `'${s}'`).join(", ")})`;

/** The phases of a scoring window, in the order the window log prints them. */
const WINDOW_PHASES = ["pairs", "fetch", "parse", "redirects", "score", "write"] as const;
type WindowPhase = (typeof WINDOW_PHASES)[number];

/**
 * Wall-clock time per scoring phase, for the current window and for the whole
 * run, so the logs show where the scoring time goes. `lap` charges the time
 * since the previous lap to a phase.
 */
class PhaseTimes {
  private last = performance.now();
  private readonly window = new Map<WindowPhase, number>();
  private readonly total = new Map<WindowPhase, number>();

  lap(phase: WindowPhase): void {
    const now = performance.now();
    const ms = now - this.last;
    this.last = now;
    this.window.set(phase, (this.window.get(phase) ?? 0) + ms);
    this.total.set(phase, (this.total.get(phase) ?? 0) + ms);
  }

  /** "pairs 0.0s, fetch 2.1s, …" for the current window; starts the next one. */
  endWindow(): string {
    const out = PhaseTimes.format(this.window);
    this.window.clear();
    return out;
  }

  /** The same breakdown summed over every window. */
  totals(): string {
    return PhaseTimes.format(this.total);
  }

  private static format(times: Map<WindowPhase, number>): string {
    return WINDOW_PHASES.map((p) => `${p} ${((times.get(p) ?? 0) / 1000).toFixed(1)}s`).join(", ");
  }
}

/** Ids of the candidate rows a query over `merge_candidates c` returns. */
async function candidateIds(conn: mysql.Connection, query: string): Promise<number[]> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(query);
  return rows.map((r) => Number(r.id));
}

/**
 * Score the pairs in `hunt_pairs` a window at a time and write each window's
 * results before reading the next. Holding every referenced item at once
 * doesn't fit: a parsed `Item` is ~5.5 KB of heap, and a full-dump hunt touches
 * hundreds of thousands of them — past the job's heap cap (see jobs.yaml).
 * Windows follow insertion order, which keeps each blocking group's pairs
 * together, so a window's items mostly overlap and few are fetched twice
 * across windows.
 *
 * Survivors are upserted `WRITE_CHUNK` rows per statement. Pairs that fell
 * below the floor are flagged `stale` in hunt_pairs, and pairs whose item has
 * gone are dropped from it; both kinds of open row are then found with one
 * join each against hunt_pairs, so nothing here grows with the number of pairs
 * or open candidates.
 */
async function score(db: Db, conn: mysql.Connection, pairCount: number): Promise<HuntStats> {
  const stats: HuntStats = {
    pairs: pairCount,
    scored: 0,
    upserted: 0,
    deleted: 0,
    pruned: 0,
    failed: 0,
  };
  // An empty scan means empty or broken tables, never "nothing is a candidate
  // any more", so it must not prune every open row either.
  if (pairCount === 0) return stats;
  const start = performance.now();

  const [idProps, mirroredProps] = await Promise.all([
    loadIdentifierProps(db),
    loadMirroredIdProps(db),
  ]);
  // Only count real ExternalId properties as shared identifiers once synced;
  // before that, fall back to legacy value-shape scoring (no predicate). The
  // mirrored-props predicate is unioned with compare.ts's hardcoded floor, so
  // an empty set here just leaves that floor in effect.
  const scoreOpts: ScoreOptions = {};
  if (idProps.size > 0) scoreOpts.isIdentifierProp = (pid) => idProps.has(pid);
  if (mirroredProps.size > 0) scoreOpts.isMirroredIdProp = (pid) => mirroredProps.has(pid);

  // Counted before scoring, for the mass-prune guard below: rows the scoring
  // creates are all in hunt_pairs, so they can never be orphans.
  const [[{ open }]] = await conn.query<mysql.RowDataPacket[]>(
    `select count(*) as open from merge_candidates c where ${UNRESOLVED_SQL}`,
  );
  const openCount = Number(open);
  const windowCount = Math.ceil(pairCount / SCORE_WINDOW);
  console.log(
    `hunt score: ${openCount} open candidate rows; scoring ${pairCount} pairs ` +
      `in ${windowCount} windows of ${SCORE_WINDOW}`,
  );

  let windowIndex = 0;
  let pairsDone = 0;
  let staleCount = 0;
  let lastSeq = 0;
  const times = new PhaseTimes();
  for (;;) {
    const [pairRows] = await conn.query<mysql.RowDataPacket[]>(
      "select seq, a, b from hunt_pairs where seq > ? order by seq limit ?",
      [lastSeq, SCORE_WINDOW],
    );
    if (pairRows.length === 0) break;
    lastSeq = Number(pairRows.at(-1)!.seq);
    windowIndex++;
    const window = pairRows.map((r) => ({
      seq: Number(r.seq),
      qa: `Q${r.a}`,
      qb: `Q${r.b}`,
    }));
    times.lap("pairs");

    const wanted = new Set<string>();
    for (const { qa, qb } of window) {
      wanted.add(qa);
      wanted.add(qb);
    }
    // `data` is read as the raw JSON string and parsed here (mysql2 otherwise
    // parses MariaDB's JSON columns itself while reading the result, and the
    // column's decoder would too), so the log can tell the database
    // round trips apart from the parsing.
    const raw: { qid: string; data: string }[] = [];
    for (const ids of chunk(Array.from(wanted), ID_CHUNK)) {
      raw.push(
        ...(await db
          .select({
            qid: items.qid,
            data: sql<string>`cast(${items.data} as char)`.mapWith(String),
          })
          .from(items)
          .where(inArray(items.qid, ids))),
      );
    }
    times.lap("fetch");
    const byQid = new Map<string, Item>();
    for (const row of raw) byQid.set(row.qid, JSON.parse(row.data) as Item);
    times.lap("parse");
    // Redirects resolved by the previous resolve-sitelinks run, so a clash
    // that's one page redirecting to the other scores as duplicate evidence.
    await attachSitelinkRedirects(
      db,
      window.flatMap(({ qa, qb }) => {
        const a = byQid.get(qa);
        const b = byQid.get(qb);
        return a && b ? [[a, b] as [Item, Item]] : [];
      }),
    );

    times.lap("redirects");

    const survivors: CandidateRow[] = [];
    const staleSeqs: number[] = [];
    const goneSeqs: number[] = [];
    for (const { seq, qa, qb } of window) {
      const a = byQid.get(qa);
      const b = byQid.get(qb);
      if (!a || !b) {
        // An item was removed since the scan (or its external ids outlived
        // it): the pair can't be a candidate any more, so drop it from
        // hunt_pairs and let the orphan prune take any open row.
        goneSeqs.push(seq);
        continue;
      }
      stats.scored++;

      try {
        const [from, into] = orderByAge(a, b);
        const result = scoreCandidate(from, into, scoreOpts);
        if (result.confidence < MIN_CONFIDENCE) {
          // A pair that no longer clears the floor (e.g. after a heuristic
          // change that exposed it as a false positive) must not linger with a
          // stale higher score: its open row, if any, is deleted below.
          staleSeqs.push(seq);
          continue;
        }
        const langs = pairLanguages(from, into);
        survivors.push({
          fromQid: from.id,
          intoQid: into.id,
          confidence: result.confidence,
          reasons: result.reasons,
          hasBlocker: result.hasBlocker,
          fromType: primaryType(from) ?? null,
          intoType: primaryType(into) ?? null,
          fromLabel: primaryLabel(from) ?? null,
          intoLabel: primaryLabel(into) ?? null,
          clashLangs: encodeLanguageList(langs.clash),
          fromLabelLangs: encodeLanguageList(langs.fromLabels),
          intoLabelLangs: encodeLanguageList(langs.intoLabels),
        });
      } catch (err) {
        console.error(`hunt score: pair ${qa}/${qb} failed`, err);
        stats.failed++;
      }
    }
    times.lap("score");
    staleCount += staleSeqs.length;
    if (staleSeqs.length > 0) {
      await conn.query("update hunt_pairs set stale = 1 where seq in (?)", [staleSeqs]);
    }
    if (goneSeqs.length > 0) {
      await conn.query("delete from hunt_pairs where seq in (?)", [goneSeqs]);
    }

    for (const batch of chunk(survivors, WRITE_CHUNK)) {
      try {
        await upsertCandidates(db, batch);
        stats.upserted += batch.length;
      } catch (batchErr) {
        // Retry row by row so one bad row doesn't cost the whole batch, and the
        // failure is attributed to the pair that caused it.
        console.warn(`hunt score: batch upsert failed, retrying rows individually`, batchErr);
        for (const row of batch) {
          try {
            await upsertCandidates(db, [row]);
            stats.upserted++;
          } catch (err) {
            console.error(`hunt score: pair ${row.fromQid}/${row.intoQid} failed`, err);
            stats.failed++;
          }
        }
      }
    }

    times.lap("write");

    pairsDone += window.length;
    const elapsedSec = (performance.now() - start) / 1000;
    const rate = elapsedSec > 0 ? Math.round(pairsDone / elapsedSec) : 0;
    const etaSec = rate > 0 ? Math.round((pairCount - pairsDone) / rate) : 0;
    console.log(
      `hunt score: window ${windowIndex}/${windowCount}: ${pairsDone}/${pairCount} pairs ` +
        `(${((pairsDone / pairCount) * 100).toFixed(1)}%), ${byQid.size} items loaded, ` +
        `${survivors.length} survivors; totals scored ${stats.scored}, upserted ${stats.upserted}, ` +
        `below floor ${staleCount}` +
        (stats.failed > 0 ? `, ${stats.failed} failed` : "") +
        ` (${secondsSince(start)}, ${rate} pairs/s, ~${etaSec}s left, ${heapMb()}; ` +
        `${times.endWindow()})`,
    );
  }
  console.log(`hunt score: time by phase over all windows: ${times.totals()}`);

  // Open rows for pairs that scored below the floor. The DELETE re-checks the
  // status in case a reviewer resolved the row since this SELECT.
  const unresolved = notInArray(mergeCandidates.status, [...PROTECTED_STATUSES]);
  const stale = await candidateIds(
    conn,
    `select c.id from merge_candidates c
     join hunt_pairs p on ${PAIR_MATCH}
     where ${UNRESOLVED_SQL} and p.stale = 1`,
  );
  if (stale.length > 0) {
    console.log(`hunt score: deleting ${stale.length} stale open rows below ${MIN_CONFIDENCE}`);
  }
  for (const ids of chunk(stale, WRITE_CHUNK)) {
    const [res] = await db
      .delete(mergeCandidates)
      .where(and(inArray(mergeCandidates.id, ids), unresolved));
    stats.deleted += res.affectedRows;
  }

  // Open rows whose pair the scan didn't produce at all (or whose item has
  // since gone): orphans of an older blocking rule, never rescored, so the
  // stale check above can't reach them.
  const orphans = await candidateIds(
    conn,
    `select c.id from merge_candidates c
     where ${UNRESOLVED_SQL}
       and not exists (select 1 from hunt_pairs p where ${PAIR_MATCH})`,
  );
  if (
    orphans.length > PRUNE_GUARD_MIN &&
    orphans.length > openCount * PRUNE_GUARD_FRACTION &&
    process.env.HUNT_FORCE_PRUNE !== "1"
  ) {
    console.warn(
      `hunt score: NOT pruning ${orphans.length} of ${openCount} open rows the scan no ` +
        `longer produces — too many to be a heuristic change; set HUNT_FORCE_PRUNE=1 if intended`,
    );
  } else {
    if (orphans.length > 0) {
      console.log(`hunt score: pruning ${orphans.length} open rows the scan no longer produces`);
    }
    for (const ids of chunk(orphans, WRITE_CHUNK)) {
      const [res] = await db
        .delete(mergeCandidates)
        .where(and(inArray(mergeCandidates.id, ids), unresolved));
      stats.pruned += res.affectedRows;
    }
  }

  console.log(
    `hunt score: scored ${stats.scored}, upserted ${stats.upserted}, deleted ${stats.deleted}, ` +
      `pruned ${stats.pruned}` +
      (stats.failed > 0 ? `, ${stats.failed} failed` : "") +
      ` (${secondsSince(start)})`,
  );
  return stats;
}

/**
 * Run a full hunt on its own dedicated connections (not web pool members):
 * one holds the `hunt_pairs` temporary table (temporary tables are per
 * connection) and does every write; the other streams the blocking queries,
 * with `group_concat_max_len` raised — the 1 KB default would truncate a
 * ~100-qid block and silently drop qids from the `split(",")`. A connection
 * can't run a query while it's still streaming another's rows, hence two.
 */
export async function runHunt(): Promise<HuntStats> {
  const start = performance.now();
  console.log("hunt: starting");
  const conn = await mysql.createConnection(connConfig());
  const reader = createCoreConnection(connConfig());
  // Without a listener, an 'error' mysql2 emits on the connection itself (a
  // fatal error mid-stream, or the socket dropping while idle) is an uncaught
  // exception that kills the process. Mid-stream errors also reach the
  // stream (see streamRows) and fail the hunt through the normal path.
  reader.on("error", (err) => console.warn(`hunt: reader connection error: ${err.message}`));
  const endReader = () =>
    reader
      .promise()
      .end()
      .catch(() => {});
  try {
    await reader.promise().query("SET SESSION group_concat_max_len = 1048576");
    const db = drizzle(conn, { schema, mode: "default" });
    const pairCount = await scan(db, conn, reader);
    // The reader is only for blocking; don't hold it idle through scoring.
    await endReader();
    const stats = await score(db, conn, pairCount);
    await conn.query("drop temporary table if exists hunt_pairs");
    // Pairs the hunt didn't rescore (resolved ones, or ones whose blocking
    // group changed) still need their item copies kept current.
    const refreshStart = performance.now();
    console.log("hunt: refreshing candidate item type/label copies");
    const refreshed = await refreshCandidateItemInfo(db);
    console.log(
      `hunt: refreshed item type/label on ${refreshed} candidate rows (${secondsSince(refreshStart)})`,
    );
    console.log(`hunt: finished in ${secondsSince(start)}`);
    return stats;
  } finally {
    await Promise.allSettled([conn.end(), endReader()]);
  }
}
