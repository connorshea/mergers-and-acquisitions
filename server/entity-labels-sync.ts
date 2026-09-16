// Shared server-side write path for the Wikidata entity-label sync, used by both
// the manual route (routes/api/entity-labels/sync.ts) and the scheduled cron
// (crons/sync-entity-labels.ts). Lives under server/ (not src/lib) so it can
// import void/db without pulling server code into the client bundle.
import { db, sql } from "void/db";
import { entityLabels } from "@schema";
import type { EntityLabelRow } from "../src/lib/sparql";

// D1 caps bound parameters at 100 per statement. With 2 columns per row an
// INSERT can carry up to 50 rows; stay under that, then group the statements
// into db.batch() calls so the sync is a handful of round-trips, not hundreds.
const ROWS_PER_STMT = 45; // 45 × 2 cols = 90 bound params, under D1's 100 cap
const STMTS_PER_BATCH = 20;

/** Upsert fetched entity-label rows, refreshing label/syncedAt. */
export async function syncEntityLabels(rows: EntityLabelRow[]): Promise<number> {
  const statements = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT).map((r) => ({ qid: r.qid, label: r.label }));
    if (chunk.length === 0) continue;
    statements.push(
      db
        .insert(entityLabels)
        .values(chunk)
        .onConflictDoUpdate({
          target: entityLabels.qid,
          set: { label: sql`excluded.label`, syncedAt: sql`(datetime('now'))` },
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
