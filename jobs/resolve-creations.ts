// Scheduled job: record who created each open candidate's items, when, and
// with what edit summary, from the wikidatawiki replica (see
// server/item-creations.ts). Runs nightly after the hunt, which is what
// creates the candidates; items already recorded are only re-read monthly, to
// refresh their creator's edit count and bot flag.
import { runItemCreationSync } from "../server/item-creations.ts";

export async function main(): Promise<number> {
  try {
    await runItemCreationSync();
    return 0;
  } catch (err) {
    console.error("resolve-creations: failed", err);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
