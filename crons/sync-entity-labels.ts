// Weekly refresh of the entity-label table (item values shown in the comparison
// view: genre, platform, developer, …). These labels change rarely, so one
// query a week keeps them current. The manual equivalent is
// POST /api/entity-labels/sync.
import { defineScheduled } from "void";
import { fetchEntityLabels } from "../src/lib/sparql";
import { syncEntityLabels } from "../server/entity-labels-sync";

// Sundays at 02:15 UTC — just after the property sync (02:00), ahead of the
// 03:00 hunt, so both name tables are fresh for review.
export const cron = "15 2 * * 0";

export default defineScheduled(async () => {
  const rows = await fetchEntityLabels();
  const synced = await syncEntityLabels(rows);
  console.log(`sync-entity-labels: upserted ${synced} entity labels`);
});
