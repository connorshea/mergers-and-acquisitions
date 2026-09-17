// Router for the manual Wikidata sync triggers: property labels, entity (value)
// labels, and game descriptions. Each does the same work as the corresponding
// scheduled job (jobs/sync-*.ts), exposed for a manual/dev trigger. The heavy
// lifting is in the shared server/*-sync.ts write paths.
import { Hono } from "hono";
import { fetchAllProperties, fetchEntityLabels, fetchGameDescriptions } from "../src/lib/sparql";
import { syncProperties } from "./properties-sync";
import { syncEntityLabels } from "./entity-labels-sync";
import { syncGameDescriptions } from "./descriptions-sync";
import type {
  DescriptionsSyncResponse,
  EntityLabelsSyncResponse,
  PropertiesSyncResponse,
} from "../src/lib/api-types";

export const syncRoutes = new Hono();

syncRoutes.post("/properties/sync", async (c) => {
  try {
    const synced = await syncProperties(await fetchAllProperties());
    const payload: PropertiesSyncResponse = { synced };
    return c.json(payload);
  } catch (err) {
    console.error("properties sync failed", err);
    return c.json({ error: "Property sync failed. Check the endpoint is reachable." }, 502);
  }
});

syncRoutes.post("/entity-labels/sync", async (c) => {
  try {
    const synced = await syncEntityLabels(await fetchEntityLabels());
    const payload: EntityLabelsSyncResponse = { synced };
    return c.json(payload);
  } catch (err) {
    console.error("entity-labels sync failed", err);
    return c.json({ error: "Value-label sync failed. Check the endpoint is reachable." }, 502);
  }
});

syncRoutes.post("/descriptions/sync", async (c) => {
  try {
    const synced = await syncGameDescriptions(await fetchGameDescriptions());
    const payload: DescriptionsSyncResponse = { synced };
    return c.json(payload);
  } catch (err) {
    console.error("descriptions sync failed", err);
    return c.json({ error: "Description sync failed. Check the endpoint is reachable." }, 502);
  }
});
