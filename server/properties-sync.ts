// Server-side write path for the Wikidata property-label sync, run by the
// scheduled job (jobs/sync-properties.ts).
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { properties } from "../db/schema.ts";
import type { PropertyRow } from "../src/lib/sparql.ts";

// MariaDB allows tens of thousands of bound params per statement, so batch
// generously — a handful of round-trips rather than the ~25-row statements D1's
// 100-param cap forced.
const ROWS_PER_STMT = 500;

/** Upsert fetched property rows, refreshing label/datatype/formatterUrl/syncedAt. */
export async function syncProperties(rows: PropertyRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT).map((r) => ({
      pid: r.pid,
      label: r.label,
      datatype: r.datatype,
      formatterUrl: r.formatterUrl,
      mirrorsWikidata: r.mirrorsWikidata,
    }));
    if (chunk.length === 0) continue;
    await db
      .insert(properties)
      .values(chunk)
      .onDuplicateKeyUpdate({
        set: {
          label: sql`values(${properties.label})`,
          datatype: sql`values(${properties.datatype})`,
          formatterUrl: sql`values(${properties.formatterUrl})`,
          mirrorsWikidata: sql`values(${properties.mirrorsWikidata})`,
          syncedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  }
  return rows.length;
}
