// Scheduled job: settle open candidates whose items were merged (or deleted)
// on Wikidata since the last dump, from the wikidatawiki replica (see
// server/outside-merges.ts). Runs nightly before the hunt, so the hunt skips
// the items that are gone.
import { runOutsideMergeSync } from "../server/outside-merges.ts";

export async function main(): Promise<number> {
  try {
    await runOutsideMergeSync();
    return 0;
  } catch (err) {
    console.error("resolve-merges: failed", err);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
