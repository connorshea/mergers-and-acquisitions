import { describe, expect, it } from "vite-plus/test";
import type { Item } from "./compare.ts";
import { makePlaceContainment, placeContainmentFromRows, placeValues } from "./places.ts";

describe("makePlaceContainment", () => {
  const places = makePlaceContainment(
    new Map([
      ["Q416131", ["Q1490", "Q17"]],
      ["Q1490", ["Q17"]],
    ]),
    new Set(["Q17"]),
  );

  it("tells a local container from a country", () => {
    expect(places("Q416131", "Q1490")).toBe("local");
    expect(places("Q416131", "Q17")).toBe("country");
    expect(places("Q1490", "Q17")).toBe("country");
  });

  it("is directional, and knows nothing of unsynced places", () => {
    expect(places("Q1490", "Q416131")).toBeNull();
    expect(places("Q35765", "Q17")).toBeNull();
  });
});

describe("placeContainmentFromRows", () => {
  it("builds the check from place_ancestors rows, or null without any", () => {
    const places = placeContainmentFromRows([
      { qid: "Q16554", ancestor: "Q1261", country: false },
      { qid: "Q16554", ancestor: "Q30", country: true },
    ]);
    expect(places?.("Q16554", "Q1261")).toBe("local");
    expect(places?.("Q16554", "Q30")).toBe("country");
    expect(placeContainmentFromRows([])).toBeNull();
  });
});

describe("placeValues", () => {
  it("collects the item values of place properties only", () => {
    const item: Item = {
      id: "Q1",
      labels: {},
      descriptions: {},
      aliases: {},
      sitelinks: {},
      statements: {
        P159: [{ type: "item", value: "Q1490" }],
        P19: [
          { type: "item", value: "Q16554" },
          { type: "somevalue", value: "" },
        ],
        P136: [{ type: "item", value: "Q100" }],
      },
    };
    expect(placeValues([item, item]).sort()).toEqual(["Q1490", "Q16554"]);
  });
});
