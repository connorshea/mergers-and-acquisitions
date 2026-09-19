// Unit tests for the DOM-free auth helpers.
import { describe, expect, it } from "vite-plus/test";
import { loginUrl } from "./auth.tsx";

describe("loginUrl", () => {
  it("encodes the return path", () => {
    expect(loginUrl("/candidates/5")).toBe("/api/auth/login?returnTo=%2Fcandidates%2F5");
  });

  it("strips a stale ?auth= outcome flag but keeps the other params", () => {
    expect(loginUrl("/?auth=denied")).toBe("/api/auth/login?returnTo=%2F");
    expect(loginUrl("/?q=zelda&auth=failed&page=2")).toBe(
      `/api/auth/login?returnTo=${encodeURIComponent("/?q=zelda&page=2")}`,
    );
  });
});
