// Scheduled job: settle open candidates whose items were merged (or deleted)
// on Wikidata since the last dump, from the wikidatawiki replica (see
// server/outside-merges.ts). Runs nightly before the hunt, so the hunt skips
// the items that are gone.
import { runOutsideMergeSync } from "../server/outside-merges.ts";

runOutsideMergeSync()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("resolve-merges: failed", err);
    process.exit(1);
  });
