// POST /api/descriptions/sync — fetch English descriptions for in-scope game
// items from QLever and upsert them into `item_descriptions`. The dump omits
// descriptions, so this backfills them for the comparison view. Same work the
// weekly crons/sync-descriptions.ts cron does, exposed for a manual/dev trigger.
import { defineHandler } from "void";
import { fetchGameDescriptions } from "../../../src/lib/sparql";
import { syncGameDescriptions } from "../../../server/descriptions-sync";
import type { DescriptionsSyncResponse } from "../../../src/lib/api-types";

export const POST = defineHandler(async (c) => {
  try {
    const rows = await fetchGameDescriptions();
    const synced = await syncGameDescriptions(rows);
    const payload: DescriptionsSyncResponse = { synced };
    return payload;
  } catch (err) {
    console.error("descriptions sync failed", err);
    return c.json({ error: "Description sync failed. Check the endpoint is reachable." }, 502);
  }
});
