// Scheduled job: refresh the entity-label table (item values shown in the
// comparison view: genre, platform, developer, …). These change rarely, so one
// run a week keeps them current. Replaces Void's crons/sync-entity-labels.ts.
import { runEntityLabelsSync } from "../server/entity-labels-sync.ts";

runEntityLabelsSync()
  .then((synced) => {
    console.log(`sync-entity-labels: upserted ${synced} entity labels`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("sync-entity-labels: failed", err);
    process.exit(1);
  });
