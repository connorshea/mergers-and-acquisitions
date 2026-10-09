import { describe, expect, it } from "vite-plus/test";
import type { Item } from "./compare.ts";
import { costUsd, parseReview, renderItem } from "./llm-review.ts";

const labels: Record<string, string> = {
  P31: "instance of",
  P577: "publication date",
  P1733: "Steam application ID",
  Q7889: "video game",
};
const labelOf = (id: string) => labels[id];

const item: Item = {
  id: "Q1",
  labels: { en: "Portal", de: "Portal", ja: "ポータル" },
  descriptions: { en: "2007 video game" },
  aliases: {},
  sitelinks: { enwiki: "Portal (video game)", dewiki: "Portal (Computerspiel)" },
  sitelinkBadges: { dewiki: ["Q70893996"] },
  statements: {
    P1733: [{ type: "external-id", value: "400" }],
    P577: [{ type: "time", value: "+2007-10-00T00:00:00Z" }],
    P31: [
      { type: "item", value: "Q7889" },
      { type: "item", value: "Q999" },
    ],
  },
};

describe("renderItem", () => {
  const text = renderItem(item, labelOf);

  it("groups labels shared across languages, most-shared first", () => {
    expect(text).toContain('Labels:\n  "Portal" [en, de]\n  "ポータル" [ja]');
  });

  it("lists instance of first, names known ids, and leaves unknown QIDs bare", () => {
    const statements = text.slice(text.indexOf("Statements:"));
    expect(statements.split("\n")[1]).toBe("  instance of (P31): video game (Q7889); Q999");
  });

  it("trims a time to its precision and marks external identifiers", () => {
    expect(text).toContain("  publication date (P577): 2007-10");
    expect(text).toContain("  Steam application ID (P1733) [external identifier]: 400");
  });

  it("marks redirect sitelinks", () => {
    expect(text).toContain('  dewiki: "Portal (Computerspiel)" (redirect)');
    expect(text).toMatch(/^  enwiki: "Portal \(video game\)"$/m);
  });
});

describe("parseReview", () => {
  it("reads a well-formed answer and clamps the probability", () => {
    expect(
      parseReview('{"verdict":"same","probability":1.2,"rationale":"Same Steam ID."}'),
    ).toEqual({ verdict: "same", probability: 1, rationale: "Same Steam ID." });
  });

  it("rejects anything outside the schema", () => {
    expect(parseReview("not json")).toBeNull();
    expect(parseReview('{"verdict":"maybe","probability":0.5,"rationale":""}')).toBeNull();
    expect(parseReview('{"verdict":"same","probability":"high","rationale":""}')).toBeNull();
  });
});

describe("costUsd", () => {
  it("halves the price for batches and bills cache reads at the model's rate", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    };
    // Opus 5.5: $4 in, $20 out, cache reads at 0.05x ($0.20).
    expect(costUsd("claude-opus-5-5", usage, false)).toBeCloseTo(24.2);
    expect(costUsd("claude-opus-5-5", usage, true)).toBeCloseTo(12.1);
  });
});
