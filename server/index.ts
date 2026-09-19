// The web server entrypoint: a Hono app that mounts the JSON API under /api and
// serves the built React SPA (dist/client) for everything else. Runs as the
// Toolforge webservice (buildservice Node image). In local dev the SPA is served
// by Vite instead, which proxies /api here (see vite.config.ts) — so the static
// serving below only matters in production.
import { existsSync, readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { candidates } from "./candidates.ts";
import { actions } from "./actions.ts";
import { syncRoutes } from "./sync-routes.ts";

const CLIENT_DIR = process.env.CLIENT_DIR ?? "./dist/client";
const INDEX_HTML = `${CLIENT_DIR}/index.html`;

const app = new Hono();

// --- API ---
app.route("/api/candidates", candidates);
app.route("/api", actions); // /api/hunt, /api/reset
app.route("/api", syncRoutes); // /api/{properties,entity-labels,descriptions}/sync

// An API route that fell through to here doesn't exist — return JSON, never the
// SPA shell, so the client sees a real 404 instead of HTML.
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// --- static SPA ---
// Serve built assets; anything without a matching file falls through to the SPA
// shell so client-side routes (e.g. /candidates/123) load index.html.
app.use("/*", serveStatic({ root: CLIENT_DIR }));

const indexHtml = existsSync(INDEX_HTML) ? readFileSync(INDEX_HTML, "utf8") : null;
app.notFound((c) => {
  if (indexHtml) return c.html(indexHtml);
  return c.text(
    "Client build not found. Run `pnpm build` (or set CLIENT_DIR) so dist/client exists.",
    500,
  );
});

const port = Number(process.env.PORT ?? 8000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});
