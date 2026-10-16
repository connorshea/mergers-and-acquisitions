// Server-side write path for `place_ancestors`, rebuilt weekly after the dump
// import by the scheduled job (jobs/sync-place-ancestors.ts); the hunt and
// the candidate detail API read it. It lets the comparison read a place and
// the place containing it (Akasaka vs. Tokyo) as one place at two levels of
// detail (see src/lib/places.ts).
import { inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { placeAncestors } from "../db/schema.ts";
import { chunk } from "../src/lib/chunk.ts";
import { PLACE_PROPS } from "../src/lib/places.ts";
import { fetchPlaceAncestors } from "../src/lib/sparql.ts";
import { collectItemValues } from "./class-ancestors.ts";
import { elapsed, progress } from "./progress.ts";

const ROWS_PER_STMT = 1000;
/** Log QLever lookup progress every this many chunks. */
const LOG_EVERY_CHUNKS = 20;

/** The distinct place values (PLACE_PROPS) across every synced item. */
export function collectItemPlaces(pageSize?: number): Promise<string[]> {
  return collectItemValues([...PLACE_PROPS], "place ancestors", pageSize);
}

export interface PlaceAncestorsSyncResult {
  /** Places looked up (with or without ancestors). */
  places: number;
  /** Rows written. */
  rows: number;
  /** Places whose lookup failed; any rows they had are kept. */
  failed: number;
}

/**
 * Rebuild `place_ancestors` for our items' current place values: look each up
 * on QLever, then in one transaction replace the rows of every place looked
 * up and drop those of places no item names any more. A place whose lookup
 * failed keeps last week's rows (or stays unknown, which compares as before).
 */
export async function syncPlaceAncestors(): Promise<PlaceAncestorsSyncResult> {
  const started = Date.now();
  const places = await collectItemPlaces();
  console.log(`place ancestors: ${places.length} places collected in ${elapsed(started)}`);
  const lookupStarted = Date.now();
  let chunks = 0;
  const { ancestors, failed } = await fetchPlaceAncestors(places, {
    onProgress: (done, total) => {
      if (++chunks % LOG_EVERY_CHUNKS === 0 || done === total) {
        console.log(
          `place ancestors: looked up ${progress(done, total)} places, ${elapsed(lookupStarted)} elapsed`,
        );
      }
    },
  });
  if (failed.length === places.length && places.length > 0) {
    throw new Error(`Place-ancestor lookup failed for all ${places.length} places`);
  }
  const keep = new Set(failed);
  const rows = [...ancestors].flatMap(([qid, list]) =>
    list.map(({ ancestor, country }) => ({ qid, ancestor, country })),
  );
  console.log(
    `place ancestors: ${ancestors.size} places with ancestors (${rows.length} rows) in ` +
      `${elapsed(lookupStarted)}, ${failed.length} failed`,
  );
  const writeStarted = Date.now();
  await db.transaction(async (tx) => {
    const existing = await tx.selectDistinct({ qid: placeAncestors.qid }).from(placeAncestors);
    const stale = existing.map((r) => r.qid).filter((qid) => !keep.has(qid));
    for (const ids of chunk(stale, ROWS_PER_STMT)) {
      await tx.delete(placeAncestors).where(inArray(placeAncestors.qid, ids));
    }
    for (const values of chunk(rows, ROWS_PER_STMT)) {
      await tx.insert(placeAncestors).values(values);
    }
  });
  console.log(`place ancestors: rows replaced in ${elapsed(writeStarted)}`);
  return { places: places.length - failed.length, rows: rows.length, failed: failed.length };
}

/** The `place_ancestors` rows of the given places. */
export async function loadPlaceAncestors(
  qids: readonly string[],
): Promise<(typeof placeAncestors.$inferSelect)[]> {
  const chunks = await Promise.all(
    chunk([...new Set(qids)], ROWS_PER_STMT).map((ids) =>
      db.select().from(placeAncestors).where(inArray(placeAncestors.qid, ids)),
    ),
  );
  return chunks.flat();
}
