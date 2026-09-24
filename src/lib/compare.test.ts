import { describe, expect, it } from "vite-plus/test";
import {
  bestNameSimilarity,
  blockingLabelKey,
  buildRows,
  compareValues,
  formatIdUrl,
  installment,
  type Item,
  crossReferenceProps,
  isAutoIgnoredConflict,
  isDeclaredDifferent,
  isSeriesSequelPair,
  mergeConflicts,
  normalize,
  orderByAge,
  scoreCandidate,
  sharedIdentifierProps,
  stringSimilarity,
} from "./compare.ts";
import { EXAMPLES } from "./fixtures.ts";

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
  it("flags a genuine precision mismatch (year-precision vs day) as such", () => {
    // Year precision is encoded with 00 month/day (`+2019-00-00T…`).
    expect(
      compareValues(
        { type: "time", value: "+2019-03-12T00:00:00Z" },
        { type: "time", value: "+2019-00-00T00:00:00Z" },
      ),
    ).toEqual(["similar", "same year, different precision"]);
  });

  it("reports two same-precision days that differ by a day as a day apart, not a precision mismatch", () => {
    // Regression: 2022-11-11 vs 2022-11-12 are both day precision — the note must
    // not claim "different precision".
    expect(
      compareValues(
        { type: "time", value: "+2022-11-11T00:00:00Z" },
        { type: "time", value: "+2022-11-12T00:00:00Z" },
      ),
    ).toEqual(["similar", "one day apart"]);
  });

  it("reports same-year days in different months as a month difference", () => {
    expect(
      compareValues(
        { type: "time", value: "+2022-11-11T00:00:00Z" },
        { type: "time", value: "+2022-06-11T00:00:00Z" },
      ),
    ).toEqual(["similar", "same year, different month"]);
  });

  it("treats different years as distinct", () => {
    expect(
      compareValues(
        { type: "time", value: "+2022-11-11T00:00:00Z" },
        { type: "time", value: "+2006-01-20T00:00:00Z" },
      )[0],
    ).toBe("distinct");
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

  it("never treats two unknown values (somevalue) as identical", () => {
    // Their blank-node value strings must not be compared; an unknown value can't
    // be confirmed equal to another unknown value.
    expect(
      compareValues({ type: "somevalue", value: "" }, { type: "somevalue", value: "" }),
    ).toEqual(["distinct", "unknown value on both sides"]);
  });

  it("treats two explicit no-values (novalue) as identical", () => {
    expect(compareValues({ type: "novalue", value: "" }, { type: "novalue", value: "" })[0]).toBe(
      "identical",
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

  describe("sitelink to a redirect", () => {
    const base = { labels: {}, descriptions: {}, aliases: {}, statements: {} };
    const article: Item = {
      ...base,
      id: "Q65117434",
      sitelinks: { enwiki: "Loud & Dangerous: Live from Hollywood" },
    };
    const redirect: Item = {
      ...base,
      id: "Q1145650",
      sitelinks: { enwiki: "Loud and Dangerous: Live from Hollywood" },
      sitelinkBadges: { enwiki: ["Q70893996"] },
    };
    const row = (a: Item, b: Item) => buildRows(a, b).find((r) => r.key === "sitelink:enwiki")!;

    it("marks the badged side and names it in the note, still as a blocker", () => {
      const r = row(article, redirect);
      expect(r.blocker).toBe(true);
      expect(r.a.map((v) => v.redirect)).toEqual([undefined]);
      expect(r.b.map((v) => v.redirect)).toEqual([true]);
      expect(r.note).toMatch(/^Q1145650's page is a redirect/);
      expect(mergeConflicts(article, redirect)).toContain("sitelink");
    });

    it("accepts the intentional-redirect badge too", () => {
      const intentional = { ...redirect, sitelinkBadges: { enwiki: ["Q70894304"] } };
      expect(row(intentional, article).a[0].redirect).toBe(true);
    });

    it("says so when both pages are redirects", () => {
      const other = { ...article, sitelinkBadges: { enwiki: ["Q70893996"] } };
      expect(row(other, redirect).note).toMatch(/^both pages are redirects/);
    });

    it("keeps the generic note when neither side is badged", () => {
      const plain = { ...redirect, sitelinkBadges: { enwiki: ["Q17437796"] } }; // featured article
      expect(row(article, plain).note).toMatch(/^two different pages/);
    });
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

  it("annotates a statement row whose id is declared shared with the other item (P4070)", () => {
    const mk = (id: string, sharedWith?: string[]): Item => ({
      id,
      labels: { en: "Same Disc" },
      descriptions: {},
      aliases: {},
      sitelinks: {},
      statements: {
        P436: [{ type: "external-id", value: "mbrg-1", ...(sharedWith && { sharedWith }) }],
        P1733: [{ type: "external-id", value: "440" }],
      },
    });
    const rows = buildRows(mk("Q10", ["Q11"]), mk("Q11"));
    const p436 = rows.find((r) => r.key === "P436")!;
    expect(p436.status).toBe("identical"); // the values still agree…
    expect(p436.note).toContain("P4070"); // …but the row says why that means nothing
    expect(rows.find((r) => r.key === "P1733")!.note).toBeUndefined();
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

describe("mergeConflicts", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const game = (id: string, extra: Partial<Item> = {}): Item => ({
    id,
    labels: { en: "Same Game" },
    ...base,
    statements: { P31: [{ type: "item", value: "Q7889" }] },
    ...extra,
  });

  it("is empty for a pair wbmergeitems would accept as-is", () => {
    expect(mergeConflicts(game("Q2"), game("Q1"))).toEqual([]);
    // A description on one side only, or the same one on both, is fine.
    expect(mergeConflicts(game("Q2", { descriptions: { en: "x" } }), game("Q1"))).toEqual([]);
    expect(
      mergeConflicts(
        game("Q2", { descriptions: { en: "x" } }),
        game("Q1", { descriptions: { en: "x" } }),
      ),
    ).toEqual([]);
  });

  it("reports differing descriptions and clashing sitelinks from the fixture pair", () => {
    const ex = byName["Game with conflicts"];
    const [from, into] = orderByAge(ex.a, ex.b);
    expect(mergeConflicts(from, into)).toEqual(["description", "sitelink"]);
  });

  it("reports a statement on either item that points at the other", () => {
    const a = game("Q2", {
      statements: {
        P31: [{ type: "item", value: "Q7889" }],
        P1889: [{ type: "item", value: "Q1" }],
      },
    });
    expect(mergeConflicts(a, game("Q1"))).toEqual(["statement"]);
    expect(mergeConflicts(game("Q1"), a)).toEqual(["statement"]);
    // Linking to some third item is not a conflict.
    const c = game("Q2", {
      statements: {
        P31: [{ type: "item", value: "Q7889" }],
        P155: [{ type: "item", value: "Q9" }],
      },
    });
    expect(mergeConflicts(c, game("Q1"))).toEqual([]);
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
    // The conflicted game differs on a Steam id and on its enwiki page (the
    // likely-redirect "… (video game)" shape), each docked a little, so it sits
    // below the clean pair but well above clearly-distinct items.
    expect(scored["Game with conflicts"].confidence).toBeGreaterThan(0.3);
    expect(scored["Clean merge (author)"].confidence).toBeGreaterThan(0.4);
  });

  it("docks, but does not sink, a pair linking different pages on the same wiki", () => {
    const e = EXAMPLES.find((x) => x.name === "Clean merge (author)")!;
    const clash = scoreCandidate(e.a, {
      ...e.b,
      sitelinks: { ...e.b.sitelinks, enwiki: "Miriam Okafor (novelist)" },
    });
    const clean = scored["Clean merge (author)"];
    expect(clash.hasBlocker).toBe(true);
    expect(clash.confidence).toBeLessThan(clean.confidence);
    expect(clash.confidence).toBeGreaterThan(0.4);
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

  it("does not treat an auto-ignored (description) conflict as a blocker", () => {
    const base = {
      aliases: {},
      sitelinks: {},
      statements: { P31: [{ type: "item" as const, value: "Q7889" }] },
    };
    const a: Item = {
      id: "Q2",
      labels: { en: "Same Game" },
      descriptions: { en: "2019 video game" },
      ...base,
    };
    const b: Item = {
      id: "Q1",
      labels: { en: "Same Game" },
      descriptions: { en: "an action RPG" },
      ...base,
    };

    // The differing description is a real wbmergeitems conflict...
    expect(mergeConflicts(a, b)).toEqual(["description"]);
    // ...but the merge flow auto-ignores it, so it is not surfaced as a blocker
    // and does not add a "would block the merge" reason.
    const score = scoreCandidate(a, b);
    expect(score.hasBlocker).toBe(false);
    expect(score.reasons.some((r) => r.includes("would block the merge"))).toBe(false);
  });
});

describe("isAutoIgnoredConflict", () => {
  it("matches description rows only", () => {
    expect(isAutoIgnoredConflict("description:en")).toBe(true);
    expect(isAutoIgnoredConflict("sitelink:enwiki")).toBe(false);
    expect(isAutoIgnoredConflict("P31")).toBe(false);
  });
});

describe("blockingLabelKey / punctuation-insensitive blocking", () => {
  it("collapses titles that differ only in punctuation to one key", () => {
    // Regression: "Go West: A Lucky Luke Adventure" (Q16571916) and
    // "Go West! A Lucky Luke Adventure" (Q139781716) are the same game but were
    // never blocked together, because the old normalize()-based key kept the
    // ':' vs '!'. They must share a blocking key so the hunt scores the pair.
    expect(blockingLabelKey("Go West: A Lucky Luke Adventure")).toBe(
      blockingLabelKey("Go West! A Lucky Luke Adventure"),
    );
    // straight vs curly apostrophe, en/em dashes, trailing punctuation
    expect(blockingLabelKey("Assassin's Creed")).toBe(blockingLabelKey("Assassin’s Creed"));
    expect(blockingLabelKey("Half-Life")).toBe(blockingLabelKey("Half—Life"));
  });

  it("builds external-id URLs from a formatter template, and only when it applies", () => {
    expect(formatIdUrl("https://store.steampowered.com/app/$1/", "268220")).toBe(
      "https://store.steampowered.com/app/268220/",
    );
    // No template, or a template without the placeholder → no link.
    expect(formatIdUrl(undefined, "268220")).toBeNull();
    expect(formatIdUrl("https://example.com/no-placeholder", "268220")).toBeNull();
    // A value that itself contains a slash substitutes literally.
    expect(formatIdUrl("https://tvtropes.org/pmwiki/pmwiki.php/$1", "VideoGame/Portal")).toBe(
      "https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/Portal",
    );
  });

  it("keeps accented letters and digits so distinct titles stay distinct", () => {
    // Sequels must not collapse into their base game.
    expect(blockingLabelKey("Portal")).not.toBe(blockingLabelKey("Portal 2"));
    // Diacritics are preserved (not folded), so this is intentionally NOT equal.
    expect(blockingLabelKey("Pokémon")).not.toBe(blockingLabelKey("Pokemon"));
    expect(blockingLabelKey("  Go   West:  ")).toBe("go west");
  });
});

describe("scoreCandidate — Go West regression (found as a candidate)", () => {
  // The two real items differ only by ':' vs '!' and share MobyGames ID
  // (P11688 = 44640). With the punctuation-insensitive blocking key they get
  // scored; this asserts the score itself is comfortably above the 0.4
  // persistence floor, so the pair surfaces as a merge candidate.
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const a: Item = {
    ...base,
    id: "Q139781716",
    labels: { en: "Go West! A Lucky Luke Adventure" },
    statements: {
      P31: [{ type: "item", value: "Q7889", label: "video game" }],
      P11688: [{ type: "external-id", value: "44640" }],
    },
  };
  const b: Item = {
    ...base,
    id: "Q16571916",
    labels: { en: "Go West: A Lucky Luke Adventure" },
    statements: {
      P31: [{ type: "item", value: "Q7889", label: "video game" }],
      P11688: [{ type: "external-id", value: "44640" }],
    },
  };

  it("scores the pair well above the persistence floor", () => {
    const result = scoreCandidate(a, b, { isIdentifierProp: (pid) => pid === "P11688" });
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.reasons.some((r) => r.includes("external identifier"))).toBe(true);
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

  describe("separate articles on many wikis", () => {
    // Same label, same P31, shared per-title id — a strong candidate on its own.
    const mk = (id: string, sitelinks: Record<string, string>, badges?: string[]): Item => ({
      ...base,
      id,
      labels: { en: "Harvest Moon" },
      sitelinks,
      ...(badges && {
        sitelinkBadges: Object.fromEntries(Object.keys(sitelinks).map((w) => [w, badges])),
      }),
      statements: stmt({ P5794: [{ type: "external-id", value: "harvest-moon" }] }),
    });
    const pages = (suffix: string, wikis: string[]) =>
      Object.fromEntries(wikis.map((w) => [w, `Harvest Moon${suffix}`]));
    const score = (a: Item, b: Item) =>
      scoreCandidate(a, b, { isIdentifierProp: (pid) => pid === "P5794" });

    it("caps the pair when three or more wikis keep a separate article for each", () => {
      const wikis = ["enwiki", "kowiki", "ptwiki"];
      const result = score(mk("Q1", pages("", wikis)), mk("Q2", pages(" (series)", wikis)));
      expect(result.confidence).toBeLessThanOrEqual(0.1);
      expect(result.reasons[0]).toMatch(/^3 wikis have a separate article/);
    });

    it("tolerates one or two clashes", () => {
      const wikis = ["enwiki", "kowiki"];
      const result = score(mk("Q1", pages("", wikis)), mk("Q2", pages(" (series)", wikis)));
      expect(result.confidence).toBeGreaterThan(0.4);
      expect(result.reasons.some((r) => r.includes("separate article"))).toBe(false);
    });

    it("doesn't count clashes where one side is a badged redirect", () => {
      const wikis = ["enwiki", "kowiki", "ptwiki"];
      const redirects = mk("Q2", pages(" (series)", wikis), ["Q70893996"]);
      const result = score(mk("Q1", pages("", wikis)), redirects);
      expect(result.confidence).toBeGreaterThan(0.4);
    });
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
    // Different names alone drop an otherwise-similar pair below the 0.4 floor.
    expect(distinct.confidence).toBeLessThan(0.4);
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

  it("penalises a differing release year for same-named games (no shared id)", () => {
    const mk = (id: string, year: string): Item => ({
      ...base,
      id,
      labels: { en: "Arena" },
      statements: stmt({ P577: [{ type: "time" as const, value: year }] }),
    });
    const near = scoreCandidate(mk("Q1", "2007-01-01"), mk("Q2", "2007-06-01")); // same year
    const far = scoreCandidate(mk("Q3", "2002-01-01"), mk("Q4", "2020-01-01")); // 18y apart
    expect(far.confidence).toBeLessThan(near.confidence);
    expect(far.confidence).toBeLessThan(0.4); // dropped below the persistence floor
    expect(far.reasons.some((r) => r.startsWith("publication/inception/birth years differ"))).toBe(
      true,
    );
  });

  it("does not apply a small year penalty when a strong shared id vouches for the pair", () => {
    const mk = (id: string, year: string): Item => ({
      ...base,
      id,
      labels: { en: "Arena" },
      statements: stmt({
        P577: [{ type: "time" as const, value: year }],
        P1733: [{ type: "external-id" as const, value: "999" }],
      }),
    });
    // A modest gap (< LARGE_YEAR_GAP, e.g. a regional-release difference) is
    // forgiven when a strong per-title id vouches for the pair.
    const result = scoreCandidate(mk("Q5", "2018"), mk("Q6", "2020"), {
      isIdentifierProp: (pid) => pid === "P1733",
    });
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(
      result.reasons.some((r) => r.startsWith("publication/inception/birth years differ")),
    ).toBe(false);
  });

  it("penalises a large publication-year gap even when a strong id is shared (Meltdown)", () => {
    // Two unrelated "Meltdown" games — 1986 and 2014 — that collide on a shared
    // external id. The id keeps the gap from being conclusive (a real duplicate
    // can carry an original and a re-release date), but the pair is docked hard
    // and held well off near-certain.
    const mk = (id: string, year: string): Item => ({
      ...base,
      id,
      labels: { en: "Meltdown" },
      statements: stmt({
        P31: [{ type: "item" as const, value: "Q7889", label: "video game" }],
        P577: [{ type: "time" as const, value: year }],
        P8229: [{ type: "external-id" as const, value: "3235" }],
      }),
    });
    const result = scoreCandidate(
      mk("Q15036797", "+1986-01-01T00:00:00Z"),
      mk("Q122202962", "+2014-06-05T00:00:00Z"),
      { isIdentifierProp: (pid) => pid === "P8229" },
    );
    expect(result.confidence).toBeLessThanOrEqual(0.6);
    expect(result.reasons).toContain("publication/inception/birth years differ by 28");
  });

  it("reads signed Wikibase years and compares inception and birth dates", () => {
    // Signed times (`+2014-…`) must parse as 2014, not 201; inception (P571)
    // and date of birth (P569) feed the same gap check as publication date.
    for (const pid of ["P577", "P571", "P569"]) {
      const mk = (id: string, time: string): Item => ({
        ...base,
        id,
        labels: { en: "Halo" },
        statements: stmt({ [pid]: [{ type: "time" as const, value: time }] }),
      });
      const result = scoreCandidate(
        mk("Q17504487", "+2014-01-01T00:00:00Z"),
        mk("Q5643301", "+1980-00-00T00:00:00Z"),
      );
      expect(result.confidence).toBeLessThanOrEqual(0.1);
      expect(result.reasons[0]).toBe(
        "publication/inception/birth years differ by 34 — almost certainly different subjects",
      );
    }
  });

  it('does not count a shared "different from" (P1889) target as agreement', () => {
    // Two unrelated bands both marked different from a third "Halo".
    const mk = (id: string): Item => ({
      ...base,
      id,
      labels: { en: "Halo" },
      statements: stmt({ P1889: [{ type: "item" as const, value: "Q55623" }] }),
    });
    const result = scoreCandidate(mk("Q17504487"), mk("Q5643301"));
    expect(result.reasons.some((r) => r.includes("shared statements agree"))).toBe(false);
  });

  it("ignores Wikidata-mirrored ids (vglist, GamerProfiles) as match or distinction evidence", () => {
    // A shared vglist id is circular (vglist mirrors Wikidata), so it must not
    // count as a strong shared identifier.
    const mkShared = (id: string): Item => ({
      ...base,
      id,
      labels: { en: "Echo" },
      statements: stmt({ P8351: [{ type: "external-id" as const, value: "500" }] }),
    });
    const shared = scoreCandidate(mkShared("Q1"), mkShared("Q2"), {
      isIdentifierProp: (pid) => pid === "P8351",
    });
    expect(shared.reasons.some((r) => r.startsWith("shares external identifier"))).toBe(false);

    // And a differing mirror id must not count toward the >6 distinct-external-id
    // disqualifier: five real differing ids plus two differing mirror ids is 7
    // raw, but only the five real ones count, so the disqualifier must not fire.
    const realIds = (prefix: string) =>
      Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          `P700${i}`,
          [{ type: "external-id" as const, value: `${prefix}${i}` }],
        ]),
      );
    const stmts = (prefix: string) => ({
      ...realIds(prefix),
      P8351: [{ type: "external-id" as const, value: `${prefix}-vg` }],
      P12001: [{ type: "external-id" as const, value: `${prefix}-gp` }],
    });
    const a: Item = { ...base, id: "Q3", labels: { en: "Echo" }, statements: stmt(stmts("a")) };
    const b: Item = { ...base, id: "Q4", labels: { en: "Echo" }, statements: stmt(stmts("b")) };
    const isId = (pid: string) => pid.startsWith("P700") || pid === "P8351" || pid === "P12001";
    const distinct = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(distinct.reasons.some((r) => r.includes("external identifiers differ"))).toBe(false);
  });

  it("ignores synced mirrors-Wikidata ids (P31=Q24075706) via isMirroredIdProp", () => {
    // Seven differing external ids on both items would trip the >6 distinct-id
    // disqualifier — but every one is an authority-control property that sources
    // its ids from Wikidata (e.g. VNDB P3180), supplied at runtime from the
    // synced properties table. None are in the hardcoded MIRRORED_ID_PROPS floor,
    // so this exercises the synced path specifically.
    const pids = ["P3180", "P9001", "P9002", "P9003", "P9004", "P9005", "P9006"];
    const mk = (id: string, prefix: string): Item => ({
      ...base,
      id,
      labels: { en: "Sync Echo" },
      statements: stmt(
        Object.fromEntries(
          pids.map((p, i) => [p, [{ type: "external-id" as const, value: `${prefix}${i}` }]]),
        ),
      ),
    });
    const a = mk("Q60", "a");
    const b = mk("Q61", "b");
    const isId = (pid: string) => pids.includes(pid);

    // Without the mirrored predicate the seven differing ids disqualify the pair.
    const withoutMirror = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(withoutMirror.reasons.some((r) => r.includes("external identifiers differ"))).toBe(true);

    // With it, all seven are mirrors, so none count and the disqualifier must not
    // fire — differing Wikidata-sourced ids are not evidence of distinct subjects.
    const withMirror = scoreCandidate(a, b, {
      isIdentifierProp: isId,
      isMirroredIdProp: (pid) => pids.includes(pid),
    });
    expect(withMirror.reasons.some((r) => r.includes("external identifiers differ"))).toBe(false);
  });

  it("caps a pair hard when two+ per-title ids differ, even with a shared id and identical name", () => {
    // Identical name, same P31 and a *shared* IGDB id would score very high, but
    // two per-title store pages differ (Steam + MobyGames) — distinct games.
    const a: Item = {
      ...base,
      id: "Q50",
      labels: { en: "Twin Peaks" },
      statements: stmt({
        P5794: [{ type: "external-id" as const, value: "shared-igdb" }],
        P1733: [{ type: "external-id" as const, value: "111" }],
        P11688: [{ type: "external-id" as const, value: "moby-a" }],
      }),
    };
    const b: Item = {
      ...base,
      id: "Q51",
      labels: { en: "Twin Peaks" },
      statements: stmt({
        P5794: [{ type: "external-id" as const, value: "shared-igdb" }],
        P1733: [{ type: "external-id" as const, value: "222" }],
        P11688: [{ type: "external-id" as const, value: "moby-b" }],
      }),
    };
    const isId = (pid: string) => ["P5794", "P1733", "P11688"].includes(pid);
    const result = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain("per-title identifiers differ");
  });

  it("counts itch.io URL (a url-typed value, not an ExternalId) toward the per-title rule", () => {
    // itch.io URL (P7294) is a `url` datatype; paired with a differing Steam id
    // that's two distinct per-title pages, so the cap fires by property id even
    // though isIdentifierProp excludes the url value.
    const mk = (id: string, steam: string, itch: string): Item => ({
      ...base,
      id,
      labels: { en: "Uncursed" },
      statements: stmt({
        P1733: [{ type: "external-id" as const, value: steam }],
        P7294: [{ type: "url" as const, value: itch }],
      }),
    });
    const result = scoreCandidate(
      mk("Q60", "111", "https://a.itch.io/uncursed"),
      mk("Q61", "222", "https://b.itch.io/uncursed"),
      { isIdentifierProp: (pid) => pid === "P1733" },
    );
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain("per-title identifiers differ");
  });

  it("caps two same-named bands whose Discogs and Freebase ids differ", () => {
    // Two different bands called "The Radiators" (Q7759214, Q3522403): identical
    // label and P31, and a shared Billboard artist id — but that id is just the
    // name as a slug, so it is only weak evidence, and the per-artist database
    // pages (Discogs, Freebase) differ. Their MusicBrainz ids differ too, but
    // MusicBrainz mirrors Wikidata (the synced `mirrors_wikidata` flag, passed
    // in production as isMirroredIdProp), so that is no evidence either way.
    const band = (id: string, mb: string, discogs: string, freebase: string): Item => ({
      ...base,
      id,
      labels: { en: "The Radiators" },
      statements: stmt({
        P31: [{ type: "item", value: "Q215380" }],
        P4208: [{ type: "external-id", value: "the-radiators" }],
        P434: [{ type: "external-id", value: mb }],
        P1953: [{ type: "external-id", value: discogs }],
        P646: [{ type: "external-id", value: freebase }],
      }),
    });
    const a = band("Q7759214", "e944add4-f012-4c9c-93fd-013347a4bc25", "359054", "/m/01p3n92");
    const b = band("Q3522403", "4bd3fb40-1c6f-4056-a0ee-8427685586fc", "292305", "/m/0gq3g1");
    const isId = (pid: string) => ["P4208", "P434", "P1953", "P646"].includes(pid);
    const result = scoreCandidate(a, b, {
      isIdentifierProp: isId,
      isMirroredIdProp: (pid) => pid === "P434",
    });
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain("2 per-title identifiers differ");
    expect(result.reasons[0]).not.toContain("P434");
    expect(
      result.reasons.some(
        (r) => r.startsWith("shares account/social identifier") && r.includes("P4208"),
      ),
    ).toBe(true);
  });

  it("does not trip the per-title rule on a single differing id or one-sided ids", () => {
    // One differing per-title id (Steam) plus a MobyGames id present on only one
    // side: exactly one prop is "distinct", so the pair is not capped.
    const a: Item = {
      ...base,
      id: "Q70",
      labels: { en: "Solstice" },
      statements: stmt({
        P5794: [{ type: "external-id" as const, value: "shared-igdb" }],
        P1733: [{ type: "external-id" as const, value: "111" }],
        P11688: [{ type: "external-id" as const, value: "moby-only-a" }],
      }),
    };
    const b: Item = {
      ...base,
      id: "Q71",
      labels: { en: "Solstice" },
      statements: stmt({
        P5794: [{ type: "external-id" as const, value: "shared-igdb" }],
        P1733: [{ type: "external-id" as const, value: "222" }],
      }),
    };
    const isId = (pid: string) => ["P5794", "P1733", "P11688"].includes(pid);
    const result = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(result.reasons.some((r) => r.includes("per-title identifiers differ"))).toBe(false);
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it("does not let a shared series (P179) inflate the match signal", () => {
    // Two distinctly-named games that merely share a franchise: agreeing on the
    // series must not count toward the statement-agreement signal.
    const mk = (id: string, name: string, withSeries: boolean): Item => ({
      ...base,
      id,
      labels: { en: name },
      statements: stmt(withSeries ? { P179: [{ type: "item" as const, value: "Q999" }] } : {}),
    });
    const withSeries = scoreCandidate(mk("Q80", "Alpha", true), mk("Q81", "Beta", true));
    const without = scoreCandidate(mk("Q82", "Alpha", false), mk("Q83", "Beta", false));
    expect(withSeries.confidence).toBeCloseTo(without.confidence);
    expect(withSeries.reasons.some((r) => r.includes("shared statements agree"))).toBe(false);
  });

  it("penalises a disjoint developer for same-named games", () => {
    const mk = (id: string, dev: string): Item => ({
      ...base,
      id,
      labels: { en: "Labyrinth" },
      statements: stmt({ P178: [{ type: "item" as const, value: dev }] }),
    });
    const same = scoreCandidate(mk("Q1", "Q100"), mk("Q2", "Q100"));
    const diff = scoreCandidate(mk("Q3", "Q100"), mk("Q4", "Q200"));
    expect(diff.confidence).toBeLessThan(same.confidence);
    expect(diff.reasons).toContain("different developer");
  });

  it("scores a series-level id (TV Tropes) as weak, not a strong per-title id", () => {
    const mk = (id: string, name: string): Item => ({
      ...base,
      id,
      labels: { en: name },
      statements: stmt({ P6839: [{ type: "external-id" as const, value: "VideoGame/Foo" }] }),
    });
    const result = scoreCandidate(mk("Q1", "Foo"), mk("Q2", "Foo"), {
      isIdentifierProp: (pid) => pid === "P6839",
    });
    expect(result.reasons.some((r) => r.startsWith("shares account/social identifier"))).toBe(true);
    expect(result.reasons.some((r) => r.startsWith("shares external identifier"))).toBe(false);
  });

  it("ignores agreement on low-entropy props (genre) for the statement term", () => {
    // Two different games that happen to share only a genre must not get
    // statement-agreement credit for it.
    const mk = (id: string, name: string): Item => ({
      ...base,
      id,
      labels: { en: name },
      statements: stmt({ P136: [{ type: "item" as const, value: "Q744038", label: "RPG" }] }),
    });
    const result = scoreCandidate(mk("Q1", "Alpha"), mk("Q2", "Beta"));
    expect(result.reasons.some((r) => r.includes("shared statements agree"))).toBe(false);
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

  it("docks 0.25 when one item references the other (e.g. a game's series)", () => {
    // A game and the series it belongs to share a label and developer; the
    // game's "part of the series" (P179) pointing at the series gives it away.
    const series: Item = { ...base, id: "Q301", labels: { en: "The Fall" }, statements: stmt({}) };
    const plain: Item = { ...base, id: "Q300", labels: { en: "The Fall" }, statements: stmt({}) };
    const inSeries: Item = {
      ...plain,
      statements: stmt({ P179: [{ type: "item", value: "Q301" }] }),
    };
    expect(crossReferenceProps(inSeries, series)).toEqual(new Set(["P179"]));
    expect(crossReferenceProps(series, inSeries)).toEqual(new Set(["P179"]));
    expect(crossReferenceProps(plain, series).size).toBe(0);

    const without = scoreCandidate(plain, series);
    const withRef = scoreCandidate(inSeries, series);
    expect(withRef.confidence).toBeCloseTo(without.confidence - 0.25, 5);
    expect(withRef.reasons.some((r) => r.startsWith("one item references the other"))).toBe(true);
  });

  it('ignores an identifier one item declares "shared with" the other (P4070) as match evidence', () => {
    // Two distinct items (e.g. a game and its soundtrack release, or two
    // regional editions) can legitimately carry the same MusicBrainz release
    // group id, and an editor records that with the P4070 qualifier. Identical
    // label + P31 + that shared id would otherwise read as a strong per-title
    // id match; with the qualifier, the id must count for nothing.
    const mk = (id: string, sharedWith?: string[]): Item => ({
      ...base,
      id,
      labels: { en: "Chrono Echo" },
      statements: stmt({
        P436: [{ type: "external-id", value: "8f1c2a9e-mbrg", ...(sharedWith && { sharedWith }) }],
      }),
    });
    const isId = (pid: string) => pid === "P436";

    const unqualified = scoreCandidate(mk("Q200"), mk("Q201"), { isIdentifierProp: isId });
    expect(unqualified.reasons.some((r) => r.startsWith("shares external identifier"))).toBe(true);

    const a = mk("Q200", ["Q201"]);
    const b = mk("Q201");
    expect(sharedIdentifierProps(a, b)).toEqual(new Set(["P436"]));
    const qualified = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(qualified.reasons.some((r) => r.startsWith("shares external identifier"))).toBe(false);
    expect(qualified.reasons.some((r) => r.includes("shared between the two items (P4070)"))).toBe(
      true,
    );
    expect(qualified.confidence).toBeLessThan(unqualified.confidence);
    // The ignored id must not inflate the statement-agreement term either.
    expect(qualified.reasons.some((r) => r.includes("shared statements agree"))).toBe(false);

    // Symmetric: the qualifier counts from whichever side carries it.
    expect(scoreCandidate(b, a, { isIdentifierProp: isId }).confidence).toBe(qualified.confidence);

    // A qualifier pointing at some *third* item says nothing about this pair,
    // so the id keeps its full weight.
    const third = scoreCandidate(mk("Q200", ["Q999"]), mk("Q201"), { isIdentifierProp: isId });
    expect(third.confidence).toBe(unqualified.confidence);
    expect(sharedIdentifierProps(mk("Q200", ["Q999"]), mk("Q201")).size).toBe(0);
  });

  it("does not count a declared-shared id toward the differing-identifiers disqualifier", () => {
    // Seven ids present on both items and all differing would trip the >6
    // disqualifier; one of them is declared shared with the other item (a stale
    // qualifier on a since-corrected value), so only six count.
    const pids = ["P436", "P9101", "P9102", "P9103", "P9104", "P9105", "P9106"];
    const mk = (id: string, prefix: string, sharedWith?: string[]): Item => ({
      ...base,
      id,
      labels: { en: "Seven Ways" },
      statements: stmt(
        Object.fromEntries(
          pids.map((p, i) => [
            p,
            [
              {
                type: "external-id" as const,
                value: `${prefix}${i}`,
                ...(p === "P436" && sharedWith && { sharedWith }),
              },
            ],
          ]),
        ),
      ),
    });
    const isId = (pid: string) => pids.includes(pid);
    const plain = scoreCandidate(mk("Q300", "a"), mk("Q301", "b"), { isIdentifierProp: isId });
    expect(plain.reasons.some((r) => r.includes("external identifiers differ"))).toBe(true);
    const shared = scoreCandidate(mk("Q300", "a", ["Q301"]), mk("Q301", "b"), {
      isIdentifierProp: isId,
    });
    expect(shared.reasons.some((r) => r.includes("external identifiers differ"))).toBe(false);
  });

  it("reaches near-certain (1.0) for a well-corroborated identical pair, with no 'held below' reason", () => {
    // Identical name + two shared strong ids + an agreeing developer = three
    // corroborating signals and no differences, so the ceiling is 1.0. The raw
    // additive score exceeds 1.0 and is clamped, but that clamp is the ordinary
    // cap — not the ceiling holding the pair back — so no "held below" reason.
    const mk = (id: string): Item => ({
      ...base,
      id,
      labels: { en: "Chrono Rift" },
      statements: stmt({
        P5794: [{ type: "external-id" as const, value: "igdb-777" }], // shared IGDB
        P11688: [{ type: "external-id" as const, value: "moby-777" }], // shared MobyGames
        P178: [{ type: "item" as const, value: "Q900" }], // agreeing developer
      }),
    });
    const result = scoreCandidate(mk("Q1"), mk("Q2"), {
      isIdentifierProp: (pid) => ["P5794", "P11688"].includes(pid),
    });
    expect(result.confidence).toBe(1);
    expect(result.reasons.some((r) => r.startsWith("held below near-certain"))).toBe(false);
  });

  it("holds a lone-shared-id identical pair below near-certain and explains it", () => {
    // Identical name + a single shared id is strong but not conclusive (the id
    // could be stale/mis-entered), so the ceiling caps it at 0.85 and says so.
    const mk = (id: string): Item => ({
      ...base,
      id,
      labels: { en: "Solo Signal" },
      statements: stmt({ P5794: [{ type: "external-id" as const, value: "igdb-1" }] }),
    });
    const result = scoreCandidate(mk("Q1"), mk("Q2"), {
      isIdentifierProp: (pid) => pid === "P5794",
    });
    expect(result.confidence).toBeLessThanOrEqual(0.85);
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(
      result.reasons.some((r) =>
        r.includes("held below near-certain — only one strong corroborating signal"),
      ),
    ).toBe(true);
  });
});
