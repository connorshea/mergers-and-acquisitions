// Scheduled job: refresh the Wikidata property-label table (~12k rows). Property
// labels change rarely, so a weekly run keeps the UI's property names current.
// Replaces Void's crons/sync-properties.ts.
import { fetchAllProperties } from "../src/lib/sparql.ts";
import { syncProperties } from "../server/properties-sync.ts";

fetchAllProperties()
  .then((rows) => syncProperties(rows))
  .then((synced) => {
    console.log(`sync-properties: upserted ${synced} property labels`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("sync-properties: failed", err);
    process.exit(1);
  });
