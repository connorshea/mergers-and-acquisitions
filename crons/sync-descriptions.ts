// Weekly refresh of in-scope game descriptions (shown under each item's name in
// the comparison view, and used for merge-blocker detection). The dump omits
// descriptions, so this backfills them from Wikidata. The manual equivalent is
// POST /api/descriptions/sync.
import { defineScheduled } from "void";
import { fetchGameDescriptions } from "../src/lib/sparql";
import { syncGameDescriptions } from "../server/descriptions-sync";

// Sundays at 02:30 UTC — after the property (02:00) and entity-label (02:15)
// syncs, ahead of the 03:00 hunt.
export const cron = "30 2 * * 0";

export default defineScheduled(async () => {
  const rows = await fetchGameDescriptions();
  const synced = await syncGameDescriptions(rows);
  console.log(`sync-descriptions: upserted ${synced} game descriptions`);
});
