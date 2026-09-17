// Shared server-side write path for the Wikidata entity-label sync, used by both
// the manual route (server/sync-routes.ts) and the scheduled job
// (jobs/sync-entity-labels.ts).
import { asc, gt, sql } from "drizzle-orm";
import { db } from "./db";
import { entityLabels, items } from "../db/schema";
import type { Item } from "../src/lib/compare";
import { referencedItemQids } from "../src/lib/wikidata";
import { fetchEntityLabels, type EntityLabelRow } from "../src/lib/sparql";

const ROWS_PER_STMT = 1000;
/** Items scanned per DB page when collecting referenced QIDs (keyset-paged). */
const READ_PAGE = 5000;

/**
 * Collect the distinct item-valued statement QIDs referenced across every synced
 * game (genre, platform, developer, instance of, …) — the entities the
 * comparison view shows by name, and exactly the set the entity-label lookup
 * needs. We enumerate them from our own `items` rather than asking Wikidata to
 * derive the set, because the derive-it query (`?game ?claim ?v`) reliably times
 * out on QLever. Keyset pagination over the `qid` primary key keeps this O(n).
 */
async function collectReferencedItemQids(): Promise<string[]> {
  const set = new Set<string>();
  let after = "";
  for (;;) {
    const batch = await db
      .select({ qid: items.qid, data: items.data })
      .from(items)
      .where(after ? gt(items.qid, after) : sql`1 = 1`)
      .orderBy(asc(items.qid))
      .limit(READ_PAGE);
    if (batch.length === 0) break;
    for (const row of batch) {
      for (const qid of referencedItemQids(row.data as Item)) set.add(qid);
    }
    after = batch[batch.length - 1].qid;
    if (batch.length < READ_PAGE) break;
  }
  return [...set];
}

/** Upsert fetched entity-label rows, refreshing label/syncedAt. */
export async function syncEntityLabels(rows: EntityLabelRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT).map((r) => ({ qid: r.qid, label: r.label }));
    if (chunk.length === 0) continue;
    await db
      .insert(entityLabels)
      .values(chunk)
      .onDuplicateKeyUpdate({
        set: {
          label: sql`values(${entityLabels.label})`,
          syncedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  }
  return rows.length;
}

/**
 * Full entity-label sync: enumerate the referenced value-QIDs from our items,
 * look their en/mul labels up on QLever, and upsert. Returns the number of
 * labels written.
 */
export async function runEntityLabelsSync(): Promise<number> {
  const qids = await collectReferencedItemQids();
  const rows = await fetchEntityLabels(qids);
  return syncEntityLabels(rows);
}
