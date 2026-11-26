import { describe, expect, it } from "vite-plus/test";
import { isCaptchaExempt } from "./eligibility.ts";

describe("isCaptchaExempt", () => {
  it("accepts autoconfirmed and the other exempt groups", () => {
    expect(isCaptchaExempt(["*", "user", "autoconfirmed"])).toBe(true);
    expect(isCaptchaExempt(["*", "user", "confirmed"])).toBe(true);
    expect(isCaptchaExempt(["*", "user", "bot"])).toBe(true);
    expect(isCaptchaExempt(["*", "user", "sysop"])).toBe(true);
  });

  it("refuses new accounts and missing groups", () => {
    expect(isCaptchaExempt(["*", "user"])).toBe(false);
    expect(isCaptchaExempt([])).toBe(false);
    expect(isCaptchaExempt(undefined)).toBe(false);
    expect(isCaptchaExempt(null)).toBe(false);
  });
});
