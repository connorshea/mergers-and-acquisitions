import { describe, expect, it } from "vite-plus/test";
import type { Value } from "./compare.ts";
import { coarseTimeRange, coarseTimeText, isCoarseTime } from "./time.ts";

const time = (value: string, timePrecision?: number): Value => ({
  type: "time",
  value,
  ...(timePrecision === undefined ? {} : { timePrecision }),
});

describe("coarseTimeText", () => {
  it("names decades, centuries and millennia the way Wikidata shows them", () => {
    expect(coarseTimeText(time("+1901-00-00T00:00:00Z", 7))).toBe("20th century");
    expect(coarseTimeText(time("+2000-00-00T00:00:00Z", 7))).toBe("20th century");
    expect(coarseTimeText(time("+2001-00-00T00:00:00Z", 7))).toBe("21st century");
    expect(coarseTimeText(time("+1101-00-00T00:00:00Z", 7))).toBe("12th century");
    expect(coarseTimeText(time("+1990-00-00T00:00:00Z", 8))).toBe("1990s");
    expect(coarseTimeText(time("+2000-00-00T00:00:00Z", 6))).toBe("2nd millennium");
    expect(coarseTimeText(time("-0450-00-00T00:00:00Z", 7))).toBe("5th century BCE");
  });

  it("is null at year precision and finer", () => {
    expect(coarseTimeText(time("+1901-00-00T00:00:00Z"))).toBeNull();
    expect(coarseTimeText(time("+1901-00-00T00:00:00Z", 9))).toBeNull();
    expect(isCoarseTime(time("+1901-05-03T00:00:00Z", 11))).toBe(false);
  });
});

describe("coarseTimeRange", () => {
  it("gives the years a coarse value covers", () => {
    expect(coarseTimeRange(time("+1901-00-00T00:00:00Z", 7))).toEqual([1901, 2000]);
    expect(coarseTimeRange(time("+2000-00-00T00:00:00Z", 7))).toEqual([1901, 2000]);
    expect(coarseTimeRange(time("+1995-00-00T00:00:00Z", 8))).toEqual([1990, 1999]);
    expect(coarseTimeRange(time("-0450-00-00T00:00:00Z", 7))).toEqual([-500, -401]);
    expect(coarseTimeRange(time("+1977-00-00T00:00:00Z"))).toBeNull();
  });
});
