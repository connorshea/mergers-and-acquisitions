import { describe, expect, it } from "vite-plus/test";
import {
  bestRank,
  datatypeName,
  type Entity,
  entityToItem,
  isInstanceOf,
  propertyRowFromEntity,
  type Statement,
} from "./wikibase.ts";

const itemRef = (qid: string) => ({
  type: "wikibase-entityid",
  value: { "entity-type": "item", "numeric-id": Number(qid.slice(1)), id: qid },
});

function claim(
  property: string,
  datatype: string,
  datavalue: { type: string; value: unknown },
  rank: Statement["rank"] = "normal",
  qualifiers?: Statement["qualifiers"],
): Statement {
  return { mainsnak: { snaktype: "value", property, datatype, datavalue }, rank, qualifiers };
}

const game: Entity = {
  type: "item",
  id: "Q189784",
  labels: { en: { value: "Doom" }, de: { value: "Doom" } },
  descriptions: { en: { value: "1993 video game" } },
  aliases: { en: [{ value: "DOOM" }, { value: "Doom 1" }] },
  sitelinks: { enwiki: { title: "Doom (1993 video game)" } },
  claims: {
    P31: [claim("P31", "wikibase-item", itemRef("Q7889"))],
    P577: [claim("P577", "time", { type: "time", value: { time: "+1993-00-00T00:00:00Z" } })],
    P1733: [
      claim("P1733", "external-id", { type: "string", value: "2280" }, "normal", {
        P4070: [
          {
            snaktype: "value",
            property: "P4070",
            datatype: "wikibase-item",
            datavalue: itemRef("Q123"),
          },
        ],
      }),
    ],
    P348: [claim("P348", "string", { type: "string", value: "1.9" })],
    P856: [claim("P856", "url", { type: "string", value: "https://example.org" })],
    P1476: [
      claim("P1476", "monolingualtext", {
        type: "monolingualtext",
        value: { text: "DOOM", language: "en" },
      }),
    ],
    P2047: [claim("P2047", "quantity", { type: "quantity", value: { amount: "+12", unit: "1" } })],
    P999: [{ mainsnak: { snaktype: "somevalue", property: "P999" }, rank: "normal" }],
  },
};

describe("entityToItem", () => {
  it("carries terms, sitelinks, and datatype-classified statement values", () => {
    const item = entityToItem(game);
    expect(item.id).toBe("Q189784");
    expect(item.labels).toEqual({ en: "Doom", de: "Doom" });
    expect(item.descriptions).toEqual({ en: "1993 video game" });
    expect(item.aliases).toEqual({ en: ["DOOM", "Doom 1"] });
    expect(item.sitelinks).toEqual({ enwiki: "Doom (1993 video game)" });
    expect(item.statements).toEqual({
      P31: [{ type: "item", value: "Q7889" }],
      // Year precision survives as the `00` reduced form compare.ts reads.
      P577: [{ type: "time", value: "+1993-00-00T00:00:00Z" }],
      P1733: [{ type: "external-id", value: "2280", sharedWith: ["Q123"] }],
      P348: [{ type: "string", value: "1.9" }], // string datatype, never an id
      P856: [{ type: "url", value: "https://example.org" }],
      P1476: [{ type: "string", value: "DOOM" }],
      P2047: [{ type: "quantity", value: "+12" }],
      P999: [{ type: "somevalue", value: "" }],
    });
  });

  it("drops properties with no live value", () => {
    const item = entityToItem({
      id: "Q1",
      claims: { P31: [claim("P31", "wikibase-item", itemRef("Q7889"), "deprecated")] },
    });
    expect(item.statements).toEqual({});
  });
});

describe("bestRank", () => {
  it("keeps only preferred statements when any exist, else the normals", () => {
    const pref = claim("P31", "wikibase-item", itemRef("Q1"), "preferred");
    const norm = claim("P31", "wikibase-item", itemRef("Q2"));
    const dep = claim("P31", "wikibase-item", itemRef("Q3"), "deprecated");
    expect(bestRank([pref, norm, dep])).toEqual([pref]);
    expect(bestRank([norm, dep])).toEqual([norm]);
    expect(bestRank([dep])).toEqual([]);
  });
});

describe("isInstanceOf", () => {
  it("matches a best-rank P31 value only", () => {
    expect(isInstanceOf(entityToItem(game), "Q7889")).toBe(true);
    expect(isInstanceOf(entityToItem(game), "Q21125433")).toBe(false);
    const overridden = entityToItem({
      id: "Q2",
      claims: {
        P31: [
          claim("P31", "wikibase-item", itemRef("Q7889")),
          claim("P31", "wikibase-item", itemRef("Q7397"), "preferred"),
        ],
      },
    });
    expect(isInstanceOf(overridden, "Q7889")).toBe(false);
  });
});

describe("datatypeName", () => {
  it("maps entity-JSON datatypes to the SPARQL property-type names", () => {
    expect(datatypeName("external-id")).toBe("ExternalId");
    expect(datatypeName("wikibase-item")).toBe("WikibaseItem");
    expect(datatypeName("globe-coordinate")).toBe("GlobeCoordinate");
    expect(datatypeName("commonsMedia")).toBe("CommonsMedia");
    expect(datatypeName("monolingualtext")).toBe("Monolingualtext");
    expect(datatypeName("string")).toBe("String");
  });
});

describe("propertyRowFromEntity", () => {
  const steam: Entity = {
    type: "property",
    id: "P1733",
    datatype: "external-id",
    labels: { en: { value: "Steam application ID" } },
    claims: {
      P1630: [
        claim("P1630", "string", { type: "string", value: "https://old.example/$1" }),
        claim(
          "P1630",
          "string",
          { type: "string", value: "https://store.steampowered.com/app/$1/" },
          "preferred",
        ),
      ],
      P31: [claim("P31", "wikibase-item", itemRef("Q24075706"))],
    },
  };

  it("builds the properties row with the preferred formatter and the mirror flag", () => {
    expect(propertyRowFromEntity(steam)).toEqual({
      pid: "P1733",
      label: "Steam application ID",
      datatype: "ExternalId",
      formatterUrl: "https://store.steampowered.com/app/$1/",
      mirrorsWikidata: true,
    });
  });

  it("returns null for non-properties and properties without an English label", () => {
    expect(propertyRowFromEntity(game)).toBeNull();
    expect(propertyRowFromEntity({ ...steam, labels: { de: { value: "Steam-ID" } } })).toBeNull();
    expect(propertyRowFromEntity({ ...steam, id: "Q1" })).toBeNull();
  });

  it("leaves formatter/mirror empty when absent", () => {
    expect(propertyRowFromEntity({ ...steam, claims: {} })).toMatchObject({
      formatterUrl: null,
      mirrorsWikidata: false,
    });
  });
});
