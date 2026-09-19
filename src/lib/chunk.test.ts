import { describe, expect, it } from "vite-plus/test";
import { chunk, D1_MAX_BOUND_PARAMS } from "./chunk.ts";

describe("chunk", () => {
  it("splits into consecutive fixed-size chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("returns an empty array for empty input (so Promise.all([]) is a no-op)", () => {
    expect(chunk([], 50)).toEqual([]);
  });

  it("keeps every chunk under D1's bound-parameter cap at the sizes we use", () => {
    // The hunt loads up to 2×SCORE_BATCH (=200) qids per score batch; chunking at
    // D1_MAX_BOUND_PARAMS - 10 must never exceed the 100-param limit.
    const ids = Array.from({ length: 200 }, (_, i) => `Q${i}`);
    const chunks = chunk(ids, D1_MAX_BOUND_PARAMS - 10);
    expect(chunks.every((c) => c.length <= D1_MAX_BOUND_PARAMS)).toBe(true);
    expect(chunks.flat()).toEqual(ids); // lossless
  });

  it("rejects a non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});
