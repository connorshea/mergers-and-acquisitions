import { describe, expect, it } from "vite-plus/test";
import type { Item } from "./compare.ts";
import { coordinateValue } from "./coordinates.ts";
import {
  externalIdRows,
  itemValueRows,
  MAX_LABEL_CHARS,
  primaryLabel,
  primaryType,
} from "./wikidata.ts";

const item: Item = {
  id: "Q100000040",
  labels: { en: "Pikmin 3 Deluxe", mul: "Pikmin 3 Deluxe" },
  descriptions: {},
  aliases: {},
  sitelinks: {},
  statements: {
    P31: [{ type: "item", value: "Q7889" }],
    P577: [{ type: "time", value: "+2020-10-30T00:00:00Z" }],
    P856: [{ type: "url", value: "https://www.nintendo.com/games/detail/pikmin-3-deluxe-switch/" }],
    P1733: [{ type: "external-id", value: "1385730" }],
    P10248: [{ type: "external-id", value: "pikmin-3-deluxe" }],
    P1476: [{ type: "string", value: "Pikmin 3 Deluxe" }],
    P348: [{ type: "string", value: "1.0" }],
    P436: [{ type: "external-id", value: "8f1c2a9e-mbrg", sharedWith: ["Q10423793"] }],
    P625: [coordinateValue(1, 2)],
  },
};

describe("derived DB fields", () => {
  it("reads primaryType from the first P31 item value", () => {
    expect(primaryType(item)).toBe("Q7889");
  });

  it("prefers the English primary label", () => {
    expect(primaryLabel(item)).toBe("Pikmin 3 Deluxe");
  });

  it("cuts a label too long for the label columns to MAX_LABEL_CHARS code points", () => {
    const withLabel = (text: string) => ({ ...item, labels: { it: text } });
    const long = "Storia ".repeat(40); // 280 characters
    const cut = primaryLabel(withLabel(long))!;
    expect(Array.from(cut)).toHaveLength(MAX_LABEL_CHARS);
    expect(cut).toBe(`${long.slice(0, MAX_LABEL_CHARS - 1)}…`);
    // Exactly at the limit, and astral characters counted once (MariaDB counts
    // code points, not UTF-16 units).
    expect(primaryLabel(withLabel("x".repeat(MAX_LABEL_CHARS)))).toBe("x".repeat(MAX_LABEL_CHARS));
    const astral = "𝄞".repeat(MAX_LABEL_CHARS);
    expect(primaryLabel(withLabel(astral))).toBe(astral);
  });

  it("collects external-id rows and nothing else", () => {
    expect(externalIdRows(item)).toEqual([
      { property: "P1733", value: "1385730" },
      { property: "P10248", value: "pikmin-3-deluxe" },
      { property: "P436", value: "8f1c2a9e-mbrg" },
    ]);
  });

  it("collects the distinct class and place item values and nothing else", () => {
    const withPlaces: Item = {
      ...item,
      statements: {
        ...item.statements,
        P31: [
          { type: "item", value: "Q7889" },
          { type: "item", value: "Q7889" },
          { type: "somevalue", value: "" },
        ],
        P159: [{ type: "item", value: "Q1490" }],
        P136: [{ type: "item", value: "Q744038" }], // genre: not kept
      },
    };
    expect(itemValueRows(withPlaces)).toEqual([
      { property: "P31", value: "Q7889" },
      { property: "P159", value: "Q1490" },
    ]);
  });
});
