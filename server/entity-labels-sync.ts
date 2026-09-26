// Server-side write path for the Wikidata entity-label sync, run by the
// scheduled job (jobs/sync-entity-labels.ts).
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { entityLabels, items } from "../db/schema.ts";
import { fetchEntityLabels, type EntityLabelRow } from "../src/lib/sparql.ts";

const ROWS_PER_STMT = 1000;
/** Items scanned per DB page when collecting referenced QIDs (keyset-paged). */
const READ_PAGE = 5000;
/** Log scan progress every this many pages. */
const LOG_EVERY_PAGES = 20;

/**
 * Collect the distinct item-valued statement QIDs referenced across every synced
 * item (genre, platform, developer, instance of, …) — the entities the
 * comparison view shows by name, and exactly the set the entity-label lookup
 * needs. We enumerate them from our own `items` rather than asking Wikidata to
 * derive the set, because the derive-it query (`?game ?claim ?v`) reliably times
 * out on QLever. Keyset pagination over the `qid` primary key keeps this O(n).
 *
 * MariaDB pulls the values out of `data` itself (JSON_TABLE), so only each
 * page's distinct QIDs cross the wire — not the whole item, whose terms and
 * sitelinks in every language dwarf the statements for a dump-imported item.
 */
export async function collectReferencedItemQids(pageSize = READ_PAGE): Promise<string[]> {
  const started = Date.now();
  const [[{ total }]] = (await db.execute(
    sql`select count(*) as total from ${items}`,
  )) as unknown as [{ total: number }[]];
  const set = new Set<string>();
  let after = "";
  let scanned = 0;
  for (let page = 1; ; page++) {
    // The page's last qid, or none when fewer than `pageSize` rows remain.
    const [bounds] = (await db.execute(sql`
      select qid from ${items} where qid > ${after}
      order by qid limit 1 offset ${pageSize - 1}`)) as unknown as [{ qid: string }[]];
    const bound = bounds[0]?.qid;
    const [rows] = (await db.execute(sql`
      select distinct jt.qid from ${items} i,
        json_table(i.data, '$.statements.*[*]' columns (
          type varchar(16) path '$.type',
          qid varchar(32) path '$.value'
        )) jt
      where i.qid > ${after} ${bound === undefined ? sql`` : sql`and i.qid <= ${bound}`}
        and jt.type = 'item'`)) as unknown as [{ qid: string }[]];
    for (const row of rows) set.add(row.qid);
    if (bound === undefined) break;
    after = bound;
    scanned += pageSize;
    if (page % LOG_EVERY_PAGES === 0) {
      console.log(
        `entity labels: scanned ${scanned}/${total} items, ${set.size} referenced QIDs, ${elapsed(started)} elapsed`,
      );
    }
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

export interface EntityLabelsSyncResult {
  /** Labels upserted. */
  synced: number;
  /** Referenced QIDs whose lookup failed even after retries (left as they were). */
  failed: number;
}

/**
 * Full entity-label sync: enumerate the referenced value-QIDs from our items,
 * look their en/mul labels up on QLever, and upsert each chunk as it arrives —
 * so a run that dies partway keeps what it fetched, and QIDs QLever keeps
 * failing on are skipped (reported in `failed`) instead of sinking the run.
 * Throws only when nothing could be fetched at all, or on a DB error.
 */
export async function runEntityLabelsSync(): Promise<EntityLabelsSyncResult> {
  const started = Date.now();
  const qids = await collectReferencedItemQids();
  console.log(`entity labels: ${qids.length} referenced QIDs collected in ${elapsed(started)}`);

  const lookupStarted = Date.now();
  let synced = 0;
  const { failedQids } = await fetchEntityLabels(
    qids,
    async (rows) => {
      synced += await syncEntityLabels(rows);
    },
    {
      onProgress: ({ done, total, fetched, failed }) => {
        const pct = ((done / total) * 100).toFixed(1);
        const ms = Date.now() - lookupStarted;
        const eta = done < total ? `, ~${seconds((ms / done) * (total - done))} left` : "";
        const skipped = failed > 0 ? `, ${failed} skipped` : "";
        console.log(
          `entity labels: ${done}/${total} QIDs (${pct}%), ${fetched} labels written${skipped}, ${seconds(ms)} elapsed${eta}`,
        );
      },
    },
  );
  if (failedQids.length > 0 && synced === 0) {
    throw new Error(`Entity-label lookup failed for all ${failedQids.length} referenced QIDs`);
  }
  console.log(
    `entity labels: done in ${elapsed(started)}: ${synced} labels written, ${failedQids.length} QIDs skipped`,
  );
  return { synced, failed: failedQids.length };
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;
const elapsed = (since: number): string => seconds(Date.now() - since);
