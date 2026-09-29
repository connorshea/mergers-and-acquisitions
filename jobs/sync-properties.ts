// Scheduled job: refresh the Wikidata property table (~12k rows: labels,
// formatter URLs, subject type constraints), then rebuild `class_ancestors`
// for our items' classes against those constraints. Both change rarely, so a
// weekly run keeps them current. Replaces Void's crons/sync-properties.ts.
import { fetchAllProperties } from "../src/lib/sparql.ts";
import { syncProperties } from "../server/properties-sync.ts";
import { syncClassAncestors } from "../server/class-ancestors.ts";

async function main(): Promise<void> {
  const synced = await syncProperties(await fetchAllProperties());
  console.log(`sync-properties: upserted ${synced} property labels`);
  const { classes, rows, failed } = await syncClassAncestors();
  console.log(`sync-properties: wrote ${rows} ancestor rows for ${classes} classes`);
  // A partial run still exits 0: the failed classes keep their previous rows
  // (or stay unknown, which the constraint check treats as applicable).
  if (failed > 0)
    console.warn(`sync-properties: skipped ${failed} classes after repeated failures`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("sync-properties: failed", err);
    process.exit(1);
  });
