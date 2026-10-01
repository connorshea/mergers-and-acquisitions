// The web server entrypoint: checks the DB schema is current (server/preflight.ts),
// then binds the Hono app (server/app.ts) to $PORT. Runs as the Toolforge
// webservice (buildservice Node image).
import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { pool } from "./db.ts";
import { recordInterruptedEdits } from "./edits.ts";
import { preflight } from "./preflight.ts";

// Refuse to serve against a database with pending migrations (or none at all);
// exits with an actionable message rather than failing on the first query.
await preflight();

const port = Number(process.env.PORT ?? 8000);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});

// --- graceful shutdown ---
// Toolforge (Kubernetes) sends SIGTERM on every redeploy/restart and gives the
// pod a grace period before SIGKILL. Stop accepting new connections, let
// in-flight requests finish, close the DB pool, then exit. If draining hangs
// (a stuck query, a client holding a connection open), give up before k8s does
// so the exit is still ours and logged. The drain gets most of Kubernetes'
// default 30s grace: a merge makes several Wikidata calls and shouldn't be cut
// off needlessly. A merge or "different from" still running when it runs out
// gets a failed audit row first (recordInterruptedEdits), since it may already
// have landed on Wikidata; that write gets RECORD_TIMEOUT_MS of the remainder.
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 25_000);
const RECORD_TIMEOUT_MS = 3_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down…`);

  const forceExit = setTimeout(() => {
    console.error(`shutdown: still draining after ${SHUTDOWN_TIMEOUT_MS}ms, exiting anyway`);
    const giveUp = new Promise<void>((resolve) => setTimeout(resolve, RECORD_TIMEOUT_MS));
    void Promise.race([
      recordInterruptedEdits().then((n) => {
        if (n > 0) console.error(`shutdown: recorded ${n} interrupted edit(s)`);
      }),
      giveUp,
    ]).finally(() => process.exit(1));
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
