// POST /api/entity-labels/sync — fetch English labels for the item values that
// appear on in-scope games (genre, platform, developer, …) from QLever and
// upsert them into the `entity_labels` table. Same work the weekly
// crons/sync-entity-labels.ts cron does, exposed for a manual/dev trigger.
import { defineHandler } from "void";
import { fetchEntityLabels } from "../../../src/lib/sparql";
import { syncEntityLabels } from "../../../server/entity-labels-sync";
import type { EntityLabelsSyncResponse } from "../../../src/lib/api-types";

export const POST = defineHandler(async (c) => {
  try {
    const rows = await fetchEntityLabels();
    const synced = await syncEntityLabels(rows);
    const payload: EntityLabelsSyncResponse = { synced };
    return payload;
  } catch (err) {
    console.error("entity-labels sync failed", err);
    return c.json({ error: "Value-label sync failed. Check the endpoint is reachable." }, 502);
  }
});
