// Server-side write path for the Wikidata entity-label sync, run by the
// scheduled job (jobs/sync-entity-labels.ts).
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { entityLabels, items } from "../db/schema.ts";
import { chunk } from "../src/lib/chunk.ts";
import { fetchEntityLabels, type EntityLabelRow } from "../src/lib/sparql.ts";

const ROWS_PER_STMT = 1000;
/** Items scanned per DB page when collecting referenced QIDs (keyset-paged). */
const READ_PAGE = 5000;
/** Log scan progress every this many pages. */
const LOG_EVERY_PAGES = 20;
/** Referenced QIDs checked against the mirror per query. */
const MIRROR_CHUNK = 5000;
/** Log mirror progress every this many chunks. */
const LOG_EVERY_CHUNKS = 50;
/**
 * Pages (and mirror chunks) in flight at once. Each is one read on its own
 * pooled connection (DB_POOL, default 5), so this stays under the pool size.
 */
const CONCURRENCY = 4;
/**
 * A QID's QLever label is looked up again once it is this many days old plus
 * a per-QID offset of up to 27 more (from its CRC32). The offset spreads the
 * refreshes across weekly runs instead of every label going stale in the same
 * week, so each run re-fetches roughly a quarter to a third of them.
 */
const LABEL_MIN_AGE_DAYS = 6;
const LABEL_AGE_SPREAD_DAYS = 28;

/** Run `work` over `inputs` with at most `limit` calls in flight. */
async function eachConcurrently<T>(
  inputs: T[],
  limit: number,
  work: (input: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < inputs.length) await work(inputs[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
}

/**
 * Collect the distinct item-valued statement QIDs referenced across every synced
 * item (genre, platform, developer, instance of, …), plus quantity units
 * (minute, gigabyte, …) — the entities the comparison view shows by name, and exactly the set the entity-label lookup
 * needs. We enumerate them from our own `items` rather than asking Wikidata to
 * derive the set, because the derive-it query (`?game ?claim ?v`) reliably times
 * out on QLever.
 *
 * One pass over the `qid` primary key finds every page's upper bound up front,
 * so the pages (keyset ranges, keeping this O(n)) can then be scanned
 * CONCURRENCY at a time. MariaDB pulls the values out of `data` itself
 * (JSON_TABLE), so only each page's distinct QIDs cross the wire — not the
 * whole item, whose terms and sitelinks in every language dwarf the statements
 * for a dump-imported item.
 */
export async function collectReferencedItemQids(pageSize = READ_PAGE): Promise<string[]> {
  const started = Date.now();
  const [[{ total }]] = (await db.execute(
    sql`select count(*) as total from ${items}`,
  )) as unknown as [{ total: number }[]];
  // Every pageSize-th qid closes a page; the rows after the last one form a
  // final, open-ended page.
  const [boundRows] = (await db.execute(sql`
    select qid from (
      select qid, row_number() over (order by qid) as n from ${items}
    ) numbered where n % ${pageSize} = 0 order by qid`)) as unknown as [{ qid: string }[]];
  const bounds = boundRows.map((r) => r.qid);
  const pages = [...bounds, undefined].map((bound, i) => ({ after: bounds[i - 1] ?? "", bound }));

  const set = new Set<string>();
  let done = 0;
  await eachConcurrently(pages, CONCURRENCY, async ({ after, bound }) => {
    const [rows] = (await db.execute(sql`
      select distinct if(jt.type = 'item', jt.qid, jt.unit) as qid from ${items} i,
        json_table(i.data, '$.statements.*[*]' columns (
          type varchar(16) path '$.type',
          qid varchar(32) path '$.value',
          unit varchar(32) path '$.unit'
        )) jt
      where i.qid > ${after} ${bound === undefined ? sql`` : sql`and i.qid <= ${bound}`}
        and (jt.type = 'item' or jt.unit is not null)`)) as unknown as [{ qid: string }[]];
    for (const row of rows) set.add(row.qid);
    if (++done % LOG_EVERY_PAGES === 0) {
      console.log(
        `entity labels: scanned ${Math.min(done * pageSize, total)}/${total} items, ${set.size} referenced QIDs, ${elapsed(started)} elapsed`,
      );
    }
  });
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

/** Referenced QIDs split by where their label comes from. */
export interface MirrorLabels {
  /** Labels of mirrored items, written by labelsFromMirror. */
  written: number;
  /** Mirrored items whose stored label already matched (left untouched). */
  unchanged: number;
  /** Referenced items in `items` with neither an en nor a mul label. */
  unlabeled: number;
  /** QIDs not in `items` whose QLever label is recent enough to keep. */
  fresh: number;
  /** QIDs not in `items` to look up on QLever: never labeled, or due a refresh. */
  missing: string[];
}

/**
 * Take the labels of referenced QIDs that are mirrored items straight from
 * their `data` — the dump import just wrote them — and write the ones that
 * changed, so a weekly run doesn't rewrite millions of identical rows. Same
 * rule as the QLever lookup: en, else mul. A mirrored item with neither has no
 * label QLever would return either, so it isn't looked up. Of the rest, only
 * the QIDs never labeled or due a refresh (see LABEL_MIN_AGE_DAYS) go to
 * QLever.
 */
export async function labelsFromMirror(qids: string[]): Promise<MirrorLabels> {
  const started = Date.now();
  const result: MirrorLabels = { written: 0, unchanged: 0, unlabeled: 0, fresh: 0, missing: [] };
  const chunks = chunk(qids, MIRROR_CHUNK);
  let done = 0;
  await eachConcurrently(chunks, CONCURRENCY, async (ids) => {
    const [found] = (await db.execute(sql`
      select qid, coalesce(
        nullif(json_value(data, '$.labels.en'), ''),
        nullif(json_value(data, '$.labels.mul'), '')
      ) as label
      from ${items} where qid in ${ids}`)) as unknown as [{ qid: string; label: string | null }[]];
    const [stored] = (await db.execute(sql`
      select qid, label,
        synced_at >= now() - interval (${LABEL_MIN_AGE_DAYS} + crc32(qid) % ${LABEL_AGE_SPREAD_DAYS}) day as fresh
      from ${entityLabels} where qid in ${ids}`)) as unknown as [
      { qid: string; label: string; fresh: number }[],
    ];
    const existing = new Map(stored.map((r) => [r.qid, r]));
    const mirrored = new Set<string>();
    const changed: EntityLabelRow[] = [];
    for (const { qid, label } of found) {
      mirrored.add(qid);
      if (label === null) result.unlabeled++;
      else if (existing.get(qid)?.label === label) result.unchanged++;
      else changed.push({ qid, label });
    }
    for (const qid of ids) {
      if (mirrored.has(qid)) continue;
      if (existing.get(qid)?.fresh) result.fresh++;
      else result.missing.push(qid);
    }
    result.written += await syncEntityLabels(changed);
    if (++done % LOG_EVERY_CHUNKS === 0) {
      console.log(
        `entity labels: checked ${Math.min(done * MIRROR_CHUNK, qids.length)}/${qids.length} QIDs against the mirror, ` +
          `${result.written} labels written, ${elapsed(started)} elapsed`,
      );
    }
  });
  return result;
}

/**
 * Full entity-label sync: enumerate the referenced value-QIDs from our items,
 * take the labels of those that are mirrored items from the mirror, look the
 * rest's en/mul labels up on QLever (those not refreshed recently), and upsert
 * each chunk as it arrives —
 * so a run that dies partway keeps what it fetched, and QIDs QLever keeps
 * failing on are skipped (reported in `failed`) instead of sinking the run.
 * Throws only when nothing could be fetched at all, or on a DB error.
 */
export async function runEntityLabelsSync(): Promise<EntityLabelsSyncResult> {
  const started = Date.now();
  const qids = await collectReferencedItemQids();
  console.log(`entity labels: ${qids.length} referenced QIDs collected in ${elapsed(started)}`);

  const mirrorStarted = Date.now();
  const mirror = await labelsFromMirror(qids);
  let synced = mirror.written;
  console.log(
    `entity labels: ${mirror.written} labels written from the mirror, ${mirror.unchanged} unchanged ` +
      `(${mirror.unlabeled} mirrored items have no en/mul label) in ${elapsed(mirrorStarted)}; ` +
      `${mirror.fresh} QLever labels still fresh, ${mirror.missing.length} QIDs left to look up`,
  );

  const lookupStarted = Date.now();
  const { failedQids } = await fetchEntityLabels(
    mirror.missing,
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
  if (failedQids.length > 0 && synced + mirror.unchanged === 0) {
    throw new Error(`Entity-label lookup failed for all ${failedQids.length} referenced QIDs`);
  }
  console.log(
    `entity labels: done in ${elapsed(started)}: ${synced} labels written, ${failedQids.length} QIDs skipped`,
  );
  return { synced, failed: failedQids.length };
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;
const elapsed = (since: number): string => seconds(Date.now() - since);
