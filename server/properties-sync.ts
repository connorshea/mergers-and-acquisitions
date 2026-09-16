// Shared server-side write path for the Wikidata property-label sync, used by
// both the manual route (routes/api/properties/sync.ts) and the scheduled cron
// (crons/sync-properties.ts). Lives under server/ (not src/lib) so it can import
// void/db without pulling server code into the client bundle.
import { db, sql } from "void/db";
import { properties } from "@schema";
import type { PropertyRow } from "../src/lib/sparql";

// properties has 4 columns; keep each INSERT under SQLite's bound-parameter cap.
const BATCH = 200;

/** Upsert fetched property rows, refreshing label/datatype/syncedAt. */
export async function syncProperties(rows: PropertyRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map((r) => ({
      pid: r.pid,
      label: r.label,
      datatype: r.datatype,
    }));
    if (chunk.length === 0) continue;
    await db
      .insert(properties)
      .values(chunk)
      .onConflictDoUpdate({
        target: properties.pid,
        set: {
          label: sql`excluded.label`,
          datatype: sql`excluded.datatype`,
          syncedAt: sql`(datetime('now'))`,
        },
      });
  }
  return rows.length;
}
