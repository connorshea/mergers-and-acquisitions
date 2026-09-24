// Each merge_candidates row carries a copy of both items' primaryType and
// primaryLabel (from_type/into_type, from_label/into_label) so the candidates
// list can filter by type or search labels with an index range on the pairs
// alone. Joining `items` instead meant walking every item of the type (or every
// label in the mirror) to find a few thousand pairs: ~0.4s for a type, ~2s for
// a search against a million-item mirror.
//
// The hunt writes the copies when it upserts a pair; this refresh brings
// existing pairs back in line after items change (a dump import relabels or
// retypes them). A pair whose item has left the mirror keeps its last-known
// values, so merged pairs stay searchable.
import { sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import type * as schema from "../db/schema.ts";

/**
 * Re-copy primaryType/primaryLabel from `items` onto every candidate whose
 * copy differs. One UPDATE per side, touching only changed rows; returns the
 * number of rows changed (a pair with both sides stale counts twice).
 */
export async function refreshCandidateItemInfo(db: MySql2Database<typeof schema>): Promise<number> {
  let changed = 0;
  for (const side of ["from", "into"] as const) {
    const qid = sql.raw(`c.${side}_qid`);
    const type = sql.raw(`c.${side}_type`);
    const label = sql.raw(`c.${side}_label`);
    const [res] = await db.execute(sql`
      update merge_candidates c join items i on i.qid = ${qid}
      set ${type} = i.primary_type, ${label} = i.primary_label
      where not (${type} <=> i.primary_type and ${label} <=> i.primary_label)`);
    changed += (res as { affectedRows: number }).affectedRows;
  }
  return changed;
}
