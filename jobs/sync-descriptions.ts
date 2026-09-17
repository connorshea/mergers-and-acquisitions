// Scheduled job: refresh in-scope game descriptions (shown under each item's
// name in the comparison view, and used for merge-blocker detection). The dump
// omits descriptions, so this backfills them from Wikidata. Replaces Void's
// crons/sync-descriptions.ts.
import { fetchGameDescriptions } from "../src/lib/sparql";
import { syncGameDescriptions } from "../server/descriptions-sync";

fetchGameDescriptions()
  .then((rows) => syncGameDescriptions(rows))
  .then((synced) => {
    console.log(`sync-descriptions: upserted ${synced} game descriptions`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("sync-descriptions: failed", err);
    process.exit(1);
  });
