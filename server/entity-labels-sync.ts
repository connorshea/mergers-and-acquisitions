// Shared server-side write path for the Wikidata entity-label sync, used by both
// the manual route (server/sync-routes.ts) and the scheduled job
// (jobs/sync-entity-labels.ts).
import { sql } from "drizzle-orm";
import { db } from "./db";
import { entityLabels } from "../db/schema";
import type { EntityLabelRow } from "../src/lib/sparql";

const ROWS_PER_STMT = 1000;

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
