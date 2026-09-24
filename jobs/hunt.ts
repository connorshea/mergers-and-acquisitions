// Scheduled job: run the duplicate-candidate hunt. Replaces the Void
// crons/hunt-candidates.ts + queues/hunt-candidates.ts pair — the whole
// scan→score→upsert now runs in one process (see server/hunt.ts).
import { runHunt } from "../server/hunt.ts";

runHunt()
  .then((stats) => {
    console.log(
      `hunt: ${stats.pairs} pairs, ${stats.scored} scored, ${stats.upserted} upserted, ` +
        `${stats.deleted} deleted, ${stats.pruned} pruned, ${stats.failed} failed`,
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error("hunt: failed", err);
    process.exit(1);
  });
