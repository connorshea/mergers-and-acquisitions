// Server-side write path for `class_ancestors`, rebuilt after the property
// sync by the scheduled job (jobs/sync-properties.ts); the hunt reads it.
// Together with `properties.subject_types` it lets the scorer tell
// whether a subject type constraint on a superclass covers an item's class
// (see src/lib/subject-types.ts).
import { inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { classAncestors, items, itemValues } from "../db/schema.ts";
import { chunk } from "../src/lib/chunk.ts";
import { fetchClassAncestors } from "../src/lib/sparql.ts";
import { ITEM_VALUE_PROPS } from "../src/lib/wikidata.ts";
import { elapsed, progress } from "./progress.ts";

const ROWS_PER_STMT = 1000;
/** Log QLever lookup progress every this many chunks. */
const LOG_EVERY_CHUNKS = 10;

/**
 * The distinct item values of the given properties across every synced item,
 * from `item_values` (written by the dump import for ITEM_VALUE_PROPS, which
 * must include `pids`). Throws when the table is empty but the mirror isn't,
 * as it is between the migration that adds it and the first import that fills
 * it: an empty list would have the syncs drop every row they keep.
 */
export async function collectItemValues(pids: readonly string[]): Promise<string[]> {
  const missing = pids.filter((pid) => !ITEM_VALUE_PROPS.has(pid));
  if (missing.length > 0) throw new Error(`Not in ITEM_VALUE_PROPS: ${missing.join(", ")}`);
  const rows = await db
    .selectDistinct({ value: itemValues.value })
    .from(itemValues)
    .where(inArray(itemValues.property, [...pids]));
  if (rows.length === 0) {
    const [anyValue] = await db.select({ qid: itemValues.qid }).from(itemValues).limit(1);
    const [anyItem] = await db.select({ qid: items.qid }).from(items).limit(1);
    if (!anyValue && anyItem) {
      throw new Error("item_values is empty; run the dump import to fill it");
    }
  }
  return rows.map((r) => r.value);
}

/** The distinct instance of (P31) and subclass of (P279) values across every synced item. */
export function collectItemClasses(): Promise<string[]> {
  return collectItemValues(["P31", "P279"]);
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
