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
// (see the conditional upsert in `score`).
import mysql from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import * as schema from "../db/schema.ts";
import { externalIds, items, mergeCandidates, properties } from "../db/schema.ts";
import { connConfig } from "./db-config.ts";
import type { Item, ScoreOptions } from "../src/lib/compare.ts";
import { blockingLabelKey, orderByAge, scoreCandidate } from "../src/lib/compare.ts";
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

export interface HuntStats {
  pairs: number;
  scored: number;
  upserted: number;
  deleted: number;
  failed: number;
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
  const pairs = new Set<string>();

  // 1. Shared external id: same (property, value) held by more than one qid.
  // Restrict to real identifier properties when the property table is synced —
  // otherwise non-ids like review scores (hundreds of games share "80/100")
  // form huge junk blocks. Fall back to all properties before the first sync.
  // GROUP_CONCAT is safe here: the caller raised group_concat_max_len, and
  // blocks are capped at MAX_BLOCK_GROUP anyway.
  const idProps = await loadIdentifierProps(db);
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
    `hunt scan: ${extGroups.length} shared-id groups, ${byLabelType.size} label+type groups ` +
      `-> ${pairs.size} unique pairs`,
  );
  return Array.from(pairs, (key) => key.split("|") as [string, string]);
}

/** Score every pair and upsert the survivors. */
async function score(db: Db, pairs: [string, string][]): Promise<HuntStats> {
  const stats: HuntStats = { pairs: pairs.length, scored: 0, upserted: 0, deleted: 0, failed: 0 };
  if (pairs.length === 0) return stats;

  // Load every referenced item's data in one pass, chunked into IN lists.
  const wanted = new Set<string>();
  for (const [a, b] of pairs) {
    wanted.add(a);
    wanted.add(b);
  }
  const rowChunks = await Promise.all(
    chunk(Array.from(wanted), ID_CHUNK).map((ids) =>
      db.select({ qid: items.qid, data: items.data }).from(items).where(inArray(items.qid, ids)),
    ),
  );
  const byQid = new Map<string, Item>();
  for (const row of rowChunks.flat()) byQid.set(row.qid, row.data as Item);

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

  for (const [qa, qb] of pairs) {
    const a = byQid.get(qa);
    const b = byQid.get(qb);
    if (!a || !b) continue; // an item may have been removed since the scan
    stats.scored++;

    try {
      const [from, into] = orderByAge(a, b);
      const result = scoreCandidate(from, into, scoreOpts);
      if (result.confidence < MIN_CONFIDENCE) {
        // A pair that no longer clears the floor (e.g. after a heuristic change
        // that exposed it as a false positive) must not linger with a stale
        // higher score, so drop any open row for it. Never touch one a human
        // resolved.
        await db
          .delete(mergeCandidates)
          .where(
            and(
              eq(mergeCandidates.fromQid, from.id),
              eq(mergeCandidates.intoQid, into.id),
              notInArray(mergeCandidates.status, [...PROTECTED_STATUSES]),
            ),
          );
        stats.deleted++;
        continue;
      }

      // MariaDB has no `ON CONFLICT … WHERE` (SQLite's `setWhere`), so guard each
      // updated column: if the existing row was resolved by a human, keep its
      // stored values untouched; otherwise take the freshly scored ones. `status`
      // is omitted from the SET entirely, so a resolved status never changes.
      const resolved = inArray(mergeCandidates.status, [...PROTECTED_STATUSES]);
      await db
        .insert(mergeCandidates)
        .values({
          fromQid: from.id,
          intoQid: into.id,
          confidence: result.confidence,
          reasons: result.reasons,
          hasBlocker: result.hasBlocker,
        })
        .onDuplicateKeyUpdate({
          set: {
            confidence: sql`IF(${resolved}, ${mergeCandidates.confidence}, values(${mergeCandidates.confidence}))`,
            reasons: sql`IF(${resolved}, ${mergeCandidates.reasons}, values(${mergeCandidates.reasons}))`,
            hasBlocker: sql`IF(${resolved}, ${mergeCandidates.hasBlocker}, values(${mergeCandidates.hasBlocker}))`,
            detectedAt: sql`IF(${resolved}, ${mergeCandidates.detectedAt}, CURRENT_TIMESTAMP)`,
          },
        });
      stats.upserted++;
    } catch (err) {
      console.error(`hunt score: pair ${qa}/${qb} failed`, err);
      stats.failed++;
    }
  }

  console.log(
    `hunt score: scored ${stats.scored}, upserted ${stats.upserted}, deleted ${stats.deleted}` +
      (stats.failed > 0 ? `, ${stats.failed} failed` : ""),
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
  const conn = await mysql.createConnection(connConfig());
  try {
    await conn.query("SET SESSION group_concat_max_len = 1048576");
    const db = drizzle(conn, { schema, mode: "default" });
    const pairs = await scan(db);
    return await score(db, pairs);
  } finally {
    await conn.end();
  }
}
