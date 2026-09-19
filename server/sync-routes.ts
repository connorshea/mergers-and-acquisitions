// Router for the manual Wikidata sync triggers: property labels, entity (value)
// labels, and game descriptions. Each does the same work as the corresponding
// scheduled job (jobs/sync-*.ts), exposed for a manual/dev trigger. The heavy
// lifting is in the shared server/*-sync.ts write paths.
import { Hono } from "hono";
import { type AuthEnv, requireAdmin } from "./auth/session.ts";
import { fetchAllProperties } from "../src/lib/sparql.ts";
import { syncProperties } from "./properties-sync.ts";
import { runEntityLabelsSync } from "./entity-labels-sync.ts";
import { runDescriptionsSync } from "./descriptions-sync.ts";
import type {
  DescriptionsSyncResponse,
  EntityLabelsSyncResponse,
  PropertiesSyncResponse,
} from "../src/lib/api-types.ts";

export const syncRoutes = new Hono<AuthEnv>();

// The manual sync triggers are admin-only (ADMIN_USERS). Guard the exact paths:
// a `/*` guard here would also intercept the API's unknown-route fallthrough.
syncRoutes.use("/properties/sync", requireAdmin);
syncRoutes.use("/entity-labels/sync", requireAdmin);
syncRoutes.use("/descriptions/sync", requireAdmin);

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
    const synced = await runEntityLabelsSync();
    const payload: EntityLabelsSyncResponse = { synced };
    return c.json(payload);
  } catch (err) {
    console.error("entity-labels sync failed", err);
    return c.json({ error: "Value-label sync failed. Check the endpoint is reachable." }, 502);
  }
});

syncRoutes.post("/descriptions/sync", async (c) => {
  try {
    const synced = await runDescriptionsSync();
    const payload: DescriptionsSyncResponse = { synced };
    return c.json(payload);
  } catch (err) {
    console.error("descriptions sync failed", err);
    return c.json({ error: "Description sync failed. Check the endpoint is reachable." }, 502);
  }
});
