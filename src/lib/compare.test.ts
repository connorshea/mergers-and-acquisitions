import { describe, expect, it } from "vite-plus/test";
import {
  bestNameSimilarity,
  buildRows,
  compareValues,
  installment,
  type Item,
  isDeclaredDifferent,
  isSeriesSequelPair,
  normalize,
  orderByAge,
  scoreCandidate,
  stringSimilarity,
} from "./compare";
import { EXAMPLES } from "./fixtures";

const byName = Object.fromEntries(EXAMPLES.map((e) => [e.name, e]));

describe("normalize / stringSimilarity", () => {
  it("strips scheme, www and trailing slash", () => {
    expect(normalize("https://www.example.com/")).toBe("example.com");
    expect(normalize("  Foo   Bar ")).toBe("foo bar");
  });

  it("treats normalized-equal strings as identical", () => {
    expect(stringSimilarity("https://meridiangames.com", "https://www.meridiangames.com/")).toBe(1);
  });

  it("scores unrelated strings low", () => {
    expect(stringSimilarity("Meridian Games", "Totally Different")).toBeLessThan(0.5);
  });
});

describe("compareValues", () => {
  it("matches times on year with differing precision", () => {
    expect(
      compareValues({ type: "time", value: "2019-03-12" }, { type: "time", value: "2019" }),
    ).toEqual(["similar", "same year, different precision"]);
  });

  it("requires exact match for external ids", () => {
    expect(
      compareValues(
        { type: "external-id", value: "812340" },
        { type: "external-id", value: "812341" },
      )[0],
    ).toBe("distinct");
  });

  it("treats different types as distinct", () => {
    expect(compareValues({ type: "url", value: "x" }, { type: "string", value: "x" })[0]).toBe(
      "distinct",
    );
  });
});

describe("buildRows (behavior-preserving extraction)", () => {
  it("flags conflicting descriptions and same-wiki sitelinks as blockers", () => {
    const ex = byName["Game with conflicts"];
    const [from, into] = orderByAge(ex.a, ex.b);
    const rows = buildRows(from, into);

    const desc = rows.find((r) => r.key === "description:en");
    expect(desc?.status).toBe("distinct");
    expect(desc?.blocker).toBe(true);

    const sitelink = rows.find((r) => r.key === "sitelink:enwiki");
    expect(sitelink?.blocker).toBe(true);

    // instance of agrees on both items.
    expect(rows.find((r) => r.key === "P31")?.status).toBe("identical");
    // statements never block a merge.
    expect(rows.filter((r) => r.kind === "statement").every((r) => !r.blocker)).toBe(true);
  });

  it("cross-matches a renamed label against the other item's alias", () => {
    const ex = byName["Company renamed"];
    const rows = buildRows(ex.a, ex.b);
    const label = rows.find((r) => r.key === "label:en");
    expect(label?.status).toBe("similar");
    expect(
      [...(label?.a ?? []), ...(label?.b ?? [])].some((v) => v.note?.startsWith("matches ")),
    ).toBe(true);
  });

  it("backfills item-value display labels from valueLabels, leaving existing ones", () => {
    const base = { descriptions: {}, aliases: {}, sitelinks: {} };
    const a: Item = {
      ...base,
      id: "Q1",
      labels: { en: "Game A" },
      statements: {
        P136: [{ type: "item", value: "Q23916" }], // no label
        P400: [{ type: "item", value: "Q10676", label: "Existing Label" }], // keep
      },
    };
    const b: Item = {
      ...base,
      id: "Q2",
      labels: { en: "Game B" },
      statements: { P136: [{ type: "item", value: "Q828322" }] },
    };
    const rows = buildRows(a, b, {}, { Q23916: "action game", Q10676: "should-not-override" });
    const genre = rows.find((r) => r.key === "P136");
    expect(genre?.a.find((v) => v.value === "Q23916")?.label).toBe("action game");
    const platform = rows.find((r) => r.key === "P400");
    expect(platform?.a.find((v) => v.value === "Q10676")?.label).toBe("Existing Label");
  });
});

describe("scoreCandidate", () => {
  const scored = Object.fromEntries(EXAMPLES.map((e) => [e.name, scoreCandidate(e.a, e.b)]));

  it("ranks genuine duplicates above clearly-distinct items", () => {
    const distinct = scored["Different things (film vs novel)"];
    expect(distinct.confidence).toBeLessThan(0.15);

    for (const name of ["Game with conflicts", "Clean merge (author)", "Company renamed"]) {
      expect(scored[name].confidence).toBeGreaterThan(distinct.confidence);
    }
  });

  it("gives strong signals to same-subject pairs", () => {
    expect(scored["Game with conflicts"].confidence).toBeGreaterThan(0.4);
    expect(scored["Clean merge (author)"].confidence).toBeGreaterThan(0.4);
  });

  it("explains its reasoning", () => {
    expect(scored["Game with conflicts"].reasons).toContain("identical label");
    expect(scored["Game with conflicts"].reasons).toContain("same instance of (P31)");
    expect(scored["Different things (film vs novel)"].reasons).toContain(
      "different instance of (P31)",
    );
    expect(scored["Company renamed"].reasons).toContain("label matches the other item's alias");
  });

  it("flags merge blockers without sinking confidence", () => {
    // The clean author pair has no conflicting description/sitelink.
    expect(scored["Clean merge (author)"].hasBlocker).toBe(false);
    // The conflicting game and the distinct film/novel both have blockers.
    expect(scored["Game with conflicts"].hasBlocker).toBe(true);
    expect(scored["Different things (film vs novel)"].hasBlocker).toBe(true);
  });

  it("is symmetric in its two arguments", () => {
    for (const e of EXAMPLES) {
      expect(scoreCandidate(e.a, e.b).confidence).toBeCloseTo(scoreCandidate(e.b, e.a).confidence);
    }
  });
});

describe("installment / sequel detection", () => {
  it("parses trailing arabic and Roman installment numbers", () => {
    expect(installment("Revenge on the Streets 2")).toEqual({
      base: "revenge on the streets",
      num: 2,
    });
    expect(installment("Final Fantasy VII")).toEqual({ base: "final fantasy", num: 7 });
    expect(installment("Spinning_Kid_2")).toEqual({ base: "spinning_kid", num: 2 });
    expect(installment("Portal")).toEqual({ base: "portal", num: null });
    // An internal number is not a trailing installment.
    expect(installment("Left 4 Dead")).toEqual({ base: "left 4 dead", num: null });
  });

  it("recognizes same-base / different-number pairs as sequels", () => {
    const base = { descriptions: {}, aliases: {}, sitelinks: {}, statements: {} };
    const a: Item = { ...base, id: "Q2", labels: { en: "Revenge on the Streets 2" } };
    const b: Item = { ...base, id: "Q1", labels: { en: "Revenge on the Streets" } };
    const c: Item = { ...base, id: "Q3", labels: { en: "Portal 2" } };
    const c2: Item = { ...base, id: "Q4", labels: { en: "Portal 2" } };

    expect(isSeriesSequelPair(a, b)).toBe(true);
    expect(isSeriesSequelPair(c, c2)).toBe(false); // same title, same number
    expect(isSeriesSequelPair(a, c)).toBe(false); // different bases
  });
});

describe("scoreCandidate — sequel and weak-id handling", () => {
  const stmt = (extra: Record<string, unknown>) => ({
    P31: [{ type: "item" as const, value: "Q7889" }],
    ...extra,
  });
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };

  it("caps a sequel pair below the persistence floor despite shared signals", () => {
    // A game and its sequel: same developer Facebook page (weak id), same P31,
    // similar label — the exact false positive we saw in production.
    const a: Item = {
      ...base,
      id: "Q114881600",
      labels: { en: "Revenge on the Streets 2" },
      statements: stmt({
        P2013: [{ type: "external-id", value: "DevStudioPage" }],
        P178: [{ type: "item", value: "Q114881581" }],
      }),
    };
    const b: Item = {
      ...base,
      id: "Q114881591",
      labels: { en: "Revenge on the Streets" },
      statements: stmt({
        P2013: [{ type: "external-id", value: "DevStudioPage" }],
        P178: [{ type: "item", value: "Q114881581" }],
      }),
    };
    const result = scoreCandidate(a, b);
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain("sequel");
  });

  it("weights a shared account/social id far below a per-title id", () => {
    // Distinct labels so the shared id is the dominant signal and neither score
    // saturates at the 1.0 cap, exposing the full weighting gap.
    const strongA: Item = {
      ...base,
      id: "Q10",
      labels: { en: "Alpha Quest" },
      statements: stmt({ P1733: [{ type: "external-id", value: "555" }] }),
    };
    const strongB: Item = {
      ...base,
      id: "Q11",
      labels: { en: "Beta Voyage" },
      statements: stmt({ P1733: [{ type: "external-id", value: "555" }] }),
    };
    const weakA: Item = {
      ...base,
      id: "Q12",
      labels: { en: "Alpha Quest" },
      statements: stmt({ P2013: [{ type: "external-id", value: "shared-page" }] }),
    };
    const weakB: Item = {
      ...base,
      id: "Q13",
      labels: { en: "Beta Voyage" },
      statements: stmt({ P2013: [{ type: "external-id", value: "shared-page" }] }),
    };
    const strong = scoreCandidate(strongA, strongB);
    const weak = scoreCandidate(weakA, weakB);
    expect(strong.confidence).toBeGreaterThan(weak.confidence + 0.3);
    expect(strong.reasons).toContain("shares external identifier: Steam application ID");
    expect(weak.reasons.some((r) => r.startsWith("shares account/social identifier"))).toBe(true);
  });

  it("ignores non-identifier shared values (e.g. review score) when a predicate is given", () => {
    // Two unrelated games that happen to share a review score (P444, a String
    // property, not an ExternalId) — the false positive we saw in production.
    const a: Item = {
      ...base,
      id: "Q200",
      labels: { en: "Warhammer 40,000: Mechanicus II" },
      statements: stmt({ P444: [{ type: "external-id", value: "71/100" }] }),
    };
    const b: Item = {
      ...base,
      id: "Q201",
      labels: { en: "Just Dance 2021" },
      statements: stmt({ P444: [{ type: "external-id", value: "71/100" }] }),
    };
    // P444 is not an ExternalId property, so the predicate excludes it.
    const withPredicate = scoreCandidate(a, b, { isIdentifierProp: (pid) => pid === "P1733" });
    const legacy = scoreCandidate(a, b);
    expect(withPredicate.reasons.some((r) => r.includes("external identifier"))).toBe(false);
    expect(legacy.reasons.some((r) => r.includes("external identifier"))).toBe(true);
    expect(withPredicate.confidence).toBeLessThan(legacy.confidence - 0.4);
  });

  it("penalises clearly-distinct names and rewards matching ones", () => {
    const stmts = stmt({ P178: [{ type: "item" as const, value: "Q555", label: "Studio" }] });
    const sharedName: Item = {
      ...base,
      id: "Q20",
      labels: { en: "Alpha Quest" },
      statements: stmts,
    };
    const sameSubject: Item = {
      ...base,
      id: "Q21",
      labels: { en: "Alpha Quest" },
      statements: stmts,
    };
    const other: Item = {
      ...base,
      id: "Q22",
      labels: { en: "Zeta Marauder" },
      statements: stmts,
    };

    const matching = scoreCandidate(sharedName, sameSubject);
    const distinct = scoreCandidate(sharedName, other);

    expect(matching.confidence).toBeGreaterThan(distinct.confidence + 0.4);
    // Different names alone drop an otherwise-similar pair below the 0.3 floor.
    expect(distinct.confidence).toBeLessThan(0.3);
    expect(distinct.reasons.some((r) => r.startsWith("different names"))).toBe(true);
  });

  it("bestNameSimilarity matches a label against the other item's alias", () => {
    const a: Item = { ...base, id: "Q30", labels: { en: "Meridian Games" }, statements: stmt({}) };
    const b: Item = {
      ...base,
      id: "Q31",
      labels: { en: "Meridian Interactive" },
      aliases: { en: ["Meridian Games"] },
      statements: stmt({}),
    };
    expect(bestNameSimilarity(a, b)).toBe(1);
    expect(bestNameSimilarity(a, b, false)).toBeLessThan(1);
  });

  it("disqualifies a pair whose external identifiers all differ (>6)", () => {
    const ids = (prefix: string) =>
      Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [
          `P900${i + 1}`,
          [{ type: "external-id" as const, value: `${prefix}${i}` }],
        ]),
      );
    // Identical name + same P31 would otherwise score high, but seven external
    // ids present on both items with entirely different values give it away.
    const a: Item = {
      ...base,
      id: "Q40",
      labels: { en: "Look-Alike" },
      statements: stmt(ids("a")),
    };
    const b: Item = {
      ...base,
      id: "Q41",
      labels: { en: "Look-Alike" },
      statements: stmt(ids("b")),
    };
    const isId = (pid: string) => pid.startsWith("P900");
    const result = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(result.confidence).toBeLessThanOrEqual(0.05);
    expect(result.reasons[0]).toContain("external identifiers differ");
  });

  it('zeroes out a pair one item declares "different from" the other (P1889)', () => {
    // Identical label + P31 + shared per-title id would otherwise score ~1.0.
    const a: Item = {
      ...base,
      id: "Q100",
      labels: { en: "Look-Alike" },
      statements: stmt({
        P1733: [{ type: "external-id", value: "42" }],
        P1889: [{ type: "item", value: "Q101" }],
      }),
    };
    const b: Item = {
      ...base,
      id: "Q101",
      labels: { en: "Look-Alike" },
      statements: stmt({ P1733: [{ type: "external-id", value: "42" }] }),
    };
    expect(isDeclaredDifferent(a, b)).toBe(true);
    const result = scoreCandidate(a, b);
    expect(result.confidence).toBe(0);
    expect(result.reasons[0]).toContain("different from");
    // Symmetric: the declaration counts from whichever side holds it.
    expect(scoreCandidate(b, a).confidence).toBe(0);
  });
});
