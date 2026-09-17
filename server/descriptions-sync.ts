// Shared server-side write path for the Wikidata game-description sync, used by
// both the manual route (server/sync-routes.ts) and the scheduled job
// (jobs/sync-descriptions.ts).
import { sql } from "drizzle-orm";
import { db } from "./db";
import { itemDescriptions } from "../db/schema";
import type { GameDescriptionRow } from "../src/lib/sparql";

const ROWS_PER_STMT = 1000;

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
