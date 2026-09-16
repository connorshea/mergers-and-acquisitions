import { describe, expect, it } from "vite-plus/test";
import {
  classifyValue,
  type DumpGame,
  externalIdRows,
  mapDumpGame,
  primaryLabel,
  primaryType,
} from "./wikidata";

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
    ]);
  });
});
