// CSRF defence for the JSON API, on top of the session cookie's SameSite=Lax:
// every state-changing request must prove it came from this app's own origin,
// via `Sec-Fetch-Site: same-origin` (sent by all current browsers) or an
// `Origin` header matching the request URL or BASE_URL. Hono's bundled csrf()
// only inspects form-encoded requests, so this is applied to all of them. The
// BASE_URL check matters in dev, where Vite proxies /api and rewrites the Host.
import type { MiddlewareHandler } from "hono";
import { baseOrigin } from "./config.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const sameOriginOnly: MiddlewareHandler = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const site = c.req.header("sec-fetch-site");
    const origin = c.req.header("origin");
    const allowed =
      site === "same-origin" ||
      (origin !== undefined && (origin === new URL(c.req.url).origin || origin === baseOrigin()));
    if (!allowed) return c.json({ error: "Cross-origin request rejected" }, 403);
  }
  await next();
};
