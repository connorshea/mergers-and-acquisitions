import { describe, expect, it } from "vite-plus/test";
import { createRateLimiter, parseEditRateLimit } from "./rate-limit.ts";

describe("createRateLimiter", () => {
  it("allows up to `max` hits per window, then rejects with a retry hint", () => {
    const limiter = createRateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.hit(7, t0)).toEqual({ ok: true });
    expect(limiter.hit(7, t0 + 1000)).toEqual({ ok: true });
    expect(limiter.hit(7, t0 + 2000)).toEqual({ ok: true });
    // The oldest hit (t0) leaves the window at t0 + 60s: 57s from now.
    expect(limiter.hit(7, t0 + 3000)).toEqual({ ok: false, retryAfter: 57 });
    // Rejected attempts don't extend the window.
    expect(limiter.hit(7, t0 + 4000)).toEqual({ ok: false, retryAfter: 56 });
  });

  it("keeps users separate and forgets hits that left the window", () => {
    const limiter = createRateLimiter(1, 60_000);
    const t0 = 5_000_000;
    expect(limiter.hit(1, t0)).toEqual({ ok: true });
    expect(limiter.hit(2, t0)).toEqual({ ok: true });
    expect(limiter.hit(1, t0 + 100).ok).toBe(false);
    expect(limiter.hit(1, t0 + 60_001)).toEqual({ ok: true });
  });
});

describe("parseEditRateLimit", () => {
  it("accepts a positive integer", () => {
    expect(parseEditRateLimit("25")).toBe(25);
    expect(parseEditRateLimit(" 3 ")).toBe(3);
  });

  it("falls back to the default when unset, blank, or not a positive integer", () => {
    expect(parseEditRateLimit(undefined)).toBe(10);
    expect(parseEditRateLimit("")).toBe(10);
    expect(parseEditRateLimit("   ")).toBe(10);
    expect(parseEditRateLimit("ten")).toBe(10);
    expect(parseEditRateLimit("0")).toBe(10);
    expect(parseEditRateLimit("-5")).toBe(10);
    expect(parseEditRateLimit("2.5")).toBe(10);
    expect(parseEditRateLimit("", 4)).toBe(4);
  });
});
