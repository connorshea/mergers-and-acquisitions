// A per-user sliding-window limiter for the Wikidata edit endpoints. Wikidata
// rate-limits edits itself, but a loop or a stuck retry in the client should be
// stopped here before it burns the user's own edit quota (and our goodwill).
// In-process state is enough: the web service is a single Node process.

export interface RateLimiter {
  /** Record an attempt for `key` and say whether it is allowed; `retryAfter` is seconds. */
  hit(key: number | string, now?: number): { ok: true } | { ok: false; retryAfter: number };
  /** Forget every hit (tests). */
  reset(): void;
}

export function createRateLimiter(max: number, windowMs: number): RateLimiter {
  const hits = new Map<number | string, number[]>();
  return {
    hit(key, now = Date.now()) {
      const floor = now - windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > floor);
      if (recent.length >= max) {
        hits.set(key, recent);
        return {
          ok: false,
          retryAfter: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)),
        };
      }
      recent.push(now);
      hits.set(key, recent);
      return { ok: true };
    },
    reset() {
      hits.clear();
    },
  };
}

const DEFAULT_EDIT_RATE_LIMIT = 10;

/**
 * `EDIT_RATE_LIMIT` as a positive integer, or the default when it is unset,
 * blank, or not a number — `Number("")` is 0 (every edit refused) and
 * `Number("ten")` is NaN (no limit at all), so neither can be used as-is.
 */
export function parseEditRateLimit(
  raw: string | undefined,
  fallback = DEFAULT_EDIT_RATE_LIMIT,
): number {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Edits per user per minute, shared by the merge and "different from" endpoints. */
export const editLimiter = createRateLimiter(
  parseEditRateLimit(process.env.EDIT_RATE_LIMIT),
  60 * 1000,
);
