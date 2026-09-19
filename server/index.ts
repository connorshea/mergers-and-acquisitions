// The web server entrypoint: binds the Hono app (server/app.ts) to $PORT. Runs
// as the Toolforge webservice (buildservice Node image).
import { serve } from "@hono/node-server";
import { app } from "./app.ts";

const port = Number(process.env.PORT ?? 8000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});
