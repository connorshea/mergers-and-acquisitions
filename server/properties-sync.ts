// Shared server-side write path for the Wikidata property-label sync, used by
// both the manual route (routes/api/properties/sync.ts) and the scheduled cron
// (crons/sync-properties.ts). Lives under server/ (not src/lib) so it can import
// void/db without pulling server code into the client bundle.
import { db, sql } from "void/db";
import { properties } from "@schema";
import type { PropertyRow } from "../src/lib/sparql";

// D1 caps bound parameters at 100 per statement (lower than SQLite's own limit),
// so with 3 columns per row an INSERT can carry at most ~33 rows. Stay under
// that, then group the statements into db.batch() calls so the whole sync is a
// handful of round-trips rather than hundreds of separate subrequests.
const ROWS_PER_STMT = 30; // 30 × 3 cols = 90 bound params, under D1's 100 cap
const STMTS_PER_BATCH = 20;

/** Upsert fetched property rows, refreshing label/datatype/syncedAt. */
export async function syncProperties(rows: PropertyRow[]): Promise<number> {
  const statements = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT).map((r) => ({
      pid: r.pid,
      label: r.label,
      datatype: r.datatype,
    }));
    if (chunk.length === 0) continue;
    statements.push(
      db
        .insert(properties)
        .values(chunk)
        .onConflictDoUpdate({
          target: properties.pid,
          set: {
            label: sql`excluded.label`,
            datatype: sql`excluded.datatype`,
            syncedAt: sql`(datetime('now'))`,
          },
        }),
    );
  }

  type Stmt = (typeof statements)[number];
  for (let i = 0; i < statements.length; i += STMTS_PER_BATCH) {
    const group = statements.slice(i, i + STMTS_PER_BATCH);
    if (group.length === 0) continue;
    // db.batch wants a non-empty tuple; the slice is guaranteed non-empty here.
    await db.batch(group as [Stmt, ...Stmt[]]);
  }
  return rows.length;
}
