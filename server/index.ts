// The web server entrypoint: binds the Hono app (server/app.ts) to $PORT. Runs
// as the Toolforge webservice (buildservice Node image).
import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { pool } from "./db.ts";

const port = Number(process.env.PORT ?? 8000);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});

// --- graceful shutdown ---
// Toolforge (Kubernetes) sends SIGTERM on every redeploy/restart and gives the
// pod a grace period before SIGKILL. Stop accepting new connections, let
// in-flight requests finish, close the DB pool, then exit. If draining hangs
// (a stuck query, a client holding a connection open), give up before k8s does
// so the exit is still ours and logged.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down…`);

  const forceExit = setTimeout(() => {
    console.error(`shutdown: still draining after ${SHUTDOWN_TIMEOUT_MS}ms, exiting anyway`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Don't let this timer alone keep the process alive once everything else is done.
  forceExit.unref();

  // close() stops listening and waits for in-flight requests; keep-alive
  // connections that are idle would otherwise hold it open, so drop those.
  server.close((err) => {
    if (err) console.error("shutdown: server close failed", err);
    pool
      .end()
      .catch((e: unknown) => console.error("shutdown: pool close failed", e))
      .finally(() => {
        clearTimeout(forceExit);
        console.log("shutdown: done");
        process.exit(err ? 1 : 0);
      });
  });
  if ("closeIdleConnections" in server) server.closeIdleConnections();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
