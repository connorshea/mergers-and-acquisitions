// A short-lived cache of the candidate list's `total`, keyed by its filters.
// Counting a filtered list scans every row of the status (the language filter
// is REGEXPs over text columns, the label search a leading-wildcard LIKE), while
// the page itself is an index range that stops after a few dozen rows — so
// paging through one filtered list would otherwise redo the same full scan on
// every page.
//
// Writes through this server (dismiss, reopen, merge, "different from") clear
// the cache via `clearCountsOnWrite`; the hunt and sync jobs run in their own
// processes, so what they change shows up once an entry expires.
import type { MiddlewareHandler } from "hono";

export const COUNT_TTL_MS = 60_000;
/** Most filter combinations kept at once; the oldest entry goes first. */
const MAX_ENTRIES = 500;

type Entry = { total: Promise<number>; expires: number };
const cache = new Map<string, Entry>();

/**
 * The cached total for `key`, or `count()`'s result (stored for COUNT_TTL_MS).
 * The pending promise is what's cached, so concurrent requests for the same
 * filters share one query; a failed count isn't kept.
 */
export function cachedCount(
  key: string,
  count: () => Promise<number>,
  now = Date.now(),
): Promise<number> {
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.total;
  cache.delete(key);
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  const total = count();
  const entry: Entry = { total, expires: now + COUNT_TTL_MS };
  cache.set(key, entry);
  total.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return total;
}

export function clearCandidateCounts(): void {
  cache.clear();
}

/** Middleware: after any state-changing request, drop every cached total. */
export const clearCountsOnWrite: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.method !== "GET" && c.req.method !== "HEAD") clearCandidateCounts();
};
