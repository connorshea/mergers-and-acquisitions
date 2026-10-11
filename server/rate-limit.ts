// Per-user sliding-window limiters. One for the Wikidata edit endpoints:
// Wikidata rate-limits edits itself, but a loop or a stuck retry in the client
// should be stopped here before it burns the user's own edit quota (and our
// goodwill). One for the queue writes (dismiss / reopen), which touch only our
// DB and would otherwise let a script sweep every open pair, or undo and
// re-take others' work, in seconds. In-process state is enough: the web
// service is a single Node process.

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
          retryAfter: Math.max(1, Math.ceil((recent[0]! + windowMs - now) / 1000)),
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
/** A reviewer clicking steadily manages a few a minute; a script, hundreds. */
const DEFAULT_REVIEW_RATE_LIMIT = 30;

/**
 * A `*_RATE_LIMIT` env value as a positive integer, or the fallback when it is
 * unset, blank, or not a number — `Number("")` is 0 (every request refused)
 * and `Number("ten")` is NaN (no limit at all), so neither can be used as-is.
 */
export function parseRateLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isInteger(n) && n > 0 ? n : fallback;
}

/** `EDIT_RATE_LIMIT`, see parseRateLimit. */
export function parseEditRateLimit(
  raw: string | undefined,
  fallback = DEFAULT_EDIT_RATE_LIMIT,
): number {
  return parseRateLimit(raw, fallback);
}

/** Edits per user per minute, shared by the merge and "different from" endpoints. */
export const editLimiter = createRateLimiter(
  parseEditRateLimit(process.env.EDIT_RATE_LIMIT),
  60 * 1000,
);

/** Dismiss + reopen calls per user per minute (`REVIEW_RATE_LIMIT`). */
export const reviewLimiter = createRateLimiter(
  parseRateLimit(process.env.REVIEW_RATE_LIMIT, DEFAULT_REVIEW_RATE_LIMIT),
  60 * 1000,
);
