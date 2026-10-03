// Server-side write path for `class_ancestors`, rebuilt after the property
// sync by the scheduled job (jobs/sync-properties.ts); the hunt reads it.
// Together with `properties.subject_types` it lets the scorer tell
// whether a subject type constraint on a superclass covers an item's class
// (see src/lib/subject-types.ts).
import { inArray, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { classAncestors, items } from "../db/schema.ts";
import { chunk } from "../src/lib/chunk.ts";
import { fetchClassAncestors } from "../src/lib/sparql.ts";
import { elapsed, progress } from "./progress.ts";

/** Items scanned per DB page when collecting their classes (keyset-paged). */
const READ_PAGE = 5000;
const ROWS_PER_STMT = 1000;
/** Log scan progress every this many pages. */
const LOG_EVERY_PAGES = 20;
/** Log QLever lookup progress every this many chunks. */
const LOG_EVERY_CHUNKS = 10;

/**
 * The distinct instance of (P31) and subclass of (P279) values across every
 * synced item. MariaDB pulls them out of `data` itself (JSON_TABLE), so only
 * each page's distinct classes cross the wire. Keyset pagination over the
 * `qid` primary key keeps this O(n).
 */
export async function collectItemClasses(pageSize = READ_PAGE): Promise<string[]> {
  const started = Date.now();
  const [[{ total }]] = (await db.execute(
    sql`select count(*) as total from ${items}`,
  )) as unknown as [{ total: number }[]];
  const set = new Set<string>();
  let after = "";
  for (let page = 1; ; page++) {
    // The page's last qid, or none when fewer than `pageSize` rows remain.
    const [bounds] = (await db.execute(sql`
      select qid from ${items} where qid > ${after}
      order by qid limit 1 offset ${pageSize - 1}`)) as unknown as [{ qid: string }[]];
    const bound = bounds[0]?.qid;
    const range = sql`i.qid > ${after} ${bound === undefined ? sql`` : sql`and i.qid <= ${bound}`}`;
    const classes = (path: string) => sql`
      select jt.qid from ${items} i,
        json_table(i.data, ${path} columns (
          type varchar(16) path '$.type',
          qid varchar(32) path '$.value'
        )) jt
      where ${range} and jt.type = 'item'`;
    const [rows] = (await db.execute(sql`
      ${classes("$.statements.P31[*]")} union
      ${classes("$.statements.P279[*]")}`)) as unknown as [{ qid: string }[]];
    for (const row of rows) set.add(row.qid);
    if (bound === undefined) break;
    after = bound;
    if (page % LOG_EVERY_PAGES === 0) {
      console.log(
        `class ancestors: scanned ${progress(page * pageSize, total)} items, ${set.size} classes, ${elapsed(started)} elapsed`,
      );
    }
  }
  return [...set];
}

export interface ClassAncestorsSyncResult {
  /** Classes looked up and written. */
  classes: number;
  /** Rows written. */
  rows: number;
  /** Classes whose lookup failed; any rows they had are kept. */
  failed: number;
}

/**
 * Rebuild `class_ancestors` for our items' current classes: look each up on
 * QLever, then in one transaction replace the rows of every class looked up
 * and drop those of classes no item has any more. A class whose lookup failed
 * keeps last week's rows (or stays unknown), so a flaky run never makes the
 * constraint check stricter than it was.
 */
export async function syncClassAncestors(): Promise<ClassAncestorsSyncResult> {
  const started = Date.now();
  const classes = await collectItemClasses();
  console.log(`class ancestors: ${classes.length} item classes collected in ${elapsed(started)}`);
  const lookupStarted = Date.now();
  let chunks = 0;
  const { ancestors, failed } = await fetchClassAncestors(classes, {
    onProgress: (done, total) => {
      if (++chunks % LOG_EVERY_CHUNKS === 0 || done === total) {
        console.log(
          `class ancestors: looked up ${progress(done, total)} classes, ${elapsed(lookupStarted)} elapsed`,
        );
      }
    },
  });
  if (ancestors.size === 0 && classes.length > 0) {
    throw new Error(`Class-ancestor lookup failed for all ${classes.length} classes`);
  }
  const keep = new Set(failed);
  const rows = [...ancestors].flatMap(([cls, list]) =>
    list.map((ancestor) => ({ class: cls, ancestor })),
  );
  console.log(
    `class ancestors: ${ancestors.size} classes looked up (${rows.length} rows) in ` +
      `${elapsed(lookupStarted)}, ${failed.length} failed`,
  );
  const writeStarted = Date.now();
  console.log(`class ancestors: replacing class_ancestors rows`);
  await db.transaction(async (tx) => {
    const existing = await tx.selectDistinct({ cls: classAncestors.class }).from(classAncestors);
    const stale = existing.map((r) => r.cls).filter((cls) => !keep.has(cls));
    for (const ids of chunk(stale, ROWS_PER_STMT)) {
      await tx.delete(classAncestors).where(inArray(classAncestors.class, ids));
    }
    for (const values of chunk(rows, ROWS_PER_STMT)) {
      await tx.insert(classAncestors).values(values);
    }
  });
  console.log(`class ancestors: rows replaced in ${elapsed(writeStarted)}`);
  return { classes: ancestors.size, rows: rows.length, failed: failed.length };
}
