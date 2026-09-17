// Shared server-side write path for the Wikidata game-description sync, used by
// both the manual route (server/sync-routes.ts) and the scheduled job
// (jobs/sync-descriptions.ts).
import { asc, gt, sql } from "drizzle-orm";
import { db } from "./db";
import { itemDescriptions, items } from "../db/schema";
import { fetchDescriptions, type GameDescriptionRow } from "../src/lib/sparql";

const ROWS_PER_STMT = 1000;
/** Items scanned per DB page when collecting QIDs (keyset-paged over the PK). */
const READ_PAGE = 10000;

/**
 * Collect every synced item's QID. Descriptions are keyed by the item itself, so
 * — unlike the entity-label sync — no JSON parsing is needed; we just page the
 * `qid` primary key. Enumerating from our own `items` (rather than re-deriving
 * the P31-scoped set on Wikidata) keeps this O(n) and scales with whatever the
 * item scope becomes.
 */
async function collectItemQids(): Promise<string[]> {
  const qids: string[] = [];
  let after = "";
  for (;;) {
    const batch = await db
      .select({ qid: items.qid })
      .from(items)
      .where(after ? gt(items.qid, after) : sql`1 = 1`)
      .orderBy(asc(items.qid))
      .limit(READ_PAGE);
    if (batch.length === 0) break;
    for (const r of batch) qids.push(r.qid);
    after = batch[batch.length - 1].qid;
    if (batch.length < READ_PAGE) break;
  }
  return qids;
}

/** Upsert fetched game-description rows, refreshing description/syncedAt. */
export async function syncGameDescriptions(rows: GameDescriptionRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows
      .slice(i, i + ROWS_PER_STMT)
      .map((r) => ({ qid: r.qid, description: r.description }));
    if (chunk.length === 0) continue;
    await db
      .insert(itemDescriptions)
      .values(chunk)
      .onDuplicateKeyUpdate({
        set: {
          description: sql`values(${itemDescriptions.description})`,
          syncedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  }
  return rows.length;
}

/**
 * Full description sync: enumerate our item QIDs, fetch their English
 * descriptions from QLever, and upsert. Returns the number written.
 */
export async function runDescriptionsSync(): Promise<number> {
  const qids = await collectItemQids();
  const rows = await fetchDescriptions(qids);
  return syncGameDescriptions(rows);
}
