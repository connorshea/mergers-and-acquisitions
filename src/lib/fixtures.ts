// Hand-authored example item pairs. These drive the demo comparison view and
// the compare.test.ts unit tests. They are illustrative fixtures, not real
// Wikidata data (which arrives via the sync jobs in later phases).

import type { Item } from "./compare.ts";

export interface Example {
  name: string;
  a: Item;
  b: Item;
}

export const EXAMPLES: Example[] = [
  {
    name: "Game with conflicts",
    a: {
      id: "Q100001",
      labels: { en: "Starfall Drift", de: "Starfall Drift" },
      descriptions: { en: "2019 video game" },
      aliases: { en: ["Starfall"] },
      sitelinks: { enwiki: "Starfall Drift" },
      statements: {
        P31: [{ type: "item", value: "Q7889", label: "video game" }],
        P136: [{ type: "item", value: "Q744038", label: "role-playing video game" }],
        P178: [{ type: "item", value: "Q100010", label: "Lantern Forge" }],
        P123: [{ type: "item", value: "Q100011", label: "Meridian Games" }],
        P400: [
          { type: "item", value: "Q1406", label: "Microsoft Windows" },
          { type: "item", value: "Q5014725", label: "PlayStation 4" },
        ],
        P577: [{ type: "time", value: "2019-03-12" }],
        P856: [{ type: "url", value: "https://starfalldrift.com" }],
        P1733: [{ type: "external-id", value: "812340" }],
        P404: [{ type: "item", value: "Q208850", label: "single-player video game" }],
      },
    },
    b: {
      id: "Q100002",
      labels: { en: "Starfall Drift", fr: "Starfall Drift" },
      descriptions: { en: "action role-playing game released in 2019" },
      aliases: { en: ["Star Fall Drift", "Starfall"] },
      sitelinks: { enwiki: "Starfall Drift (video game)", dewiki: "Starfall Drift" },
      statements: {
        P31: [{ type: "item", value: "Q7889", label: "video game" }],
        P136: [{ type: "item", value: "Q1422746", label: "action role-playing game" }],
        P123: [{ type: "item", value: "Q100011", label: "Meridian Games" }],
        P400: [
          { type: "item", value: "Q1406", label: "Microsoft Windows" },
          { type: "item", value: "Q19610114", label: "Nintendo Switch" },
        ],
        P577: [{ type: "time", value: "2019" }],
        P856: [{ type: "url", value: "http://www.starfalldrift.com/" }],
        P1733: [{ type: "external-id", value: "812341" }],
        P2725: [{ type: "external-id", value: "1207658924" }],
        P1476: [{ type: "string", value: "Starfall Drift" }],
      },
    },
  },
  {
    name: "Clean merge (author)",
    a: {
      id: "Q100201",
      labels: { en: "Miriam Okafor" },
      descriptions: { en: "Nigerian novelist" },
      aliases: {},
      sitelinks: { enwiki: "Miriam Okafor" },
      statements: {
        P31: [{ type: "item", value: "Q5", label: "human" }],
        P569: [{ type: "time", value: "1978-05-03" }],
        P27: [{ type: "item", value: "Q1033", label: "Nigeria" }],
        P106: [{ type: "item", value: "Q6625963", label: "novelist" }],
        P214: [{ type: "external-id", value: "305418833" }],
      },
    },
    b: {
      id: "Q100340",
      labels: { en: "Miriam Okafor", ig: "Miriam Okafor" },
      descriptions: { fr: "romancière nigériane" },
      aliases: { en: ["M. Okafor"] },
      sitelinks: { igwiki: "Miriam Okafor" },
      statements: {
        P31: [{ type: "item", value: "Q5", label: "human" }],
        P569: [{ type: "time", value: "1978" }],
        P27: [{ type: "item", value: "Q1033", label: "Nigeria" }],
        P106: [
          { type: "item", value: "Q6625963", label: "novelist" },
          { type: "item", value: "Q49757", label: "poet" },
        ],
        P2002: [{ type: "external-id", value: "miriamokafor" }],
      },
    },
  },
  {
    name: "Different things (film vs novel)",
    a: {
      id: "Q100450",
      labels: { en: "The Glass Orchard" },
      descriptions: { en: "2015 film directed by Hana Lindqvist" },
      aliases: {},
      sitelinks: { enwiki: "The Glass Orchard (film)" },
      statements: {
        P31: [{ type: "item", value: "Q11424", label: "film" }],
        P577: [{ type: "time", value: "2015-09-18" }],
        P57: [{ type: "item", value: "Q100460", label: "Hana Lindqvist" }],
        P136: [{ type: "item", value: "Q130232", label: "drama film" }],
        P495: [{ type: "item", value: "Q34", label: "Sweden" }],
      },
    },
    b: {
      id: "Q100612",
      labels: { en: "The Glass Orchard", sv: "Glasträdgården" },
      descriptions: { en: "2009 novel by Elin Berg" },
      aliases: {},
      sitelinks: { enwiki: "The Glass Orchard (novel)", svwiki: "Glasträdgården" },
      statements: {
        P31: [{ type: "item", value: "Q7725634", label: "literary work" }],
        P577: [{ type: "time", value: "2009" }],
        P50: [{ type: "item", value: "Q100613", label: "Elin Berg" }],
        P136: [{ type: "item", value: "Q8261", label: "novel" }],
        P495: [{ type: "item", value: "Q34", label: "Sweden" }],
      },
    },
  },
  {
    name: "Company renamed",
    a: {
      id: "Q100700",
      labels: { en: "Meridian Games" },
      descriptions: { en: "video game developer" },
      aliases: {},
      sitelinks: { enwiki: "Meridian Games" },
      statements: {
        P31: [{ type: "item", value: "Q4830453", label: "business" }],
        P571: [{ type: "time", value: "2004-02" }],
        P159: [{ type: "item", value: "Q16552", label: "Denver" }],
        P856: [{ type: "url", value: "https://www.meridiangames.com/" }],
        P1128: [{ type: "quantity", value: "120" }],
      },
    },
    b: {
      id: "Q100812",
      labels: { en: "Meridian Interactive" },
      descriptions: { en: "American video game developer" },
      aliases: { en: ["Meridian Games"] },
      sitelinks: {},
      statements: {
        P31: [{ type: "item", value: "Q4830453", label: "business" }],
        P571: [{ type: "time", value: "2004" }],
        P159: [{ type: "item", value: "Q16552", label: "Denver" }],
        P856: [{ type: "url", value: "https://meridiangames.com" }],
        P1128: [{ type: "quantity", value: "124" }],
        P1441: [{ type: "item", value: "Q100001", label: "Starfall Drift" }],
      },
    },
  },
];
