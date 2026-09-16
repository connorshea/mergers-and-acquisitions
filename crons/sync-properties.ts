// Weekly refresh of the Wikidata property-label table. Property labels change
// rarely and there are only ~12k of them, so one query a week keeps the UI's
// property names current without any real load. The manual equivalent is
// POST /api/properties/sync.
import { defineScheduled } from "void";
import { fetchAllProperties } from "../src/lib/sparql";
import { syncProperties } from "../server/properties-sync";

// Sundays at 02:00 UTC — ahead of the 03:00 hunt so names are fresh for review.
export const cron = "0 2 * * 0";

export default defineScheduled(async () => {
  const rows = await fetchAllProperties();
  const synced = await syncProperties(rows);
  console.log(`sync-properties: upserted ${synced} property labels`);
});
