// POST /api/properties/sync — fetch every Wikidata property label from QLever
// and upsert it into the `properties` table. Same work the weekly
// crons/sync-properties.ts cron does, exposed for a manual/dev trigger.
import { defineHandler } from "void";
import { fetchAllProperties } from "../../../src/lib/sparql";
import { syncProperties } from "../../../server/properties-sync";
import type { PropertiesSyncResponse } from "../../../src/lib/api-types";

export const POST = defineHandler(async (c) => {
  try {
    const rows = await fetchAllProperties();
    const synced = await syncProperties(rows);
    const payload: PropertiesSyncResponse = { synced };
    return payload;
  } catch (err) {
    console.error("properties sync failed", err);
    return c.json({ error: "Property sync failed. Check the endpoint is reachable." }, 502);
  }
});
