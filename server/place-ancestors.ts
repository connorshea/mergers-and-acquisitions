// Server-side write path for `place_ancestors`, rebuilt weekly after the dump
// import by the scheduled job (jobs/sync-place-ancestors.ts); the hunt and
// the candidate detail API read it. It lets the comparison read a place and
// the place containing it (Akasaka vs. Tokyo) as one place at two levels of
// detail (see src/lib/places.ts).
import { gt, inArray } from "drizzle-orm";
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
export function collectItemPlaces(): Promise<string[]> {
  return collectItemValues([...PLACE_PROPS]);
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
 * on QLever and replace its rows as its chunk comes back (one transaction per
 * chunk, so a reader never sees a place half-written), then drop the rows of
 * places no item names any more. A place whose lookup failed keeps last
 * week's rows (or stays unknown, which compares as before).
 *
 * Only one chunk's ancestors are held at a time: the table runs to millions
 * of rows, which held at once (and copied into insert rows) would crowd the
 * job's heap, and written in one transaction would hold Trove's undo log
 * for the whole write.
 */
export async function syncPlaceAncestors(): Promise<PlaceAncestorsSyncResult> {
  const started = Date.now();
  const places = await collectItemPlaces();
  console.log(`place ancestors: ${places.length} places collected in ${elapsed(started)}`);
  const lookupStarted = Date.now();
  let chunks = 0;
  let rows = 0;
  const { failed } = await fetchPlaceAncestors(places, {
    onChunk: async (slice, ancestors) => {
      const values = [...ancestors].flatMap(([qid, list]) =>
        list.map(({ ancestor, country }) => ({ qid, ancestor, country })),
      );
      await db.transaction(async (tx) => {
        await tx.delete(placeAncestors).where(inArray(placeAncestors.qid, slice));
        for (const batch of chunk(values, ROWS_PER_STMT)) {
          await tx.insert(placeAncestors).values(batch);
        }
      });
      rows += values.length;
    },
    onProgress: (done, total) => {
      if (++chunks % LOG_EVERY_CHUNKS === 0 || done === total) {
        console.log(
          `place ancestors: looked up and wrote ${progress(done, total)} places, ` +
            `${elapsed(lookupStarted)} elapsed`,
        );
      }
    },
  });
  if (failed.length === places.length && places.length > 0) {
    throw new Error(`Place-ancestor lookup failed for all ${places.length} places`);
  }
  console.log(
    `place ancestors: ${rows} rows written in ${elapsed(lookupStarted)}, ${failed.length} failed`,
  );
  const pruneStarted = Date.now();
  const pruned = await pruneGonePlaces(new Set(places));
  console.log(`place ancestors: dropped ${pruned} gone places in ${elapsed(pruneStarted)}`);
  return { places: places.length - failed.length, rows, failed: failed.length };
}

/**
 * Delete the rows of every place not in `wanted` (no item names it any more),
 * paging through the table's places in key order. A failed place is still in
 * `wanted`, so it keeps its rows. Returns how many places were dropped.
 */
async function pruneGonePlaces(wanted: ReadonlySet<string>): Promise<number> {
  let after = "";
  let dropped = 0;
  for (;;) {
    const page = await db
      .selectDistinct({ qid: placeAncestors.qid })
      .from(placeAncestors)
      .where(gt(placeAncestors.qid, after))
      .orderBy(placeAncestors.qid)
      .limit(ROWS_PER_STMT);
    const last = page.at(-1);
    if (!last) return dropped;
    after = last.qid;
    const gone = page.map((r) => r.qid).filter((qid) => !wanted.has(qid));
    if (gone.length > 0) {
      await db.delete(placeAncestors).where(inArray(placeAncestors.qid, gone));
      dropped += gone.length;
    }
  }
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
