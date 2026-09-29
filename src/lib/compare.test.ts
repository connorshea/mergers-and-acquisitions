import { describe, expect, it } from "vite-plus/test";
import {
  bestNameSimilarity,
  blockingLabelKey,
  buildRows,
  collapseRepeatedRows,
  compareRowRank,
  compareValues,
  differingNativeNames,
  differingPersonalAccounts,
  foldNativeName,
  formatIdUrl,
  installment,
  type Item,
  type Value,
  crossReferenceProps,
  isAutoIgnoredConflict,
  levenshtein,
  isDeclaredDifferent,
  isPermanentDuplicatePair,
  isSeriesSequelPair,
  isWorkEditionPair,
  isPartWholePair,
  isSequencedPair,
  isDerivativePair,
  isCollectionSiblingPair,
  isDifferentVolumePair,
  isDisjointYearRangePair,
  titleDivisions,
  isCatalogSiblingPair,
  isDifferentKeyPair,
  isConflationPair,
  titleYears,
  yearDisambiguatedWikis,
  mergeConflicts,
  redirectSitelinkFixes,
  rowDisplayRank,
  withFragment,
  normalize,
  orderByAge,
  safeHttpUrl,
  scoreCandidate,
  sharedIdentifierProps,
  stringSimilarity,
} from "./compare.ts";
import { coordinateValue } from "./coordinates.ts";
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

/** Deterministic PRNG (mulberry32), so the randomized cases below are reproducible. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A short random string over a small alphabet, so pairs share plenty of characters. */
function randomString(next: () => number, alphabet: string, maxLength: number): string {
  const length = Math.floor(next() * (maxLength + 1));
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(next() * alphabet.length)];
  return out;
}

describe("levenshtein", () => {
  /** Textbook full-matrix edit distance, as the reference. */
  const reference = (a: string, b: string): number => {
    const d = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
    return d[a.length][b.length];
  };

  it("gives known distances", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("flaw", "lawn")).toBe(2);
    expect(levenshtein("Portal", "Portal 2")).toBe(2);
    expect(levenshtein("ab", "ba")).toBe(2);
  });

  it("matches the full-matrix reference on random strings", () => {
    const next = rng(1);
    for (let i = 0; i < 2000; i++) {
      const a = randomString(next, "abcé ", 12);
      const b = randomString(next, "abcé ", 12);
      expect(levenshtein(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(
        reference(a, b),
      );
      expect(levenshtein(b, a)).toBe(levenshtein(a, b));
    }
  });
});

describe("bestNameSimilarity", () => {
  const base = { descriptions: {}, statements: {}, sitelinks: {} };
  const named = (
    id: string,
    labels: Record<string, string>,
    aliases: Record<string, string[]> = {},
  ): Item => ({ ...base, id, labels, aliases });

  /** The plain all-pairs definition it must agree with. */
  const reference = (a: Item, b: Item, includeAliases: boolean): number => {
    const names = (item: Item) =>
      [
        ...Object.values(item.labels),
        ...(includeAliases ? Object.values(item.aliases).flat() : []),
      ].filter(Boolean);
    let best = 0;
    for (const x of names(a))
      for (const y of names(b)) best = Math.max(best, stringSimilarity(x, y));
    return best;
  };

  it("is 0 when either side has no names", () => {
    expect(bestNameSimilarity(named("Q1", {}), named("Q2", { en: "Doom" }))).toBe(0);
    // Aliases don't count when only labels are compared.
    expect(
      bestNameSimilarity(named("Q1", {}, { en: ["Doom"] }), named("Q2", { en: "Doom" }), false),
    ).toBe(0);
  });

  it("treats names equal after normalization as identical", () => {
    const a = named("Q1", { en: "  The   Legend of Zelda " });
    const b = named("Q2", { fr: "the legend of zelda" });
    expect(bestNameSimilarity(a, b)).toBe(1);
    expect(bestNameSimilarity(a, b, false)).toBe(1);
  });

  it("finds the best pair when it isn't the first one tried", () => {
    // Long names that match nothing come first; the close pair is short and
    // late, so skipping on length must not skip past it.
    const a = named("Q1", { en: "An Extremely Long Unrelated Title", de: "Doom II" });
    const b = named("Q2", { en: "Something Else Entirely Here", ja: "Doom 2" });
    expect(bestNameSimilarity(a, b)).toBe(stringSimilarity("Doom II", "Doom 2"));
  });

  it("matches the all-pairs reference on items with many names", () => {
    const next = rng(2);
    const langs = ["en", "de", "fr", "ja", "es", "it", "nl", "pl"];
    const randomNames = () => {
      const labels: Record<string, string> = {};
      const aliases: Record<string, string[]> = {};
      for (const lang of langs) {
        if (next() < 0.7) labels[lang] = randomString(next, "abAB c", 10);
        if (next() < 0.4)
          aliases[lang] = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
            randomString(next, "abAB c", 10),
          );
      }
      return { labels, aliases };
    };
    for (let i = 0; i < 1000; i++) {
      const x = randomNames();
      const y = randomNames();
      const a = named("Q1", x.labels, x.aliases);
      const b = named("Q2", y.labels, y.aliases);
      for (const includeAliases of [true, false]) {
        expect(bestNameSimilarity(a, b, includeAliases)).toBe(reference(a, b, includeAliases));
      }
    }
  });
});

describe("compareValues", () => {
  it("skips the similar-label hint for sex or gender", () => {
    const female = { type: "item" as const, value: "Q6581072", label: "female" };
    const male = { type: "item" as const, value: "Q6581097", label: "male" };
    expect(compareValues(female, male, "P21")).toEqual(["distinct"]);
    expect(compareValues(female, male, "P50")).toEqual([
      "similar",
      "different items with similar labels",
    ]);
  });

  it("treats the same amount in different units as distinct", () => {
    expect(
      compareValues(
        { type: "quantity", value: "90", unit: "Q7727" },
        { type: "quantity", value: "90", unit: "Q11574" },
      ),
    ).toEqual(["distinct"]);
    expect(
      compareValues(
        { type: "quantity", value: "90", unit: "Q7727" },
        { type: "quantity", value: "90" },
      ),
    ).toEqual(["distinct"]);
    expect(
      compareValues(
        { type: "quantity", value: "90", unit: "Q7727" },
        { type: "quantity", value: "90", unit: "Q7727" },
      ),
    ).toEqual(["identical"]);
  });

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

  it("treats URLs differing only by http vs https or a trailing slash as identical", () => {
    expect(
      compareValues(
        { type: "url", value: "https://paisinvisible.cat/" },
        { type: "url", value: "https://paisinvisible.cat" },
      ),
    ).toEqual(["identical"]);
    expect(
      compareValues(
        { type: "url", value: "http://example.com/a" },
        { type: "url", value: "https://example.com/a/" },
      ),
    ).toEqual(["identical"]);
    expect(
      compareValues(
        { type: "url", value: "http://www.example.com/a" },
        { type: "url", value: "https://example.com/a/" },
      ),
    ).toEqual(["similar", "same host and path"]);
  });

  it("treats doi.org links to the same DOI as similar", () => {
    // Q141438571 vs Q125525593: the same book via doi.org and dx.doi.org.
    expect(
      compareValues(
        { type: "url", value: "https://doi.org/10.1017/cbo9780511585340" },
        { type: "url", value: "http://dx.doi.org/10.1017/CBO9780511585340" },
      ),
    ).toEqual(["similar", "same DOI"]);
    expect(
      compareValues(
        { type: "url", value: "https://doi.org/10.1017/cbo9780511585340" },
        { type: "url", value: "https://doi.org/10.1017/cbo9780511585341" },
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

    it("never treats an intentional redirect as the other item's page", () => {
      // Resolved to the other page, but badged as deliberately linked: a
      // separate subject (e.g. an enhanced edition redirecting to the original).
      const intentional: Item = {
        ...redirect,
        sitelinkBadges: { enwiki: ["Q70894304"] },
        sitelinkRedirects: { enwiki: article.sitelinks.enwiki },
      };
      const r = row(article, intentional);
      expect(r.blocker).toBe(true);
      expect(r.note).toMatch(/^Q1145650's sitelink is badged as an intentional redirect/);
      expect(redirectSitelinkFixes(article, intentional)).toBeNull();
      expect(redirectSitelinkFixes(intentional, article)).toBeNull();
    });

    it("says so when both pages are redirects", () => {
      const other = { ...article, sitelinkBadges: { enwiki: ["Q70893996"] } };
      expect(row(other, redirect).note).toMatch(/^Both pages are redirects/);
    });

    it("names a resolved redirect's target, and is definite when it's the other page", () => {
      const resolved: Item = {
        ...redirect,
        sitelinkBadges: undefined,
        sitelinkRedirects: { enwiki: article.sitelinks.enwiki },
      };
      const r = row(article, resolved);
      expect(r.blocker).toBe(true);
      expect(r.b.map((v) => [v.redirect, v.redirectTarget])).toEqual([
        [true, "Loud & Dangerous: Live from Hollywood"],
      ]);
      expect(r.note).toBe(
        "Q1145650's page redirects to Q65117434's page. Merging will remove Q1145650's sitelink for you.",
      );
    });

    it("says where a resolved redirect goes when it isn't the other page", () => {
      const elsewhere = { ...redirect, sitelinkRedirects: { enwiki: "Loud (album)" } };
      expect(row(article, elsewhere).note).toMatch(
        /^Q1145650's page redirects to “Loud \(album\)”, not/,
      );
      const both = { ...article, sitelinkRedirects: { enwiki: "Loud (album)" } };
      expect(row(both, elsewhere).note).toMatch(/^Both pages redirect to “Loud \(album\)”/);
    });

    it("counts a resolved redirect with an unknown target as a redirect", () => {
      const unknown = {
        ...redirect,
        sitelinkBadges: undefined,
        sitelinkRedirects: { enwiki: null },
      };
      const r = row(article, unknown);
      expect(r.b[0].redirect).toBe(true);
      expect(r.b[0].redirectTarget).toBeUndefined();
      expect(r.note).toMatch(/^Q1145650's page is a redirect/);
    });

    it("plans removing the side that redirects to the other page, and only that shape", () => {
      const toArticle = { ...redirect, sitelinkRedirects: { enwiki: article.sitelinks.enwiki } };
      const fix = {
        qid: "Q1145650",
        wiki: "enwiki",
        title: "Loud and Dangerous: Live from Hollywood",
        target: "Loud & Dangerous: Live from Hollywood",
      };
      expect(redirectSitelinkFixes(article, toArticle)).toEqual([fix]);
      expect(redirectSitelinkFixes(toArticle, article)).toEqual([fix]);
      // Badge only, target unknown: a person has to look.
      expect(redirectSitelinkFixes(article, redirect)).toBeNull();
      // Points elsewhere.
      const elsewhere = { ...redirect, sitelinkRedirects: { enwiki: "Loud (album)" } };
      expect(redirectSitelinkFixes(article, elsewhere)).toBeNull();
      // Points at a section of the other page: part of that subject, not it.
      const section = {
        ...redirect,
        sitelinkRedirects: { enwiki: withFragment(article.sitelinks.enwiki, "Encore") },
      };
      expect(redirectSitelinkFixes(article, section)).toBeNull();
      // A second, unfixable clash sinks the plan.
      const twoWikis = { ...toArticle, sitelinks: { ...toArticle.sitelinks, dewiki: "Loud" } };
      expect(
        redirectSitelinkFixes(
          { ...article, sitelinks: { ...article.sitelinks, dewiki: "Laut" } },
          twoWikis,
        ),
      ).toBeNull();
      // No clash at all: nothing to do.
      expect(redirectSitelinkFixes(article, article)).toEqual([]);
    });

    it("keeps the generic note when neither side is badged", () => {
      const plain = { ...redirect, sitelinkBadges: { enwiki: ["Q17437796"] } }; // featured article
      expect(row(article, plain).note).toMatch(/^Two different pages/);
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

describe("collapseRepeatedRows", () => {
  const base = { descriptions: {}, aliases: {}, statements: {}, sitelinks: {} };
  const a: Item = {
    ...base,
    id: "Q10379091",
    labels: { de: "Teen Angels - La Despedida", en: "Teen Angels - La Despedida", it: "Other" },
  };
  const b: Item = {
    ...base,
    id: "Q3982545",
    labels: { de: "Teen Angels: La Despedida", en: "Teen Angels: La Despedida", it: "Else" },
  };

  it("merges label rows with identical values into one multi-language row", () => {
    const rows = collapseRepeatedRows(buildRows(a, b));
    const labels = rows.filter((r) => r.kind === "term").map((r) => r.label);
    expect(labels).toEqual(["label (de, en)", "label (it)"]);
    expect(rows[0].key).toBe("label:de,en");
    expect(rows[0].status).toBe("similar");
  });

  it("leaves rows with no repeated values untouched", () => {
    const rows = buildRows({ ...a, labels: { en: "X" } }, { ...b, labels: { en: "Y" } });
    expect(collapseRepeatedRows(rows)).toEqual(rows);
  });

  it("merges one-sided sitelinks sharing a title, keeping redirects and clashes apart", () => {
    const rows = collapseRepeatedRows(
      buildRows(
        { ...a, labels: {}, sitelinks: { enwiki: "Other", dewiki: "Andere" } },
        {
          ...b,
          labels: {},
          sitelinks: {
            enwiki: "Crush 'Em",
            eswiki: "Crush 'Em",
            fiwiki: "Crush ’Em",
            mkwiki: "Crush 'Em",
            ptwiki: "Crush 'Em",
            ruwiki: "Crush ’Em",
            dewiki: "Crush 'Em",
          },
          sitelinkBadges: { ptwiki: ["Q70893996"] },
        },
      ),
    );
    const sitelinks = rows.filter((r) => r.kind === "sitelink");
    expect(sitelinks.map((r) => [r.label, r.sites])).toEqual([
      ["dewiki", undefined],
      ["enwiki", undefined],
      ["eswiki, mkwiki", ["eswiki", "mkwiki"]],
      ["fiwiki, ruwiki", ["fiwiki", "ruwiki"]],
      ["ptwiki", undefined],
    ]);
  });
});

describe("rowDisplayRank", () => {
  it("orders P31, labels, other terms, sitelinks, non-id statements, then ids, by P-number", () => {
    const base = { descriptions: {}, statements: {} };
    const a: Item = {
      ...base,
      id: "Q1",
      labels: { en: "A" },
      aliases: { en: ["Alpha"] },
      sitelinks: { enwiki: "A" },
      statements: {
        P1733: [{ type: "external-id", value: "1" }],
        P577: [{ type: "time", value: "2001" }],
        P31: [{ type: "item", value: "Q7889" }],
        P214: [{ type: "external-id", value: "9" }],
        P136: [{ type: "item", value: "Q1" }],
        P17: [{ type: "item", value: "Q30" }],
      },
    };
    const b: Item = { ...a, id: "Q2", labels: { en: "B" } };
    const keys = buildRows(a, b)
      .filter((r) => !r.key.startsWith("description:"))
      .map((r) => ({ key: r.key, rank: rowDisplayRank(r, r.key === "P214") }))
      .sort((x, y) => compareRowRank(x.rank, y.rank))
      .map((r) => r.key);
    expect(keys).toEqual([
      "P31",
      "label:en",
      "alias:en",
      "sitelink:enwiki",
      "P17",
      "P136",
      "P577",
      "P1733",
      "P214",
    ]);
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
    // A vandalised formatter URL with a non-http(s) scheme never becomes a link.
    expect(formatIdUrl("javascript:alert(1)//$1", "268220")).toBeNull();
    expect(formatIdUrl(" JavaScript:alert(1)//$1", "268220")).toBeNull();
    expect(formatIdUrl("data:text/html,$1", "<script>")).toBeNull();
  });

  it("only passes absolute http(s) URLs through safeHttpUrl", () => {
    expect(safeHttpUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("\tjava\nscript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("ftp://example.com")).toBeNull();
    expect(safeHttpUrl("//example.com")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
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
    // Unicode Roman numeral characters (U+2160 block) and fullwidth digits.
    expect(installment("Beneath the Raptor's Wing Ⅱ")).toEqual({
      base: "beneath the raptor's wing",
      num: 2,
    });
    expect(installment("Final Fantasy Ⅻ")).toEqual({ base: "final fantasy", num: 12 });
    expect(installment("Portal ２")).toEqual({ base: "portal", num: 2 });
    // Apostrophe-abbreviated years, straight or curly.
    expect(installment("World of Tennis '74")).toEqual({ base: "world of tennis", num: 74 });
    expect(installment("World of Tennis ’75")).toEqual({ base: "world of tennis", num: 75 });
    // Only a two-digit year takes the apostrophe.
    expect(installment("Tennis '1974")).toEqual({ base: "tennis '1974", num: null });
    // A number closing a trailing bracketed group.
    expect(installment("Dove... quando... (parte II)")).toEqual({
      base: "dove... quando... parte",
      num: 2,
    });
    expect(installment("Foo (Part 2)")).toEqual({ base: "foo part", num: 2 });
    expect(installment("Foo [Vol. 3]")).toEqual({ base: "foo vol", num: 3 });
    // A bracketed year is a disambiguator, and a bracket without a number is kept.
    expect(installment("Doom (2016)")).toEqual({ base: "doom (2016)", num: null });
    expect(installment("Foo (Live)")).toEqual({ base: "foo (live)", num: null });
    // A number just before a bracketed qualifier; the qualifier stays in the base.
    expect(installment("Obras completas: novelas V (Fernán Caballero)")).toEqual({
      base: "obras completas: novelas (fernán caballero)",
      num: 5,
    });
    expect(installment("Portal 2 (video game)")).toEqual({
      base: "portal (video game)",
      num: 2,
    });
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

    // Q54807364 / Q54807365: two-part novel titled with U+2160/U+2161.
    const r1: Item = { ...base, id: "Q54807364", labels: { en: "Beneath the Raptor's Wing Ⅰ" } };
    const r2: Item = { ...base, id: "Q54807365", labels: { en: "Beneath the Raptor's Wing Ⅱ" } };
    expect(isSeriesSequelPair(r1, r2)).toBe(true);

    // Q28914385 / Q28918614: consecutive yearbooks titled with '74 / '75.
    const y1: Item = { ...base, id: "Q28914385", labels: { en: "World of Tennis '74" } };
    const y2: Item = { ...base, id: "Q28918614", labels: { en: "World of Tennis '75" } };
    expect(isSeriesSequelPair(y1, y2)).toBe(true);

    // Q30124570 / Q30124841: the two parts of one song, numbered in parentheses.
    const p1: Item = { ...base, id: "Q30124570", labels: { en: "Dove... quando... (parte I)" } };
    const p2: Item = { ...base, id: "Q30124841", labels: { en: "Dove... quando... (parte II)" } };
    expect(isSeriesSequelPair(p1, p2)).toBe(true);

    // Q77336442 / Q77336223: volumes of a collected works, the author in parentheses.
    const v5: Item = {
      ...base,
      id: "Q77336442",
      labels: { es: "Obras completas: novelas V (Fernán Caballero)" },
    };
    const v13: Item = {
      ...base,
      id: "Q77336223",
      labels: { es: "Obras completas: novelas XIII (Fernán Caballero)" },
    };
    expect(isSeriesSequelPair(v5, v13)).toBe(true);
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
    // Same label, same P31, shared per-subject id — a strong candidate on its own.
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

    it("rewards a page resolved as a redirect to the other item's page", () => {
      const wikis = ["enwiki"];
      const a = mk("Q1", pages("", wikis));
      const plain = mk("Q2", pages(" (video game)", wikis));
      const redirecting = { ...plain, sitelinkRedirects: { enwiki: "Harvest Moon" } };
      const before = score(a, plain);
      const after = score(a, redirecting);
      expect(after.confidence).toBeGreaterThan(before.confidence);
      expect(after.reasons).toContain("sitelink redirects to the other item's page on enwiki");
      // Not a blocker: the merge flow removes the redirect sitelink first.
      expect(before.hasBlocker).toBe(true);
      expect(after.hasBlocker).toBe(false);
      expect(after.reasons.some((r) => r.includes("would block the merge"))).toBe(false);
      // A redirect somewhere else is no evidence either way.
      const elsewhere = { ...plain, sitelinkRedirects: { enwiki: "Harvest Moon (series)" } };
      expect(score(a, elsewhere).reasons.some((r) => r.startsWith("sitelink redirects"))).toBe(
        false,
      );
    });

    it("keeps the clash penalty unless a redirect could explain the clash", () => {
      // Label-only pair, so the score sits below the strong-signal cap.
      const lone = (extra: Pick<Item, "sitelinkBadges" | "sitelinkRedirects">): Item => ({
        ...base,
        id: "Q2",
        labels: { en: "Harvest Moon" },
        sitelinks: { enwiki: "Harvest Moon (video game)" },
        statements: {},
        ...extra,
      });
      const a = { ...lone({}), id: "Q1", sitelinks: { enwiki: "Harvest Moon" } };
      const plain = score(a, lone({})).confidence;
      // Badge only, target unknown: likely a redirect to the other page.
      expect(
        score(a, lone({ sitelinkBadges: { enwiki: ["Q70893996"] } })).confidence,
      ).toBeGreaterThan(plain);
      // Known to point at a third page, a section of the other page, another
      // namespace, or another wiki: still two distinct pages.
      for (const target of [
        "Harvest Moon (series)",
        "Harvest Moon#Sequel",
        "Project:Harvest Moon",
        "wikt:Harvest Moon",
      ]) {
        const r = score(a, lone({ sitelinkRedirects: { enwiki: target } }));
        expect(r.confidence).toBe(plain);
        expect(r.reasons.some((x) => x.startsWith("sitelink redirects"))).toBe(false);
      }
      // Intentional redirect to the other page: a separate subject, so no
      // reward and the penalty stays — with or without a resolved target.
      for (const extra of [
        { sitelinkBadges: { enwiki: ["Q70894304"] } },
        {
          sitelinkBadges: { enwiki: ["Q70894304"] },
          sitelinkRedirects: { enwiki: "Harvest Moon" },
        },
      ]) {
        const r = score(a, lone(extra));
        expect(r.confidence).toBe(plain);
        expect(r.reasons.some((x) => x.startsWith("sitelink redirects"))).toBe(false);
      }
    });
  });

  it("weights a shared account/social id far below a per-subject id", () => {
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
    expect(strong.reasons).toContain("shares external identifier: P1733");
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
    // forgiven when a strong per-subject id vouches for the pair.
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
        "publication/inception/birth years differ by 34, almost certainly different subjects",
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

  it("ignores library subject classifications (Dewey, LCC, UDC) as match or distinction evidence", () => {
    // Two unrelated novels share Dewey 813.54 (American fiction, 1945-1999). A
    // shared subject class must not count as a shared identifier.
    const isId = (pid: string) =>
      pid.startsWith("P700") || ["P1036", "P1149", "P1190"].includes(pid);
    const mkShared = (id: string): Item => ({
      ...base,
      id,
      labels: { en: "Echo" },
      statements: stmt({ P1036: [{ type: "external-id" as const, value: "813.54" }] }),
    });
    const shared = scoreCandidate(mkShared("Q1"), mkShared("Q2"), { isIdentifierProp: isId });
    expect(shared.reasons.some((r) => r.startsWith("shares external identifier"))).toBe(false);

    // Nor may differing classes count toward the >6 distinct-external-id
    // disqualifier: five real differing ids plus three differing classes is 8
    // raw, but only the five real ones count.
    const stmts = (prefix: string) => ({
      ...Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [
          `P700${i}`,
          [{ type: "external-id" as const, value: `${prefix}${i}` }],
        ]),
      ),
      P1036: [{ type: "external-id" as const, value: `${prefix}-ddc` }],
      P1149: [{ type: "external-id" as const, value: `${prefix}-lcc` }],
      P1190: [{ type: "external-id" as const, value: `${prefix}-udc` }],
    });
    const a: Item = { ...base, id: "Q3", labels: { en: "Echo" }, statements: stmt(stmts("a")) };
    const b: Item = { ...base, id: "Q4", labels: { en: "Echo" }, statements: stmt(stmts("b")) };
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

  it("ignores an id whose subject type constraint excludes both items (isInapplicableId)", () => {
    // Two works sharing their author's person id (P2799), copied onto each.
    const mk = (id: string, label: string): Item => ({
      ...base,
      id,
      labels: { en: label },
      statements: stmt({ P2799: [{ type: "external-id" as const, value: "70" }] }),
    });
    const a = mk("Q70", "Dulce dueño");
    const b = mk("Q71", "La sirena negra");
    const isId = (pid: string) => pid === "P2799";

    const without = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(without.reasons).toContain("shares external identifier: P2799");

    const ruledOut = scoreCandidate(a, b, {
      isIdentifierProp: isId,
      isInapplicableId: (pid) => pid === "P2799",
    });
    expect(ruledOut.reasons.some((r) => r.startsWith("shares external identifier"))).toBe(false);
    expect(ruledOut.reasons).toContain(
      "identifier whose subject type constraint excludes both items, not counted: P2799",
    );
    expect(ruledOut.confidence).toBeLessThan(without.confidence);

    // Still evidence when the id fits one of the two items.
    const oneSide = scoreCandidate(a, b, {
      isIdentifierProp: isId,
      isInapplicableId: (pid, item) => pid === "P2799" && item.id === "Q70",
    });
    expect(oneSide.reasons).toContain("shares external identifier: P2799");
  });

  it("caps a pair hard when two+ per-subject ids differ, even with a shared id and identical name", () => {
    // Identical name, same P31 and a *shared* IGDB id would score very high, but
    // two per-subject store pages differ (Steam + MobyGames) — distinct games.
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
    expect(result.reasons[0]).toContain("per-subject identifiers differ");
  });

  it("treats differing MyAnimeList + AniList ids as two works, for anime and manga", () => {
    // Q137844249 vs. Q137844250: Robotan, the 1966 anime and its 1986 remake.
    // Q133738050 vs. Q133738052: Magic User's Club, two manga series.
    for (const [mal, anilist] of [
      ["P4086", "P8729"],
      ["P4087", "P8731"],
    ]) {
      const item = (id: string, value: string): Item => ({
        ...base,
        id,
        labels: { en: "Robotan" },
        statements: stmt({
          [mal]: [{ type: "external-id" as const, value }],
          [anilist]: [{ type: "external-id" as const, value }],
        }),
      });
      const result = scoreCandidate(item("Q60", "19875"), item("Q61", "5223"));
      expect(result.confidence).toBeLessThanOrEqual(0.1);
      expect(result.reasons[0]).toContain(`per-subject identifiers differ (${mal}, ${anilist})`);
    }
  });

  it("counts itch.io URL (a url-typed value, not an ExternalId) toward the per-subject rule", () => {
    // itch.io URL (P7294) is a `url` datatype; paired with a differing Steam id
    // that's two distinct per-subject pages, so the cap fires by property id even
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
    expect(result.reasons[0]).toContain("per-subject identifiers differ");
  });

  it("caps two novels in one series whose ISFDB and FantLab ids differ", () => {
    // Q134618534 / Q134618537: two "Last Kids on Earth" novels (2018, 2021) with
    // similar names, the same author and series, and a shared Penguin Random
    // House work id — but their per-work ISFDB and FantLab records differ.
    const novel = (id: string, title: string, isfdb: string, fantlab: string): Item => ({
      ...base,
      id,
      labels: { en: title },
      statements: stmt({
        P31: [{ type: "item", value: "Q7725634" }],
        P50: [{ type: "item", value: "Q54972791" }],
        P179: [{ type: "item", value: "Q48989855" }],
        P9818: [{ type: "external-id", value: "315311" }],
        P1274: [{ type: "external-id", value: isfdb }],
        P7439: [{ type: "external-id", value: fantlab }],
      }),
    });
    const a = novel(
      "Q134618534",
      "The Last Kids on Earth and the Cosmic Beyond",
      "2409893",
      "1073738",
    );
    const b = novel(
      "Q134618537",
      "The Last Kids on Earth and the Doomsday Race",
      "2903507",
      "1467618",
    );
    const isId = (pid: string) => ["P9818", "P1274", "P7439"].includes(pid);
    const result = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain("2 per-subject identifiers differ");
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
    expect(result.reasons[0]).toContain("2 per-subject identifiers differ");
    expect(result.reasons[0]).not.toContain("P434");
    expect(
      result.reasons.some(
        (r) => r.startsWith("shares account/social identifier") && r.includes("P4208"),
      ),
    ).toBe(true);
  });

  it("does not trip the per-subject rule on a single differing id or one-sided ids", () => {
    // One differing per-subject id (Steam) plus a MobyGames id present on only one
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
    expect(result.reasons.some((r) => r.includes("per-subject identifiers differ"))).toBe(false);
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

  it("scores a series-level id (TV Tropes) as weak, not a strong per-subject id", () => {
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

  it("scores a Sina Weibo user ID as a weak account id, not a per-subject id", () => {
    // A drama's Weibo account is often the studio's or broadcaster's, shared by
    // every show it posts about, so a shared value says little about the title.
    const mk = (id: string, name: string): Item => ({
      ...base,
      id,
      labels: { en: name },
      statements: stmt({ P3579: [{ type: "external-id" as const, value: "7881845714" }] }),
    });
    const result = scoreCandidate(mk("Q1", "Foo"), mk("Q2", "Foo"), {
      isIdentifierProp: (pid) => pid === "P3579",
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

  it("ignores agreement on a shared WikiProject focus list (P5008)", () => {
    // A WikiProject tags every item in its topic, so sharing one is no evidence.
    const mk = (id: string, name: string): Item => ({
      ...base,
      id,
      labels: { en: name },
      statements: stmt({ P5008: [{ type: "item" as const, value: "Q100000" }] }),
    });
    const result = scoreCandidate(mk("Q1", "Alpha"), mk("Q2", "Beta"));
    expect(result.reasons.some((r) => r.includes("shared statements agree"))).toBe(false);
  });

  it('zeroes out a pair one item declares "different from" the other (P1889)', () => {
    // Identical label + P31 + shared per-subject id would otherwise score ~1.0.
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

  describe('"permanent duplicated item" (P2959)', () => {
    // Identical label + shared per-subject id would otherwise score high.
    const mk = (id: string, p2959: string[] = []): Item => ({
      ...base,
      id,
      labels: { en: "Look-Alike" },
      statements: stmt({
        P1733: [{ type: "external-id", value: "42" }],
        ...(p2959.length > 0
          ? { P2959: p2959.map((value) => ({ type: "item" as const, value })) }
          : {}),
      }),
    });

    it("zeroes out a pair where either item names the other", () => {
      const a = mk("Q100", ["Q101"]);
      const b = mk("Q101");
      for (const [x, y] of [
        [a, b],
        [b, a],
      ]) {
        expect(isPermanentDuplicatePair(x, y)).toBe(true);
        const result = scoreCandidate(x, y);
        expect(result.confidence).toBe(0);
        expect(result.reasons[0]).toBe(
          'marked "permanent duplicated item" on Wikidata (P2959), can\'t be merged',
        );
        // Not also listed as a generic cross-reference.
        expect(result.reasons.some((r) => r.includes("references the other"))).toBe(false);
      }
      expect(scoreCandidate(mk("Q100"), b).confidence).toBeGreaterThan(0.5);
    });

    it("zeroes out a pair that both name the same third item", () => {
      const a = mk("Q100", ["Q999"]);
      const b = mk("Q101", ["Q999"]);
      expect(isPermanentDuplicatePair(a, b)).toBe(true);
      expect(scoreCandidate(a, b).confidence).toBe(0);
    });

    it("leaves a pair alone when each names a different third item", () => {
      const a = mk("Q100", ["Q998"]);
      const b = mk("Q101", ["Q999"]);
      expect(isPermanentDuplicatePair(a, b)).toBe(false);
      const result = scoreCandidate(a, b);
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.reasons.some((r) => r.includes("P2959"))).toBe(false);
    });
  });

  it("caps a pair linked as work and edition (P629/P747) below the floor", () => {
    // Q794722 "Big Hits (High Tide and Green Grass)" and its US edition
    // Q62589819: identical label, same 1966 date and P31 — scored 74% before.
    const work: Item = {
      ...base,
      id: "Q794722",
      labels: { en: "Big Hits (High Tide and Green Grass)" },
      statements: stmt({
        P31: [{ type: "item", value: "Q482994" }],
        P577: [{ type: "time", value: "+1966-00-00T00:00:00Z" }],
      }),
    };
    const edition: Item = {
      ...work,
      id: "Q62589819",
      statements: stmt({
        P31: [
          { type: "item", value: "Q3331189" },
          { type: "item", value: "Q482994" },
        ],
        P577: [{ type: "time", value: "+1966-03-28T00:00:00Z" }],
      }),
    };
    expect(scoreCandidate(work, edition).confidence).toBeGreaterThan(0.4);

    const editionOf = {
      ...edition,
      statements: { ...edition.statements, P629: [{ type: "item" as const, value: "Q794722" }] },
    };
    const hasEdition = {
      ...work,
      statements: { ...work.statements, P747: [{ type: "item" as const, value: "Q62589819" }] },
    };
    for (const [a, b] of [
      [editionOf, work],
      [work, editionOf],
      [hasEdition, edition],
      [edition, hasEdition],
    ]) {
      expect(isWorkEditionPair(a, b)).toBe(true);
      const result = scoreCandidate(a, b);
      expect(result.confidence).toBeLessThanOrEqual(0.1);
      expect(result.reasons[0]).toContain("work and its edition");
      // Handled by the cap, not double-counted as a generic cross-reference.
      expect(result.reasons.some((r) => r.startsWith("one item references the other"))).toBe(false);
    }
    // An edition of some *third* work says nothing about this pair.
    const elsewhere = {
      ...edition,
      statements: { ...edition.statements, P629: [{ type: "item" as const, value: "Q1" }] },
    };
    expect(isWorkEditionPair(elsewhere, work)).toBe(false);
  });

  it("caps a reissue and its original (P9237) below the candidate floor", () => {
    // Q135092461 (1984 reissue) vs. Q135092435 (1983 original): same label, artist.
    const original: Item = {
      ...base,
      id: "Q135092435",
      labels: { en: "Kärlek" },
      statements: stmt({ P577: [{ type: "time", value: "+1983-00-00T00:00:00Z" }] }),
    };
    const reissue: Item = {
      ...original,
      id: "Q135092461",
      statements: {
        ...original.statements,
        P577: [{ type: "time", value: "+1984-00-00T00:00:00Z" }],
        P9237: [{ type: "item" as const, value: "Q135092435" }],
      },
    };
    for (const [a, b] of [
      [reissue, original],
      [original, reissue],
    ]) {
      expect(isWorkEditionPair(a, b)).toBe(true);
      const result = scoreCandidate(a, b);
      expect(result.confidence).toBeLessThanOrEqual(0.1);
      expect(result.reasons[0]).toContain("reissue or recording");
      expect(result.reasons.some((r) => r.startsWith("one item references the other"))).toBe(false);
    }
  });

  it("caps a recording and its composition (P2550) below the candidate floor", () => {
    const work: Item = {
      ...base,
      id: "Q600",
      labels: { en: "Blue Champagne" },
      statements: stmt({ P577: [{ type: "time", value: "+1941-00-00T00:00:00Z" }] }),
    };
    const recording: Item = {
      ...work,
      id: "Q601",
      statements: { ...work.statements, P2550: [{ type: "item" as const, value: "Q600" }] },
    };
    for (const [a, b] of [
      [recording, work],
      [work, recording],
    ]) {
      expect(isWorkEditionPair(a, b)).toBe(true);
      const result = scoreCandidate(a, b);
      expect(result.confidence).toBeLessThanOrEqual(0.1);
      expect(result.reasons[0]).toContain("reissue or recording");
      expect(result.reasons.some((r) => r.startsWith("one item references the other"))).toBe(false);
    }
  });

  it("caps a whole and its part (P527 / P361) below the candidate floor", () => {
    // An album and its same-titled track share a label, P31-level type and date.
    const album: Item = {
      ...base,
      id: "Q500",
      labels: { en: "Blue Champagne" },
      statements: stmt({ P577: [{ type: "time", value: "+1990-00-00T00:00:00Z" }] }),
    };
    const track: Item = { ...album, id: "Q501" };
    expect(scoreCandidate(album, track).confidence).toBeGreaterThan(0.4);

    const hasPart = {
      ...album,
      statements: { ...album.statements, P527: [{ type: "item" as const, value: "Q501" }] },
    };
    const partOf = {
      ...track,
      statements: { ...track.statements, P361: [{ type: "item" as const, value: "Q500" }] },
    };
    for (const [a, b] of [
      [hasPart, track],
      [track, hasPart],
      [partOf, album],
      [album, partOf],
    ]) {
      expect(isPartWholePair(a, b)).toBe(true);
      const result = scoreCandidate(a, b);
      expect(result.confidence).toBeLessThanOrEqual(0.1);
      expect(result.reasons[0]).toContain("whole and its part");
      expect(result.reasons.some((r) => r.startsWith("one item references the other"))).toBe(false);
    }
    // Being part of some *third* item says nothing about this pair.
    const elsewhere = {
      ...track,
      statements: { ...track.statements, P361: [{ type: "item" as const, value: "Q1" }] },
    };
    expect(isPartWholePair(elsewhere, album)).toBe(false);
  });

  it("never pairs an item marked as a conflation (Q14946528)", () => {
    // Q141514726 vs. Q17224315: one side already conflates an anime and a manga.
    const anime: Item = {
      ...base,
      id: "Q17224315",
      labels: { en: "Kaiju Girl Caramelise" },
      statements: stmt({ P4086: [{ type: "external-id", value: "12345" }] }),
    };
    const other: Item = { ...anime, id: "Q141514726" };
    expect(scoreCandidate(anime, other).confidence).toBeGreaterThan(0.4);

    const conflation: Item = {
      ...anime,
      statements: {
        ...anime.statements,
        P31: [
          { type: "item", value: "Q63952888" },
          { type: "item", value: "Q14946528" },
        ],
      },
    };
    for (const [a, b] of [
      [conflation, other],
      [other, conflation],
    ]) {
      expect(isConflationPair(a, b)).toBe(true);
      const result = scoreCandidate(a, b);
      expect(result.confidence).toBe(0);
      expect(result.reasons[0]).toContain("conflation");
    }
    expect(isConflationPair(anime, other)).toBe(false);
  });

  it("reads four-digit years out of sitelink titles", () => {
    expect(titleYears("忠臣蔵 (2004年のテレビドラマ)")).toEqual(new Set(["2004"]));
    expect(titleYears("忠臣蔵 (１９９６年のテレビドラマ)")).toEqual(new Set(["1996"]));
    expect(titleYears("Doom (2016 video game)")).toEqual(new Set(["2016"]));
    expect(titleYears("Doom (video game)").size).toBe(0);
    expect(titleYears("Area 51500").size).toBe(0);
  });

  it("caps a pair whose same-wiki sitelinks are disambiguated by different years", () => {
    // Two TV dramas of the same name; the 1996 item carries the 2004 one's
    // start date and TMDb id, so everything else reads as a perfect match.
    const mk = (id: string, title: string): Item => ({
      ...base,
      id,
      labels: { ja: "忠臣蔵" },
      sitelinks: { jawiki: title },
      statements: stmt({ P4983: [{ type: "external-id", value: "82742" }] }),
    });
    const y2004 = mk("Q11491347", "忠臣蔵 (2004年のテレビドラマ)");
    const y1996 = mk("Q11491346", "忠臣蔵 (1996年のテレビドラマ)");
    expect(yearDisambiguatedWikis(y2004, y1996)).toEqual(["jawiki"]);
    const result = scoreCandidate(y2004, y1996, { isIdentifierProp: (pid) => pid === "P4983" });
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain("disambiguated by different years");

    // Only one side has a year, or the years agree: no signal.
    expect(yearDisambiguatedWikis(y2004, mk("Q3", "忠臣蔵 (テレビドラマ)"))).toEqual([]);
    expect(yearDisambiguatedWikis(y2004, mk("Q4", "忠臣蔵 2004"))).toEqual([]);
    // A redirect (e.g. left behind by a year-correcting rename) doesn't count.
    const redirect = { ...y1996, sitelinkBadges: { jawiki: ["Q70893996"] } };
    expect(yearDisambiguatedWikis(y2004, redirect)).toEqual([]);
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
    // label + P31 + that shared id would otherwise read as a strong per-subject
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
    expect(qualified.confidence).toBeLessThanOrEqual(0.1);
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
        r.includes("held below near-certain: only one strong corroborating signal"),
      ),
    ).toBe(true);
  });
});

describe("scoreCandidate — creators, loose names, clashes and aggregator ids", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const P31 = { P31: [{ type: "item" as const, value: "Q7725634" }] };
  const mk = (id: string, name: string, statements: Item["statements"], extra = {}): Item => ({
    ...base,
    id,
    labels: { en: name },
    statements: { ...P31, ...statements },
    ...extra,
  });
  const ext = (value: string) => [{ type: "external-id" as const, value }];
  const isId = (pid: string) => /^P(1954|8383|4549|5794|646|2671|12570|213)$/.test(pid);

  it("drops a title-only pair with different authors below the floor", () => {
    const a = mk("Q1", "Imagine", { P50: [{ type: "item", value: "Q10" }] });
    const b = mk("Q2", "Imagine", { P50: [{ type: "item", value: "Q20" }] });
    const result = scoreCandidate(a, b);
    expect(result.confidence).toBeLessThan(0.4);
    expect(result.reasons).toContain("different author (P50)");
  });

  it("holds a shared-id pair with different performers well off near-certain", () => {
    // Two albums called "The Definitive Collection" by different artists that
    // collide on a Discogs master id.
    const a = mk("Q1", "The Definitive Collection", {
      P175: [{ type: "item", value: "Q10" }],
      P1954: ext("12345"),
    });
    const b = mk("Q2", "The Definitive Collection", {
      P175: [{ type: "item", value: "Q20" }],
      P1954: ext("12345"),
    });
    const result = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(result.confidence).toBeLessThanOrEqual(0.5);
    expect(result.reasons).toContain("different performer (P175)");
  });

  it("doesn't count overlapping or same-named creators as different", () => {
    const a = mk("Q1", "Imagine", {
      P175: [
        { type: "item", value: "Q10" },
        { type: "item", value: "Q11" },
      ],
      P2093: [{ type: "string", value: "Jill Barnett" }],
    });
    const b = mk("Q2", "Imagine", {
      P175: [{ type: "item", value: "Q11" }],
      P2093: [{ type: "string", value: "Jill  Barnett" }],
    });
    expect(scoreCandidate(a, b).reasons.some((r) => r.startsWith("different "))).toBe(false);
    // Two QIDs for one person (labels loaded) aren't different creators either.
    const c = mk("Q3", "Imagine", { P50: [{ type: "item", value: "Q10", label: "Jill Barnett" }] });
    const d = mk("Q4", "Imagine", { P50: [{ type: "item", value: "Q20", label: "Jill Barnett" }] });
    expect(scoreCandidate(c, d).reasons.some((r) => r.startsWith("different "))).toBe(false);
  });

  it("caps loosely-named pairs even when everything else agrees", () => {
    // Batch-created siblings: many shared ids and statements, only the name differs.
    const shared = {
      P4549: ext("arlima-1"),
      P8383: ext("gr-1"),
      P577: [{ type: "time" as const, value: "+1200-00-00T00:00:00Z" }],
      P921: [{ type: "item" as const, value: "Q5" }],
      P1433: [{ type: "item" as const, value: "Q6" }],
    };
    const loose = scoreCandidate(
      mk("Q1", "Tainted Magdalene", shared),
      mk("Q2", "Tainted Lazarus", shared),
      { isIdentifierProp: isId },
    );
    expect(loose.confidence).toBeLessThanOrEqual(0.72);
    const different = scoreCandidate(mk("Q3", "Alpha", shared), mk("Q4", "Omega Zeta", shared), {
      isIdentifierProp: isId,
    });
    expect(different.confidence).toBeLessThanOrEqual(0.6);
  });

  it("caps a pair whose names match only through an alias", () => {
    // Two books from one batch import: different titles, a shared series alias,
    // and a shared edition id — everything agrees except the label.
    const shared = {
      P4549: ext("arlima-1"),
      P8383: ext("gr-1"),
      P577: [{ type: "time" as const, value: "+2020-00-00T00:00:00Z" }],
      P921: [{ type: "item" as const, value: "Q5" }],
      P1433: [{ type: "item" as const, value: "Q6" }],
    };
    const alias = { aliases: { en: ["Understand Yourself"] } };
    const result = scoreCandidate(
      mk("Q1", "Human Personality Types", shared, alias),
      mk("Q2", "Arabian Markets: 200+ Case Studies", shared, alias),
      { isIdentifierProp: isId },
    );
    expect(result.confidence).toBeLessThanOrEqual(0.72);
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(result.reasons).toContain("label matches the other item's alias");
    expect(result.reasons).toContain(
      "held below near-certain: the names match only through an alias",
    );
    // Labels already very similar on their own: the alias adds nothing to cap.
    const close = scoreCandidate(
      mk("Q3", "Human Personality Types", shared, alias),
      mk("Q4", "Human Personality Type", shared, alias),
      { isIdentifierProp: isId },
    );
    expect(close.confidence).toBeGreaterThan(0.72);
  });

  it("caps a pair with a non-redirect sitelink clash at 0.85", () => {
    const shared = {
      P4549: ext("arlima-1"),
      P8383: ext("gr-1"),
      P577: [{ type: "time" as const, value: "+1200-00-00T00:00:00Z" }],
      P921: [{ type: "item" as const, value: "Q5" }],
    };
    const a = mk("Q1", "Spiritual Canticle", shared, { sitelinks: { enwiki: "Page A" } });
    const b = mk("Q2", "Spiritual Canticle", shared, { sitelinks: { enwiki: "Page B" } });
    const result = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(result.confidence).toBeLessThanOrEqual(0.85);
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it("scores a shared Freebase / Knowledge Graph / ISNI id as weak evidence", () => {
    for (const pid of ["P646", "P2671", "P213"]) {
      const a = mk("Q1", "Yu-Gi-Oh! Online", { [pid]: ext("/m/0abc") });
      const b = mk("Q2", "Yu-Gi-Oh! Online", { [pid]: ext("/m/0abc") });
      const result = scoreCandidate(a, b, { isIdentifierProp: isId });
      expect(result.reasons).toContain(`shares an often-conflated aggregator identifier: ${pid}`);
      expect(result.reasons.some((r) => r.startsWith("shares external identifier"))).toBe(false);
    }
  });

  it("drops namesake bands from different countries below the floor", () => {
    // The Professionals: a US band and a UK band.
    const a = mk("Q1", "The Professionals", { P495: [{ type: "item", value: "Q30" }] });
    const b = mk("Q2", "The Professionals", { P495: [{ type: "item", value: "Q145" }] });
    const result = scoreCandidate(a, b);
    expect(result.confidence).toBeLessThan(0.4);
    expect(result.reasons).toContain("different country of origin (P495)");
  });

  it("holds a shared-id pair from different countries off likely", () => {
    // Bamboo: a Swedish and a Filipino band on one shared catalogue id.
    const a = mk("Q1", "Bamboo", { P495: [{ type: "item", value: "Q34" }], P5794: ext("x") });
    const b = mk("Q2", "Bamboo", { P495: [{ type: "item", value: "Q928" }], P5794: ext("x") });
    const result = scoreCandidate(a, b, { isIdentifierProp: isId });
    expect(result.confidence).toBeLessThanOrEqual(0.6);
    expect(result.reasons).toContain("different country of origin (P495)");
  });

  it("ignores overlapping countries but not disjoint citizenships", () => {
    const a = mk("Q1", "Edge", {
      P27: [
        { type: "item", value: "Q30" },
        { type: "item", value: "Q884" },
      ],
    });
    const b = mk("Q2", "Edge", { P27: [{ type: "item", value: "Q884" }] });
    expect(scoreCandidate(a, b).reasons.some((r) => r.startsWith("different country"))).toBe(false);
    const c = mk("Q3", "Edge", { P27: [{ type: "item", value: "Q408" }] });
    expect(scoreCandidate(a, c).reasons).toContain("different country of citizenship (P27)");
  });

  it("compares a band's start of work period (P2031) with the other's inception", () => {
    // Eyes: a Japanese band active from 2005 and a US band founded in 1977.
    const a = mk("Q1", "Eyes", { P2031: [{ type: "time", value: "+2005-00-00T00:00:00Z" }] });
    const b = mk("Q2", "Eyes", { P571: [{ type: "time", value: "+1977-00-00T00:00:00Z" }] });
    const result = scoreCandidate(a, b);
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain("years differ by 28");
  });

  it("doesn't compare a person's career start with a birth year", () => {
    const human = { P31: [{ type: "item" as const, value: "Q5" }] };
    const a = mk("Q1", "Jane Doe", {
      ...human,
      P2031: [{ type: "time", value: "+1990-00-00T00:00:00Z" }],
    });
    const b = mk("Q2", "Jane Doe", {
      ...human,
      P569: [{ type: "time", value: "+1965-00-00T00:00:00Z" }],
    });
    expect(scoreCandidate(a, b).reasons.some((r) => r.includes("years differ"))).toBe(false);
  });

  it("caps a pair whose slug ids differ only by a --N suffix", () => {
    const a = mk("Q1", "Bug Attack!", { P11307: ext("t-1"), P5794: ext("bug-attack--1") });
    const b = mk("Q2", "Bug Attack", { P11307: ext("t-1"), P5794: ext("bug-attack") });
    const result = scoreCandidate(a, b, {
      isIdentifierProp: (pid) => pid === "P11307" || pid === "P5794",
    });
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain('"--N" slug');
  });
});

describe("isCollectionSiblingPair", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const CMA = { type: "item" as const, value: "Q657415" }; // Cleveland Museum of Art
  // Two leaves of one bound volume, as the museum's batch import created them.
  const leaf = (id: string, inv: string, collection = CMA): Item => ({
    ...base,
    id,
    labels: { en: "Voyage en Italie en 1822" },
    descriptions: { en: `bound volume by Jean-Baptiste Isabey (${inv})` },
    statements: {
      P31: [{ type: "item", value: "Q1261026" }],
      P195: [collection],
      P217: [{ type: "string", value: inv }],
      P361: [{ type: "item", value: "Q80042200" }],
      P1476: [{ type: "string", value: "Voyage en Italie en 1822" }],
      P571: [{ type: "time", value: "+1822-00-00T00:00:00Z" }],
      P6216: [{ type: "item", value: "Q19652" }],
    },
  });

  it("flags different inventory numbers in a shared collection", () => {
    expect(isCollectionSiblingPair(leaf("Q1", "1966.218.z"), leaf("Q2", "1966.218.y"))).toBe(true);
  });

  it("caps the sibling pair below the persistence floor", () => {
    const result = scoreCandidate(leaf("Q1", "1966.218.z"), leaf("Q2", "1966.218.y"));
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain("different inventory numbers (P217)");
  });

  it("ignores case and punctuation, and any shared number", () => {
    expect(isCollectionSiblingPair(leaf("Q1", "1966.218.A"), leaf("Q2", "1966-218-a"))).toBe(false);
    const both = leaf("Q1", "1966.218.a");
    both.statements.P217.push({ type: "string", value: "OLD-42" });
    expect(isCollectionSiblingPair(both, leaf("Q2", "OLD 42"))).toBe(false);
  });

  it("needs a shared collection and a number on both sides", () => {
    const elsewhere = leaf("Q2", "1966.218.y", { type: "item", value: "Q160236" });
    expect(isCollectionSiblingPair(leaf("Q1", "1966.218.z"), elsewhere)).toBe(false);
    const unnumbered = leaf("Q2", "x");
    delete unnumbered.statements.P217;
    expect(isCollectionSiblingPair(leaf("Q1", "1966.218.z"), unnumbered)).toBe(false);
  });
});

describe("musical work siblings", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  // Two sonatas of J. C. Bach's Op. 20 set, sharing the set's one IMSLP page.
  const sonata = (id: string, n: number, key: string, codes = [`YB ${20 + n}`]): Item => ({
    ...base,
    id,
    labels: { en: `Sonata No. ${n} (op. 20,${n})` },
    descriptions: { en: "composition possibly by Johann Christian Bach" },
    statements: {
      P31: [{ type: "item", value: "Q105543609" }],
      P86: [{ type: "item", value: "Q106641" }],
      P528: codes.map((value) => ({ type: "string" as const, value })),
      P826: [{ type: "item", value: key }],
      P839: [{ type: "external-id", value: "3_Violin_Sonatas,_Op.21_(Bach,_Johann_Christian)" }],
    },
  });

  it("flags different keys, and caps the pair", () => {
    const a = sonata("Q1", 6, "Q795134");
    const b = sonata("Q2", 5, "Q277793", ["YB 26"]);
    expect(isDifferentKeyPair(a, b)).toBe(true);
    expect(isCatalogSiblingPair(a, b)).toBe(false); // a shared code
    const result = scoreCandidate(a, b, { isIdentifierProp: (pid) => pid === "P839" });
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain("different tonality (P826)");
  });

  it("flags different codes in one catalogue, and caps the pair", () => {
    const a = sonata("Q1", 6, "Q795134");
    const b = sonata("Q2", 5, "Q795134");
    expect(isDifferentKeyPair(a, b)).toBe(false);
    expect(isCatalogSiblingPair(a, b)).toBe(true);
    const result = scoreCandidate(a, b, { isIdentifierProp: (pid) => pid === "P839" });
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons[0]).toContain("different catalog codes (P528)");
  });

  it("ignores other catalogues, bare numbers and opus numbers", () => {
    const k = "Q795134";
    expect(isCatalogSiblingPair(sonata("Q1", 1, k, ["BWV 1"]), sonata("Q2", 1, k, ["K. 2"]))).toBe(
      false,
    );
    expect(isCatalogSiblingPair(sonata("Q1", 1, k, ["308/4"]), sonata("Q2", 1, k, ["307/4"]))).toBe(
      false,
    );
    expect(
      isCatalogSiblingPair(sonata("Q1", 1, k, ["Op. 19,1"]), sonata("Q2", 1, k, ["op. 20,1"])),
    ).toBe(false);
    expect(isCatalogSiblingPair(sonata("Q1", 1, k, ["B.61"]), sonata("Q2", 1, k, ["b 61"]))).toBe(
      false,
    );
  });

  it("only compares catalogue codes of created works", () => {
    const k = "Q795134";
    const a = sonata("Q1", 6, k);
    const b = sonata("Q2", 5, k);
    delete b.statements.P86;
    expect(isCatalogSiblingPair(a, b)).toBe(false);
  });

  it("needs a key on both sides", () => {
    const b = sonata("Q2", 5, "Q277793");
    delete b.statements.P826;
    expect(isDifferentKeyPair(sonata("Q1", 6, "Q795134"), b)).toBe(false);
  });
});

describe("volumes of one set", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  // Harvard University Press volumes that share one Internet Archive scan (P724).
  const book = (id: string, label: string): Item => ({
    ...base,
    id,
    labels: { en: label },
    statements: {
      P31: [{ type: "item", value: "Q7725634" }],
      P123: [{ type: "item", value: "Q1587900" }],
      P724: [{ type: "external-id", value: "letters0000jame" }],
    },
  });
  const pair = (x: string, y: string) => [book("Q1", x), book("Q2", y)] as const;

  it("reads numbered divisions anywhere in a title", () => {
    expect(
      titleDivisions("Walter Benjamin: Selected Writings, Volume 2: Part 1: 1927-1930"),
    ).toEqual(
      new Map([
        ["volume", new Set([2])],
        ["part", new Set([1])],
      ]),
    );
    expect(titleDivisions("Letters, Vol. IV")).toEqual(new Map([["volume", new Set([4])]]));
    expect(titleDivisions("Book mix")).toEqual(new Map());
    expect(titleDivisions("Partition 3")).toEqual(new Map());
  });

  it("flags different volume numbers, and caps the pair", () => {
    const [a, b] = pair(
      "The Letters of Henry James, Volume I: 1843-1875",
      "The Letters of Henry James, Volume IV: 1895-1916",
    );
    expect(isDifferentVolumePair(a, b)).toBe(true);
    const result = scoreCandidate(a, b, { isIdentifierProp: (pid) => pid === "P724" });
    expect(result.confidence).toBeLessThanOrEqual(0.1);
    expect(result.reasons.join("\n")).toContain("different volume or part numbers");
  });

  it("ignores a division named on one side only, or numbered alike", () => {
    expect(isDifferentVolumePair(...pair("Selected Writings, Volume 2", "Selected Writings"))).toBe(
      false,
    );
    expect(isDifferentVolumePair(...pair("Letters, Vol. 2", "Letters, Volume II"))).toBe(false);
  });

  it("flags year spans that don't overlap", () => {
    expect(
      isDisjointYearRangePair(
        ...pair(
          "Adams Family Correspondence: March 1787-December 1789",
          "Adams Family Correspondence: January 1790 – December 1793",
        ),
      ),
    ).toBe(true);
    const [a, b] = pair("Diaries 1915-1919", "Diaries 1920-1924");
    expect(scoreCandidate(a, b).reasons[0]).toContain("non-overlapping year ranges");
  });

  it("ignores overlapping spans and single years", () => {
    expect(isDisjointYearRangePair(...pair("Writings 1913-1926", "Writings 1913-1927"))).toBe(
      false,
    );
    expect(isDisjointYearRangePair(...pair("Doom (1993)", "Doom (2016)"))).toBe(false);
  });
});

describe("scoreCandidate — people", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const item = (v: string) => [{ type: "item" as const, value: v }];
  const time = (v: string) => [{ type: "time" as const, value: v }];
  const person = (id: string, extra: Item["statements"] = {}): Item => ({
    ...base,
    id,
    labels: { en: "Sarah Hamilton" },
    statements: {
      P31: item("Q5"),
      P21: item("Q6581072"),
      P27: item("Q30"),
      P106: item("Q2405480"),
      P735: item("Q18201513"),
      P734: item("Q21450552"),
      ...extra,
    },
  });

  it("doesn't count sex, citizenship, occupation or name parts as agreement", () => {
    // Two namesakes agree on all of these by default; only the name counts.
    const result = scoreCandidate(person("Q1"), person("Q2"));
    expect(result.reasons.some((r) => r.includes("shared statements agree"))).toBe(false);
    expect(result.confidence).toBeCloseTo(0.45);
  });

  it("rewards the same day of birth and of death", () => {
    const lived = { P569: time("+1948-05-21T00:00:00Z"), P570: time("+2020-01-02T00:00:00Z") };
    const plain = scoreCandidate(person("Q1"), person("Q2"));
    const result = scoreCandidate(person("Q1", lived), person("Q2", lived));
    expect(result.reasons).toContain("same date of birth (1948-05-21)");
    expect(result.reasons).toContain("same date of death (2020-01-02)");
    expect(result.confidence).toBeGreaterThan(plain.confidence + 0.3);
  });

  it("gives no bonus for a birth date shared only to the year or month", () => {
    for (const value of ["+1948-00-00T00:00:00Z", "+1948-05-00T00:00:00Z"]) {
      const result = scoreCandidate(
        person("Q1", { P569: time(value) }),
        person("Q2", { P569: time(value) }),
      );
      expect(result.reasons.some((r) => r.startsWith("same date of birth"))).toBe(false);
    }
  });

  it("gives no bonus when the days of birth differ", () => {
    const result = scoreCandidate(
      person("Q1", { P569: time("+1948-05-21T00:00:00Z") }),
      person("Q2", { P569: time("+1948-05-22T00:00:00Z") }),
    );
    expect(result.reasons.some((r) => r.startsWith("same date of birth"))).toBe(false);
  });
});

describe("scoreCandidate — ids naming a page section", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const colleague = (id: string, name: string, fandom: string): Item => ({
    ...base,
    id,
    labels: { mul: name },
    statements: {
      P31: [{ type: "item", value: "Q5" }],
      P6262: [{ type: "external-id", value: fandom }],
      P108: [{ type: "item", value: "Q138034847" }],
    },
  });

  it("treats a shared id with a #section anchor as weak (two members of one studio)", () => {
    const section = "no-i-am-not-a-human:Trioskaz#Members";
    const result = scoreCandidate(
      colleague("Q138035335", "Vladomir Svistunov", section),
      colleague("Q139493693", "Elisey Sinitsa", section),
    );
    expect(result.reasons).toContain("shares an identifier naming a page section: P6262");
    expect(result.confidence).toBeLessThan(0.4);
  });

  it("still counts the same id without an anchor as strong", () => {
    const page = "no-i-am-not-a-human:Vladomir_Svistunov";
    const result = scoreCandidate(
      colleague("Q1", "Vladomir Svistunov", page),
      colleague("Q2", "Vladomir Svistunov", page),
    );
    expect(result.reasons).toContain("shares external identifier: P6262");
  });
});

describe("scoreCandidate — namesake progamers", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const player = (id: string, country: string, liquipedia: string, aligulac: string): Item => ({
    ...base,
    id,
    labels: { en: "Mamba" },
    statements: {
      P31: [{ type: "item", value: "Q5" }],
      P27: [{ type: "item", value: country }],
      P742: [{ type: "string", value: "Mamba" }],
      P641: [{ type: "item", value: "Q300920" }],
      P2416: [{ type: "item", value: "Q18142874" }],
      P10918: [{ type: "external-id", value: liquipedia }],
      P11706: [{ type: "external-id", value: aligulac }],
    },
  });

  it("separates two players who share a handle but have their own player pages", () => {
    const result = scoreCandidate(
      player("Q117453597", "Q39", "starcraft2/Mamba_(Swiss_player)", "9877"),
      player("Q117453598", "Q865", "starcraft2/Mamba_(Taiwanese_player)", "7813"),
    );
    expect(result.reasons[0]).toContain("2 per-subject identifiers differ (P10918, P11706)");
    expect(result.reasons.some((r) => r.includes("shared statements agree"))).toBe(false);
    expect(result.confidence).toBeLessThan(0.4);
  });
});

describe("scoreCandidate — Wikipedia articles in different languages", () => {
  const base = {
    descriptions: {},
    aliases: {},
    statements: { P31: [{ type: "item" as const, value: "Q5" }] },
  };
  const mk = (id: string, sitelinks: Record<string, string>, extra: Partial<Item> = {}): Item => ({
    ...base,
    id,
    labels: { en: "Michael Brough" },
    sitelinks,
    ...extra,
  });
  const complementary = (r: { reasons: string[] }) =>
    r.reasons.find((x) => x.startsWith("Wikipedia articles in different languages"));

  it("boosts a pair whose articles are on different wikis (Michael Brough)", () => {
    const fr = mk("Q29907256", { frwiki: "Michael Brough" });
    const en = mk("Q47541849", {
      enwiki: "Michael Brough (game designer)",
      commonswiki: "Category:Michael Brough (game designer)",
    });
    const result = scoreCandidate(fr, en);
    expect(complementary(result)).toBe(
      "Wikipedia articles in different languages, none on the same wiki (frwiki / enwiki)",
    );
    const bare = scoreCandidate(mk("Q1", { frwiki: "x" }), mk("Q2", {}));
    expect(result.confidence).toBeCloseTo(bare.confidence + 0.1);
  });

  it("doesn't fire when a wiki has a page for both", () => {
    const result = scoreCandidate(
      mk("Q1", { frwiki: "A", dewiki: "A" }),
      mk("Q2", { enwiki: "B", dewiki: "B" }),
    );
    expect(complementary(result)).toBeUndefined();
  });

  it("doesn't count a redirect or a non-Wikipedia sitelink as an article", () => {
    const redirect = mk("Q1", { frwiki: "A" }, { sitelinkBadges: { frwiki: ["Q70893996"] } });
    expect(complementary(scoreCandidate(redirect, mk("Q2", { enwiki: "B" })))).toBeUndefined();
    const commons = mk("Q3", { commonswiki: "Category:A", enwikiquote: "A" });
    expect(complementary(scoreCandidate(commons, mk("Q4", { enwiki: "B" })))).toBeUndefined();
  });
});

describe("scoreCandidate — namesake anime staff", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const staff = (id: string, anilist: string, mal: string): Item => ({
    ...base,
    id,
    labels: { en: "Takashi Watanabe" },
    statements: {
      P31: [{ type: "item", value: "Q5" }],
      P11227: [{ type: "external-id", value: anilist }],
      P4084: [{ type: "external-id", value: mal }],
    },
  });

  it("separates two staff who share a name but have their own AniList and MAL pages", () => {
    const result = scoreCandidate(staff("Q1", "100185", "6155"), staff("Q2", "96870", "7118"));
    expect(result.reasons[0]).toContain("2 per-subject identifiers differ (P11227, P4084)");
    expect(result.confidence).toBeLessThan(0.4);
  });

  it("still pairs two items sharing an AniList staff id", () => {
    const result = scoreCandidate(staff("Q1", "100185", "6155"), staff("Q2", "100185", "6155"));
    expect(result.reasons).toContain("shares external identifier: P11227, P4084");
  });
});

describe("scoreCandidate — namesake Olympians", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const olympian = (id: string, ids: Record<string, string>): Item => ({
    ...base,
    id,
    labels: { en: "Kim Min-jung" },
    statements: {
      P31: [{ type: "item", value: "Q5" }],
      ...Object.fromEntries(
        Object.entries(ids).map(([p, value]) => [p, [{ type: "external-id" as const, value }]]),
      ),
    },
  });

  it("separates two Olympians who share a name but have their own Olympedia and Olympics.com pages", () => {
    const result = scoreCandidate(
      olympian("Q1", { P8286: "93530", P5815: "1000001" }),
      olympian("Q2", { P8286: "130021", P5815: "1000002" }),
    );
    expect(result.reasons[0]).toContain("2 per-subject identifiers differ (P5815, P8286)");
    expect(result.confidence).toBeLessThan(0.4);
  });

  it("doesn't count The-Sports.org as one page per person", () => {
    const result = scoreCandidate(
      olympian("Q1", { P8286: "93530", P4391: "1234" }),
      olympian("Q2", { P8286: "130021", P4391: "5678" }),
    );
    expect(result.reasons.join("\n")).not.toContain("per-subject identifiers differ");
  });
});

describe("differingNativeNames / scoreCandidate — native-script names", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const person = (
    id: string,
    {
      ja,
      native,
      country = "Q17",
      p31 = "Q5",
    }: { ja?: string; native?: string; country?: string; p31?: string },
  ): Item => ({
    ...base,
    id,
    labels: { en: "Aya Takano", ...(ja ? { ja } : {}) },
    statements: {
      P31: [{ type: "item", value: p31 }],
      P27: [{ type: "item", value: country }],
      ...(native ? { P1559: [{ type: "string" as const, value: native }] } : {}),
    },
  });

  it("tells apart namesakes whose kanji differ", () => {
    const a = person("Q1", { native: "山本正弘" });
    const b = person("Q2", { ja: "山本雅博" });
    expect(differingNativeNames(a, b)).toEqual(["山本正弘", "山本雅博"]);
    const result = scoreCandidate(a, b);
    expect(result.reasons).toContain("different names in native script (山本正弘 / 山本雅博)");
    expect(result.confidence).toBeLessThan(0.4);
  });

  it("counts a katakana stylization against a kanji name, even with the same reading", () => {
    expect(
      differingNativeNames(
        person("Q1", { native: "タカノ綾" }),
        person("Q2", { native: "髙野綾" }),
      ),
    ).not.toBeNull();
  });

  it("folds spacing, variant kanji and katakana", () => {
    const same = [
      ["植村 秀", "植村秀"],
      ["宮﨑 知子", "宮崎知子"],
      ["髙野綾", "高野 綾"],
      ["山田龍城", "山田竜城"],
      ["エンデ・佐藤真理子", "佐藤真理子"],
    ];
    for (const [x, y] of same)
      expect(
        differingNativeNames(person("Q1", { native: x }), person("Q2", { native: y })),
      ).toBeNull();
    expect(foldNativeName("タカノ 綾")).toBe(foldNativeName("たかの綾"));
  });

  it("matches when any of the names agree (a stage name alongside a legal name)", () => {
    const a = person("Q1", { native: "大野穣", ja: "北島三郎" });
    const b = person("Q2", { ja: "北島 三郎" });
    expect(differingNativeNames(a, b)).toBeNull();
  });

  it("ignores all-kana names, which are often a reading of the kanji", () => {
    expect(
      differingNativeNames(
        person("Q1", { native: "いぬい とみこ" }),
        person("Q2", { native: "乾 富子" }),
      ),
    ).toBeNull();
  });

  it("compares hangul names", () => {
    const a = person("Q1", { native: "유병철", country: "Q884" });
    const b = person("Q2", { native: "김병철", country: "Q884" });
    expect(differingNativeNames(a, b)).toEqual(["유병철", "김병철"]);
  });

  it("skips non-humans, and ja labels of people who aren't Japanese citizens", () => {
    expect(
      differingNativeNames(
        person("Q1", { native: "山本正弘", p31: "Q7889" }),
        person("Q2", { native: "山本雅博", p31: "Q7889" }),
      ),
    ).toBeNull();
    // A Chinese name in simplified vs. traditional characters.
    expect(
      differingNativeNames(
        person("Q1", { ja: "习近平", native: "习近平", country: "Q148" }),
        person("Q2", { ja: "習近平", native: "習近平", country: "Q148" }),
      ),
    ).toBeNull();
  });

  it("lets a shared id keep the pair a candidate, held off near-certain", () => {
    const id = { P11227: [{ type: "external-id" as const, value: "1" }] };
    const a = person("Q1", { native: "高野綾" });
    const b = person("Q2", { native: "タカノ綾" });
    const result = scoreCandidate(
      { ...a, statements: { ...a.statements, ...id } },
      { ...b, statements: { ...b.statements, ...id } },
    );
    expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    expect(result.confidence).toBeLessThanOrEqual(0.6);
  });
});

describe("differingPersonalAccounts / scoreCandidate — social-media handles", () => {
  const base = { descriptions: {}, aliases: {}, sitelinks: {} };
  const person = (id: string, accounts: Item["statements"], p31 = "Q5"): Item => ({
    ...base,
    id,
    labels: { en: "Azure" },
    statements: { P31: [{ type: "item", value: p31 }], ...accounts },
  });
  const handle = (value: string) => [{ type: "external-id" as const, value }];

  it("docks two people with their own X accounts below the floor", () => {
    const a = person("Q1", { P2002: handle("azure_sc2") });
    const b = person("Q2", { P2002: handle("azure_0608_sub") });
    expect(differingPersonalAccounts(a, b)).toEqual(["P2002"]);
    const result = scoreCandidate(a, b);
    expect(result.reasons).toContain("different social-media accounts (P2002)");
    expect(result.confidence).toBeLessThan(0.4);
  });

  it("matches handles case-insensitively, ignoring a leading @, and any shared one", () => {
    const a = person("Q1", { P2002: [...handle("@CoreEdgeSC"), ...handle("old_handle")] });
    const b = person("Q2", { P2002: handle("coreedgesc") });
    expect(differingPersonalAccounts(a, b)).toEqual([]);
  });

  it("ignores one-sided accounts and non-humans", () => {
    expect(
      differingPersonalAccounts(person("Q1", { P2002: handle("x") }), person("Q2", {})),
    ).toEqual([]);
    expect(
      differingPersonalAccounts(
        person("Q1", { P2002: handle("x") }, "Q7889"),
        person("Q2", { P2002: handle("y") }, "Q7889"),
      ),
    ).toEqual([]);
  });
});

describe("scoreCandidate description reason", () => {
  const base = { aliases: {}, statements: {}, sitelinks: {} };
  const book = (id: string, descriptions: Record<string, string>): Item => ({
    ...base,
    id,
    labels: { en: "Delta of Venus" },
    descriptions,
  });

  it("notes identical and similar descriptions without changing the score", () => {
    const plain = scoreCandidate(book("Q1", {}), book("Q2", {}));
    const same = scoreCandidate(
      book("Q1", { en: "1977 short story by Anaïs Nin" }),
      book("Q2", { en: "1977 Short Story by Anaïs Nin" }),
    );
    expect(same.reasons).toContain("identical description");
    expect(same.confidence).toBe(plain.confidence);

    const similar = scoreCandidate(
      book("Q1", { en: "1977 short story by Anaïs Nin" }),
      book("Q2", { en: "1977 short story collection by Anaïs Nin" }),
    );
    expect(similar.reasons.some((r) => r.startsWith("similar descriptions ("))).toBe(true);
    expect(similar.confidence).toBe(plain.confidence);
  });

  it("names the language of an identical description outside English", () => {
    const dutch = scoreCandidate(
      book("Q1", { en: "1977 short story", nl: "boek van Ramachandra Guha" }),
      book("Q2", { en: "1978 novella", nl: "boek van Ramachandra Guha" }),
    );
    expect(dutch.reasons).toContain("identical description (nl)");
    // English wins a tie, and then goes unnamed.
    const both = scoreCandidate(
      book("Q1", { en: "1977 short story", nl: "kort verhaal" }),
      book("Q2", { en: "1977 short story", nl: "kort verhaal" }),
    );
    expect(both.reasons).toContain("identical description");
  });

  it("only compares descriptions within a shared language", () => {
    const result = scoreCandidate(
      book("Q1", { en: "video game" }),
      book("Q2", { de: "video game" }),
    );
    expect(result.reasons.some((r) => r.includes("description"))).toBe(false);
  });
});

describe("coordinates", () => {
  const bigBen = coordinateValue(51.5007292, -0.1246254, 0.0001);
  const londonEye = coordinateValue(51.5032973, -0.1195537, 0.0001);

  it("calls identical coordinates identical", () => {
    expect(compareValues(bigBen, coordinateValue(51.5007292, -0.1246254))).toEqual(["identical"]);
  });

  it("calls nearby coordinates distinct, with the distance", () => {
    expect(compareValues(bigBen, londonEye)).toEqual(["distinct", "453 m apart"]);
    const [status, note] = compareValues(bigBen, coordinateValue(51.95, -0.1246254));
    expect(status).toBe("distinct");
    expect(note).toBe("50 km apart");
  });

  it("calls the same numbers on different globes distinct", () => {
    expect(compareValues(coordinateValue(1, 2), coordinateValue(1, 2, undefined, "Q111"))).toEqual([
      "distinct",
    ]);
  });

  it("keeps the nearest distance note on a distinct row", () => {
    const [row] = buildRows(
      { ...empty("Q1"), statements: { P625: [bigBen] } },
      {
        ...empty("Q2"),
        statements: { P625: [coordinateValue(40, -3), londonEye] },
      },
    ).filter((r) => r.key === "P625");
    expect(row.status).toBe("distinct");
    expect(row.a[0].note).toBe("453 m apart");
  });

  it("backfills a globe label", () => {
    const mars = coordinateValue(18.65, 226.2, 0.01, "Q111");
    const [row] = buildRows(
      { ...empty("Q1"), statements: { P625: [mars] } },
      { ...empty("Q2"), statements: { P625: [mars] } },
      {},
      { Q111: "Mars" },
    ).filter((r) => r.key === "P625");
    expect(row.a[0].globeLabel).toBe("Mars");
  });

  it("never counts matching coordinates as a shared identifier", () => {
    const a = { ...empty("Q1"), labels: { en: "Place" }, statements: { P625: [bigBen] } };
    const b = { ...empty("Q2"), labels: { en: "Place" }, statements: { P625: [bigBen] } };
    const score = scoreCandidate(a, b);
    expect(score.reasons.join(" ")).not.toMatch(/external identifier/);
  });

  function empty(id: string): Item {
    return { id, labels: {}, descriptions: {}, aliases: {}, sitelinks: {}, statements: {} };
  }
});

describe("isSequencedPair (follows / followed by)", () => {
  // Q119850903 / Q119850755: two sides of Fragment's Note 2, separate games that
  // share store listings (App Store, Google Play, …) and link each other with
  // P155 / P156. They scored 0.88 before the link capped them.
  const shared = {
    P31: [{ type: "item" as const, value: "Q7889" }],
    P178: [{ type: "item" as const, value: "Q18455941" }],
    P179: [{ type: "item" as const, value: "Q119851053" }],
    P3861: [{ type: "external-id" as const, value: "1107571023" }],
    P3418: [{ type: "external-id" as const, value: "com.ullucus.fragmentsnote2en" }],
    P5794: [{ type: "external-id" as const, value: "fragments-note-2" }],
    P7597: [{ type: "external-id" as const, value: "fragments-note-2" }],
  };
  const side = (id: string, label: string, link: Record<string, Value[]>): Item => ({
    id,
    labels: { en: label },
    descriptions: { en: "visual novel video game" },
    aliases: {},
    sitelinks: {},
    statements: { ...shared, ...link },
  });
  const yukitsuki = side("Q119850903", "Fragment’s Note 2 Side: Yukitsuki", {
    P155: [{ type: "item", value: "Q119850755" }],
  });
  const shizuku = side("Q119850755", "Fragment’s Note 2 Side: Shizuku", {
    P156: [{ type: "item", value: "Q119850903" }],
  });

  it("detects a follows or followed-by link in either direction", () => {
    expect(isSequencedPair(yukitsuki, shizuku)).toBe(true);
    expect(isSequencedPair(shizuku, yukitsuki)).toBe(true);
    const { P155: _, ...unlinked } = yukitsuki.statements;
    expect(isSequencedPair({ ...yukitsuki, statements: unlinked }, shizuku)).toBe(true);
    expect(
      isSequencedPair({ ...yukitsuki, statements: unlinked }, { ...shizuku, statements: shared }),
    ).toBe(false);
  });

  it("caps the pair below the persistence floor despite shared store ids", () => {
    const score = scoreCandidate(yukitsuki, shizuku);
    expect(score.confidence).toBeLessThanOrEqual(0.1);
    expect(score.reasons[0]).toMatch(/follows \/ followed by/);
  });
});

describe("isDerivativePair (based on / derivative work)", () => {
  // Q139737789 / Q139737788: a keyboard piece and the prelude derived from it,
  // both "Keyboard Piece/Prelude in C minor", sharing an IMSLP id (P839) and
  // linked with P144 / P4969. They scored 0.90 before the link capped them.
  const common = {
    P31: [{ type: "item" as const, value: "Q105543609" }],
    P86: [{ type: "item" as const, value: "Q1339" }],
    P839: [{ type: "external-id" as const, value: "Keyboard_Piece/Prelude_in_C_minor" }],
  };
  const work = (id: string, extra: Record<string, Value[]>): Item => ({
    id,
    labels: { en: "Keyboard Piece/Prelude in C minor" },
    descriptions: { en: "composition by Johann Sebastian Bach" },
    aliases: {},
    sitelinks: {},
    statements: { ...common, ...extra },
  });
  const original = work("Q139737788", { P4969: [{ type: "item", value: "Q139737789" }] });
  const derived = work("Q139737789", { P144: [{ type: "item", value: "Q139737788" }] });

  it("detects based on or derivative work in either direction", () => {
    expect(isDerivativePair(original, derived)).toBe(true);
    expect(isDerivativePair(derived, work("Q139737788", {}))).toBe(true);
    expect(isDerivativePair(work("Q139737789", {}), original)).toBe(true);
    expect(isDerivativePair(work("Q139737789", {}), work("Q139737788", {}))).toBe(false);
  });

  it("caps the pair below the persistence floor despite a shared id", () => {
    const score = scoreCandidate(original, derived);
    expect(score.confidence).toBeLessThanOrEqual(0.1);
    expect(score.reasons[0]).toMatch(/based on \/ derivative work/);
  });
});
