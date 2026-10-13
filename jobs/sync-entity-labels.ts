// Scheduled job: refresh the entity-label table (item values shown in the
// comparison view: genre, platform, developer, …). Runs weekly, after the dump import
// that brings in new referenced QIDs. Replaces Void's crons/sync-entity-labels.ts.
import { runEntityLabelsSync } from "../server/entity-labels-sync.ts";

export async function main(): Promise<number> {
  try {
    const { synced, failed } = await runEntityLabelsSync();
    console.log(`sync-entity-labels: upserted ${synced} entity labels`);
    // A partial run still exits 0: what it fetched is written, the skipped
    // QIDs keep their previous labels, and next week's run retries them.
    if (failed > 0)
      console.warn(`sync-entity-labels: skipped ${failed} QIDs after repeated failures`);
    return 0;
  } catch (err) {
    console.error("sync-entity-labels: failed", err);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
