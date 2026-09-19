import { describe, expect, it } from "vite-plus/test";
import {
  classifyValue,
  type DumpGame,
  externalIdRows,
  mapDumpGame,
  primaryLabel,
  primaryType,
} from "./wikidata.ts";

describe("classifyValue", () => {
  it("maps entity nodes to item values", () => {
    expect(classifyValue({ type: "entity", value: "Q7889" })).toEqual({
      type: "item",
      value: "Q7889",
    });
  });

  it("maps non-entity uri nodes to url values", () => {
    expect(
      classifyValue({ type: "uri", value: "https://store.steampowered.com/app/400/" }),
    ).toEqual({ type: "url", value: "https://store.steampowered.com/app/400/" });
  });

  it("classifies dateTime literals as time", () => {
    expect(
      classifyValue({
        type: "literal",
        value: "2007-10-10T00:00:00Z",
        datatype: "http://www.w3.org/2001/XMLSchema#dateTime",
      }),
    ).toEqual({ type: "time", value: "2007-10-10T00:00:00Z" });
  });

  it("classifies decimal literals as quantity", () => {
    expect(
      classifyValue({
        type: "literal",
        value: "440",
        datatype: "http://www.w3.org/2001/XMLSchema#decimal",
      }),
    ).toEqual({ type: "quantity", value: "440" });
  });

  it("classifies language-tagged literals as string (monolingual text)", () => {
    expect(classifyValue({ type: "literal", value: "Portal", lang: "en" })).toEqual({
      type: "string",
      value: "Portal",
    });
  });

  it("classifies a bare literal as an external id", () => {
    expect(classifyValue({ type: "literal", value: "pikmin-3-deluxe" })).toEqual({
      type: "external-id",
      value: "pikmin-3-deluxe",
    });
  });

  it("maps an unknown-value blank node (genid IRI) to a somevalue, not a url", () => {
    expect(
      classifyValue({
        type: "uri",
        value: "https://www.wikidata.org/.well-known/genid/28e2798fd6042f09b601b1a78c228844",
      }),
    ).toEqual({ type: "somevalue", value: "" });
    // A real URL is still a url.
    expect(
      classifyValue({ type: "uri", value: "https://store.steampowered.com/app/400/" }),
    ).toEqual({ type: "url", value: "https://store.steampowered.com/app/400/" });
  });

  it("carries a value's 'identifier shared with' (P4070) QIDs through as sharedWith", () => {
    expect(
      classifyValue(
        { type: "literal", value: "8f1c2a9e-mbrg", shared_with: ["Q10423793"] },
        "P436",
      ),
    ).toEqual({ type: "external-id", value: "8f1c2a9e-mbrg", sharedWith: ["Q10423793"] });
    // Absent or empty qualifiers leave the value untouched (no empty array).
    expect(classifyValue({ type: "literal", value: "440", shared_with: [] }, "P1733")).toEqual({
      type: "external-id",
      value: "440",
    });
  });

  it("keeps a known plain-string property (P348 version) as a string, not an id", () => {
    // Without the property id the value shape is indistinguishable from an id.
    expect(classifyValue({ type: "literal", value: "1.9" })).toEqual({
      type: "external-id",
      value: "1.9",
    });
    // With it, the denylist pins P348 to "string" so unrelated games sharing a
    // version (e.g. Doom and its port POOM, both "1.9") don't look id-matched.
    expect(classifyValue({ type: "literal", value: "1.9" }, "P348")).toEqual({
      type: "string",
      value: "1.9",
    });
  });
});

// A compact game in the exact dump shape (values as they arrive from QLever).
const game: DumpGame = {
  wikidata_id: 100000040,
  qid: "Q100000040",
  label: "Pikmin 3 Deluxe",
  en_label: "Pikmin 3 Deluxe",
  mul_label: "Pikmin 3 Deluxe",
  properties: {
    P31: [{ type: "entity", value: "Q7889" }],
    P577: [
      {
        type: "literal",
        value: "2020-10-30T00:00:00Z",
        datatype: "http://www.w3.org/2001/XMLSchema#dateTime",
      },
    ],
    P856: [{ type: "uri", value: "https://www.nintendo.com/games/detail/pikmin-3-deluxe-switch/" }],
    P1733: [{ type: "literal", value: "1385730" }],
    P10248: [{ type: "literal", value: "pikmin-3-deluxe" }],
    P1476: [{ type: "literal", value: "Pikmin 3 Deluxe", lang: "en" }],
    P348: [{ type: "literal", value: "1.0" }],
    P436: [{ type: "literal", value: "8f1c2a9e-mbrg", shared_with: ["Q10423793"] }],
  },
};

describe("mapDumpGame", () => {
  const item = mapDumpGame(game);

  it("uses the qid as id and keeps en/mul labels", () => {
    expect(item.id).toBe("Q100000040");
    expect(item.labels).toEqual({ en: "Pikmin 3 Deluxe", mul: "Pikmin 3 Deluxe" });
  });

  it("leaves dump-absent fields empty (descriptions/aliases/sitelinks)", () => {
    expect(item.descriptions).toEqual({});
    expect(item.aliases).toEqual({});
    expect(item.sitelinks).toEqual({});
  });

  it("classifies each statement value by shape", () => {
    expect(item.statements.P31).toEqual([{ type: "item", value: "Q7889" }]);
    expect(item.statements.P577[0].type).toBe("time");
    expect(item.statements.P856[0].type).toBe("url");
    expect(item.statements.P1733[0].type).toBe("external-id");
    expect(item.statements.P10248[0].type).toBe("external-id");
    expect(item.statements.P1476[0].type).toBe("string");
    expect(item.statements.P348[0].type).toBe("string"); // version, not an id
  });

  it("keeps the P4070 shared-with QIDs on the mapped value", () => {
    expect(item.statements.P436).toEqual([
      { type: "external-id", value: "8f1c2a9e-mbrg", sharedWith: ["Q10423793"] },
    ]);
  });

  it("omits en/mul labels when the dump has none", () => {
    const bare = mapDumpGame({ ...game, en_label: null, mul_label: null });
    expect(bare.labels).toEqual({});
  });
});

describe("derived DB fields", () => {
  const item = mapDumpGame(game);

  it("reads primaryType from the first P31 item value", () => {
    expect(primaryType(item)).toBe("Q7889");
  });

  it("prefers the English primary label", () => {
    expect(primaryLabel(item)).toBe("Pikmin 3 Deluxe");
  });

  it("collects external-id rows and nothing else", () => {
    expect(externalIdRows(item)).toEqual([
      { property: "P1733", value: "1385730" },
      { property: "P10248", value: "pikmin-3-deluxe" },
      { property: "P436", value: "8f1c2a9e-mbrg" },
    ]);
  });
});
