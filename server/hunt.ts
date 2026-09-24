// Candidate-hunting batch job.
//
// Finds likely-duplicate Wikidata item pairs and records them in
// `merge_candidates`. It never does an O(n²) all-pairs scan — pairs come only
// from two cheap "blocking" strategies:
//
//   1. Shared external id — qids that share the same `(property, value)` in
//      `external_ids` (SQL GROUP BY … HAVING count(distinct qid) > 1).
//   2. Label + type — items that share the same `normalize(primaryLabel)` AND
//      the same `primaryType` (both non-null).
//
// On Void this was a cron that enqueued a Cloudflare-Queues "scan" message,
// which fanned pairs out across many "score" messages — all to stay under a
// Worker's CPU/subrequest limits. Toolforge has no managed queue and no such
// limits, so the whole thing collapses into this single function: blocking
// query → expand to pairs → score inline → upsert. It runs as jobs/hunt.ts on a
// schedule and is also fired (unawaited) by POST /api/hunt.
//
// All writes are idempotent upserts, so re-running is always safe, and a pair a
// human already resolved (dismissed/merged, or mid-merge) is never rescored or resurrected
// (see `upsertCandidates`).
import mysql from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { externalIds, items, mergeCandidates, properties } from "../db/schema.ts";
import { connConfig } from "./db-config.ts";
import type { Item, ScoreOptions } from "../src/lib/compare.ts";
import { blockingLabelKey, orderByAge, scoreCandidate } from "../src/lib/compare.ts";
import { primaryLabel, primaryType } from "../src/lib/wikidata.ts";
import { refreshCandidateItemInfo } from "./candidate-item-info.ts";
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

/** Canonical key for an unordered qid pair (lower QID number first). */
function pairKey(a: string, b: string): string {
  return qidNum(a) < qidNum(b) ? `${a}|${b}` : `${b}|${a}`;
}

/** Expand a blocking group of qids into unordered pairs, if not oversized. */
function addGroupPairs(qids: string[], into: Set<string>, kind: string): void {
  const unique = Array.from(new Set(qids));
  if (unique.length < 2) return;
  if (unique.length > MAX_BLOCK_GROUP) {
    console.warn(`hunt: skipping oversized ${kind} block of ${unique.length} qids`);
    return;
  }
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      into.add(pairKey(unique[i], unique[j]));
    }
  }
}

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

/** Blocking: collect the deduped set of candidate pairs to score. */
async function scan(db: Db): Promise<[string, string][]> {
  const start = performance.now();
  const pairs = new Set<string>();

  // 1. Shared external id: same (property, value) held by more than one qid.
  // Restrict to real identifier properties when the property table is synced —
  // otherwise non-ids like review scores (hundreds of games share "80/100")
  // form huge junk blocks. Fall back to all properties before the first sync.
  // GROUP_CONCAT is safe here: the caller raised group_concat_max_len, and
  // blocks are capped at MAX_BLOCK_GROUP anyway.
  const idProps = await loadIdentifierProps(db);
  console.log(
    idProps.size > 0
      ? `hunt scan: querying shared-id groups over ${idProps.size} identifier properties`
      : "hunt scan: property table not synced; querying shared-id groups over all properties",
  );
  const identifierFilter =
    idProps.size > 0
      ? sql`${externalIds.property} IN (SELECT ${properties.pid} FROM ${properties} WHERE ${properties.datatype} = 'ExternalId')`
      : undefined;
  const extGroups = await db
    .select({
      qids: sql<string>`group_concat(distinct ${externalIds.qid})`,
    })
    .from(externalIds)
    .where(identifierFilter)
    .groupBy(externalIds.property, externalIds.value)
    .having(sql`count(distinct ${externalIds.qid}) > 1`);

  for (const group of extGroups) {
    if (group.qids) addGroupPairs(group.qids.split(","), pairs, "shared-external-id");
  }
  const extPairs = pairs.size;
  console.log(
    `hunt scan: ${extGroups.length} shared-id groups -> ${extPairs} pairs (${secondsSince(start)})`,
  );

  // 2. Label + type: same blockingLabelKey(primaryLabel) AND same primaryType.
  // Keying is a JS helper, so bucket in memory over a small projection
  // (qid + label + type only, never the large `data` JSON).
  const labeled = await db
    .select({
      qid: items.qid,
      primaryLabel: items.primaryLabel,
      primaryType: items.primaryType,
    })
    .from(items)
    .where(and(isNotNull(items.primaryLabel), isNotNull(items.primaryType)));
  console.log(`hunt scan: loaded ${labeled.length} labeled+typed items (${secondsSince(start)})`);

  const byLabelType = new Map<string, string[]>();
  for (const row of labeled) {
    if (!row.primaryLabel || !row.primaryType) continue;
    const key = `${blockingLabelKey(row.primaryLabel)} ${row.primaryType}`;
    const bucket = byLabelType.get(key);
    if (bucket) bucket.push(row.qid);
    else byLabelType.set(key, [row.qid]);
  }
  for (const qids of byLabelType.values()) {
    addGroupPairs(qids, pairs, "label+type");
  }

  console.log(
    `hunt scan: ${byLabelType.size} label+type groups -> ${pairs.size - extPairs} new pairs; ` +
      `${pairs.size} unique pairs total (${secondsSince(start)}, ${heapMb()})`,
  );
  return Array.from(pairs, (key) => key.split("|") as [string, string]);
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
      },
    });
}

/** Pairs scored per window; only the items those pairs reference are loaded. */
const SCORE_WINDOW = 5000;

/**
 * Score the pairs a window at a time and write each window's results before
 * loading the next. Holding every referenced item at once doesn't fit: a parsed
 * `Item` is ~5.5 KB of heap, and a full-dump hunt touches hundreds of thousands
 * of them — past the job's 1.5 GB heap. Pairs arrive grouped by blocking bucket
 * (see `addGroupPairs`), so a window's items mostly overlap and few are fetched
 * twice across windows.
 *
 * Survivors are upserted `WRITE_CHUNK` rows per statement, and open rows for
 * pairs that fell below the floor are deleted by id.
 */
async function score(db: Db, pairs: [string, string][]): Promise<HuntStats> {
  const stats: HuntStats = {
    pairs: pairs.length,
    scored: 0,
    upserted: 0,
    deleted: 0,
    pruned: 0,
    failed: 0,
  };
  // An empty scan means empty or broken tables, never "nothing is a candidate
  // any more", so it must not prune every open row either.
  if (pairs.length === 0) return stats;
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

  // A pair that no longer clears the floor (e.g. after a heuristic change that
  // exposed it as a false positive) must not linger with a stale higher score,
  // so its open row is dropped. Most below-floor pairs have no row at all, so
  // look the existing open rows up once (the unresolved set is comparatively
  // small) instead of issuing a DELETE per pair. Never touch one a human resolved.
  const unresolved = notInArray(mergeCandidates.status, [...PROTECTED_STATUSES]);
  const openRows = await db
    .select({
      id: mergeCandidates.id,
      fromQid: mergeCandidates.fromQid,
      intoQid: mergeCandidates.intoQid,
    })
    .from(mergeCandidates)
    .where(unresolved);
  // Keyed like the scan's pairs (`pairKey`: lower QID first).
  const openIds = new Map(openRows.map((r) => [pairKey(r.fromQid, r.intoQid), r.id]));
  const stale: number[] = [];

  // An open row whose pair the scan didn't produce at all is never rescored, so
  // the stale check below can't reach it: it's an orphan of an older blocking
  // rule (or of an item that was since removed) and is pruned too.
  const orphaned = new Map(openIds);
  for (const [a, b] of pairs) orphaned.delete(`${a}|${b}`);
  const windowCount = Math.ceil(pairs.length / SCORE_WINDOW);
  console.log(
    `hunt score: ${openRows.length} open candidate rows; scoring ${pairs.length} pairs ` +
      `in ${windowCount} windows of ${SCORE_WINDOW}`,
  );

  let windowIndex = 0;
  let pairsDone = 0;
  for (const window of chunk(pairs, SCORE_WINDOW)) {
    windowIndex++;
    const wanted = new Set<string>();
    for (const [a, b] of window) {
      wanted.add(a);
      wanted.add(b);
    }
    const byQid = new Map<string, Item>();
    for (const ids of chunk(Array.from(wanted), ID_CHUNK)) {
      const rows = await db
        .select({ qid: items.qid, data: items.data })
        .from(items)
        .where(inArray(items.qid, ids));
      for (const row of rows) byQid.set(row.qid, row.data as Item);
    }

    const survivors: CandidateRow[] = [];
    for (const [qa, qb] of window) {
      const a = byQid.get(qa);
      const b = byQid.get(qb);
      if (!a || !b) {
        // An item was removed since the scan (or its external ids outlived
        // it): the pair can't be a candidate any more.
        const id = openIds.get(`${qa}|${qb}`);
        if (id !== undefined) orphaned.set(`${qa}|${qb}`, id);
        continue;
      }
      stats.scored++;

      try {
        const [from, into] = orderByAge(a, b);
        const result = scoreCandidate(from, into, scoreOpts);
        if (result.confidence < MIN_CONFIDENCE) {
          const id = openIds.get(`${qa}|${qb}`);
          if (id !== undefined) stale.push(id);
          continue;
        }
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
        });
      } catch (err) {
        console.error(`hunt score: pair ${qa}/${qb} failed`, err);
        stats.failed++;
      }
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

    pairsDone += window.length;
    const elapsedSec = (performance.now() - start) / 1000;
    const rate = elapsedSec > 0 ? Math.round(pairsDone / elapsedSec) : 0;
    const etaSec = rate > 0 ? Math.round((pairs.length - pairsDone) / rate) : 0;
    console.log(
      `hunt score: window ${windowIndex}/${windowCount}: ${pairsDone}/${pairs.length} pairs ` +
        `(${((pairsDone / pairs.length) * 100).toFixed(1)}%), ${byQid.size} items loaded, ` +
        `${survivors.length} survivors; totals scored ${stats.scored}, upserted ${stats.upserted}, ` +
        `stale ${stale.length}` +
        (stats.failed > 0 ? `, ${stats.failed} failed` : "") +
        ` (${secondsSince(start)}, ${rate} pairs/s, ~${etaSec}s left, ${heapMb()})`,
    );
  }

  if (stale.length > 0) {
    console.log(`hunt score: deleting ${stale.length} stale open rows below ${MIN_CONFIDENCE}`);
  }

  for (const ids of chunk(stale, WRITE_CHUNK)) {
    // Re-check the status in the DELETE itself in case a reviewer resolved the
    // row since the SELECT above.
    const [res] = await db
      .delete(mergeCandidates)
      .where(and(inArray(mergeCandidates.id, ids), unresolved));
    stats.deleted += res.affectedRows;
  }

  const orphans = Array.from(orphaned.values());
  if (
    orphans.length > PRUNE_GUARD_MIN &&
    orphans.length > openRows.length * PRUNE_GUARD_FRACTION &&
    process.env.HUNT_FORCE_PRUNE !== "1"
  ) {
    console.warn(
      `hunt score: NOT pruning ${orphans.length} of ${openRows.length} open rows the scan no ` +
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
 * Run a full hunt on its own dedicated connection. A dedicated connection (not
 * a pool member) lets us raise `group_concat_max_len` for the whole run — the
 * 1 KB default would truncate a ~100-qid block and silently drop qids from the
 * `split(",")` — and keeps the heavy scan off the web pool.
 */
export async function runHunt(): Promise<HuntStats> {
  const start = performance.now();
  console.log("hunt: starting");
  const conn = await mysql.createConnection(connConfig());
  try {
    await conn.query("SET SESSION group_concat_max_len = 1048576");
    const db = drizzle(conn, { schema, mode: "default" });
    const pairs = await scan(db);
    const stats = await score(db, pairs);
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
    await conn.end();
  }
}
