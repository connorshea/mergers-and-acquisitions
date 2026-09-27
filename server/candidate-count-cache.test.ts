import { beforeEach, describe, expect, it } from "vite-plus/test";
import { Hono } from "hono";
import {
  cachedCount,
  clearCandidateCounts,
  clearCountsOnWrite,
  COUNT_TTL_MS,
} from "./candidate-count-cache.ts";

describe("cachedCount", () => {
  beforeEach(() => clearCandidateCounts());

  it("reuses a total for the same key until it expires", async () => {
    let calls = 0;
    const count = async () => ++calls;
    expect(await cachedCount("a", count, 0)).toBe(1);
    expect(await cachedCount("a", count, COUNT_TTL_MS - 1)).toBe(1);
    expect(await cachedCount("b", count, 0)).toBe(2);
    expect(await cachedCount("a", count, COUNT_TTL_MS)).toBe(3);
  });

  it("shares one query between concurrent requests", async () => {
    let calls = 0;
    const count = async () => ++calls;
    const [x, y] = await Promise.all([cachedCount("a", count), cachedCount("a", count)]);
    expect([x, y, calls]).toEqual([1, 1, 1]);
  });

  it("doesn't keep a failed count", async () => {
    await expect(cachedCount("a", () => Promise.reject(new Error("db down")))).rejects.toThrow(
      "db down",
    );
    expect(await cachedCount("a", async () => 5)).toBe(5);
  });

  it("is cleared by a write request but not a read", async () => {
    const app = new Hono();
    app.use("*", clearCountsOnWrite);
    app.get("/x", (c) => c.text("ok"));
    app.post("/x", (c) => c.text("ok"));
    await cachedCount("a", async () => 1);
    await app.request("/x");
    expect(await cachedCount("a", async () => 2)).toBe(1);
    await app.request("/x", { method: "POST" });
    expect(await cachedCount("a", async () => 2)).toBe(2);
  });
});
