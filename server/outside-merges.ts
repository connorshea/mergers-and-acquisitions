// Settle open candidates whose items were merged (or deleted) on Wikidata
// since the last dump, without waiting for the next weekly import to prune
// them. Run nightly by jobs/resolve-merges.ts, before the hunt.
//
// A merged-away item is a redirect on Wikidata; a deleted one has no page. The
// wikidatawiki replica's `page` / `redirect` tables say which, for every item
// on an open candidate, in a few hundred indexed lookups. Each open pair with
// such an item is settled, and the item's rows leave the mirror, the same way
// the app's merge route and the import's prune do, so the hunt stops pairing it.
// A settled pair is never reopened by the hunt (see PROTECTED_STATUSES).
import mysql from "mysql2/promise";
import type { Connection } from "mysql2/promise";
import { and, eq, inArray, or } from "drizzle-orm";
import { db } from "./db.ts";
import { externalIds, items, mergeCandidates } from "../db/schema.ts";
import type { Item } from "../src/lib/compare.ts";
import { chunk } from "../src/lib/chunk.ts";
import { toSqlDatetime } from "./auth/time.ts";
import { collectOpenQids } from "./item-creations.ts";
import { lookUpPages, replicaConnConfig } from "./sitelink-redirects.ts";

/** Qids per settle transaction. */
const SETTLE_CHUNK = 500;
/**
 * Refuse to treat more than this fraction of the items as deleted (and at
 * least MISSING_GUARD_MIN of them): that many missing pages means a replica
 * problem, not real deletions. Redirects are still settled; the next import's
 * prune catches any real deletions.
 */
const MISSING_GUARD_FRACTION = 0.01;
const MISSING_GUARD_MIN = 50;

/** What became of an item that is no longer a plain item on Wikidata. */
export type ItemFate = { qid: string; redirectTo: string | null } | { qid: string; deleted: true };

export interface OutsideMergeStats {
  /** Distinct items across the open candidates. */
  items: number;
  /** Of those, now redirects on Wikidata. */
  redirects: number;
  /** Of those, with no page on Wikidata (deleted). */
  deleted: number;
  /** True when the deleted ones were left alone as too many to trust. */
  deletionsSkipped: boolean;
  /** Open candidates settled. */
  settled: number;
}

export interface OutsideMergeOptions {
  /** Open a connection to the wikidatawiki replica; tests substitute their own. */
  connect?: () => Promise<Connection>;
}

/**
 * How to settle a pair given the fates of its items: `merged` when one side
 * is now a redirect (to the other side, or to a third item), `dismissed` when
 * one side was deleted.
 */
export function settlement(
  fromQid: string,
  intoQid: string,
  fates: Map<string, ItemFate>,
): { status: "merged" | "dismissed"; resolution: string } | null {
  const sides = [fates.get(fromQid), fates.get(intoQid)].filter((f) => f !== undefined);
  const redirects = sides.filter((f) => !("deleted" in f));
  for (const f of redirects) {
    const other = f.qid === fromQid ? intoQid : fromQid;
    if ("redirectTo" in f && f.redirectTo === other) {
      return {
        status: "merged",
        resolution: `${f.qid} merged into ${other} on Wikidata outside the app`,
      };
    }
  }
  const redirect = redirects[0];
  if (redirect && "redirectTo" in redirect) {
    return {
      status: "merged",
      resolution: redirect.redirectTo
        ? `${redirect.qid} merged into ${redirect.redirectTo} elsewhere`
        : `${redirect.qid} became a redirect on Wikidata`,
    };
  }
  const deleted = sides[0];
  if (deleted) return { status: "dismissed", resolution: `${deleted.qid} was deleted on Wikidata` };
  return null;
}

/** The fates of the qids that are no longer plain items, per the replica. */
async function lookUpFates(conn: Connection, qids: string[]): Promise<ItemFate[]> {
  const fates: ItemFate[] = [];
  for (const page of await lookUpPages(conn, qids)) {
    if (page.missing) fates.push({ qid: page.title, deleted: true });
    else if (page.isRedirect) {
      const target = page.redirectTarget;
      fates.push({ qid: page.title, redirectTo: target && /^Q\d+$/.test(target) ? target : null });
    }
  }
  return fates;
}

/**
 * Settle the open candidates on `qids` per `fates`, and drop those items from
 * the mirror. Each settled pair keeps a snapshot of both items as mirrored, as
 * a merge in the app does, so its detail page still shows the comparison.
 * Returns how many candidates were settled.
 */
async function settle(qids: string[], fates: Map<string, ItemFate>): Promise<number> {
  const stamp = toSqlDatetime(new Date());
  return db.transaction(async (tx) => {
    const pairs = await tx
      .select({
        id: mergeCandidates.id,
        fromQid: mergeCandidates.fromQid,
        intoQid: mergeCandidates.intoQid,
      })
      .from(mergeCandidates)
      .where(
        and(
          or(inArray(mergeCandidates.fromQid, qids), inArray(mergeCandidates.intoQid, qids)),
          eq(mergeCandidates.status, "open"),
        ),
      );
    const sides = [...new Set(pairs.flatMap((p) => [p.fromQid, p.intoQid]))];
    const mirrored = new Map<string, Item>();
    for (const batch of chunk(sides, SETTLE_CHUNK)) {
      const rows = await tx
        .select({ qid: items.qid, data: items.data })
        .from(items)
        .where(inArray(items.qid, batch));
      for (const r of rows) mirrored.set(r.qid, r.data);
    }
    let settled = 0;
    for (const p of pairs) {
      const outcome = settlement(p.fromQid, p.intoQid, fates);
      if (!outcome) continue;
      const from = mirrored.get(p.fromQid);
      const into = mirrored.get(p.intoQid);
      const [res] = await tx
        .update(mergeCandidates)
        .set({
          ...outcome,
          resolvedAt: stamp,
          ...(from && into ? { snapshot: { from, into } } : {}),
        })
        // Re-checked: a reviewer may have taken the pair since the select.
        .where(and(eq(mergeCandidates.id, p.id), eq(mergeCandidates.status, "open")));
      settled += res.affectedRows;
    }
    await tx.delete(externalIds).where(inArray(externalIds.qid, qids));
    await tx.delete(items).where(inArray(items.qid, qids));
    return settled;
  });
}

/**
 * Check every open candidate's items against the wikidatawiki replica and
 * settle the pairs whose items were merged away or deleted. Throws on a
 * replica or ToolsDB error (the next run starts over; pairs already settled
 * stay settled).
 */
export async function runOutsideMergeSync(
  opts: OutsideMergeOptions = {},
): Promise<OutsideMergeStats> {
  const connect = opts.connect ?? (() => mysql.createConnection(replicaConnConfig("wikidatawiki")));
  const started = Date.now();
  const qids = [...(await collectOpenQids())];
  console.log(`outside merges: ${qids.length} items on open candidates`);

  let fates: ItemFate[] = [];
  if (qids.length > 0) {
    const conn = await connect();
    try {
      fates = await lookUpFates(conn, qids);
    } finally {
      await conn.end().catch(() => {});
    }
  }

  const redirects = fates.filter((f) => !("deleted" in f)).length;
  const deleted = fates.length - redirects;
  const deletionsSkipped =
    deleted > MISSING_GUARD_MIN && deleted > qids.length * MISSING_GUARD_FRACTION;
  if (deletionsSkipped) {
    console.warn(
      `outside merges: NOT settling ${deleted} of ${qids.length} items with no page on the ` +
        `replica — too many to be real deletions; the next import's prune will catch any that are`,
    );
    fates = fates.filter((f) => !("deleted" in f));
  }

  const byQid = new Map(fates.map((f) => [f.qid, f]));
  let settled = 0;
  for (const batch of chunk([...byQid.keys()], SETTLE_CHUNK)) {
    settled += await settle(batch, byQid);
  }

  console.log(
    `outside merges: done in ${Math.round((Date.now() - started) / 1000)}s: ` +
      `${redirects} redirects, ${deleted} deleted${deletionsSkipped ? " (skipped)" : ""}, ` +
      `${settled} candidates settled`,
  );
  return { items: qids.length, redirects, deleted, deletionsSkipped, settled };
}
