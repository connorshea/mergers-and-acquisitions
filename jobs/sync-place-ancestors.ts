// Scheduled job: rebuild `place_ancestors` (each place value's P131+
// ancestors, from QLever) for the places our items name. Runs weekly, after
// the dump import that brings in new place values.
import { syncPlaceAncestors } from "../server/place-ancestors.ts";

export async function main(): Promise<number> {
  try {
    const { places, rows, failed } = await syncPlaceAncestors();
    console.log(`sync-place-ancestors: wrote ${rows} ancestor rows for ${places} places`);
    // A partial run still exits 0: the failed places keep their previous rows
    // (or stay unknown, which compares as before), and next week retries them.
    if (failed > 0)
      console.warn(`sync-place-ancestors: skipped ${failed} places after repeated failures`);
    return 0;
  } catch (err) {
    console.error("sync-place-ancestors: failed", err);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
