// One stdout line per API request — method, path, status and duration — so
// `toolforge webservice logs` shows the traffic the web service handled (tools
// can't read the Toolforge front proxy's access log). The query string is left
// out: it can carry the OAuth callback's `code` and `state`.
import type { MiddlewareHandler } from "hono";

export function requestLog(print: (line: string) => void = console.log): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start);
    print(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  };
}
