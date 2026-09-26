import { describe, expect, it } from "vite-plus/test";
import type { Item } from "./compare.ts";
import {
  canReview,
  encodeLanguageList,
  languageSqlPatterns,
  normalizeLanguages,
  pairLanguages,
  readsLanguage,
} from "./languages.ts";

function item(id: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    labels: { en: "Game" },
    descriptions: {},
    aliases: {},
    sitelinks: {},
    statements: {},
    ...extra,
  };
}

describe("normalizeLanguages", () => {
  it("trims, lowercases, dedupes, and drops junk and mul", () => {
    expect(normalizeLanguages([" EN ", "de", "en", "pt_BR", "mul", "", "x", "e!", 3])).toEqual([
      "en",
      "de",
      "pt-br",
    ]);
  });
});

describe("pairLanguages", () => {
  it("collects blocking sitelink clashes by the wiki's language", () => {
    const a = item("Q2", {
      labels: { ko: "게임", mul: "Game" },
      sitelinks: {
        kowiki: "A",
        enwiki: "Same",
        eswiki: "X",
        commonswiki: "C1",
        zh_yuewiki: "Y1",
      },
    });
    const b = item("Q1", {
      sitelinks: { kowiki: "B", enwiki: "Same", eswiki: "X", commonswiki: "C2", zh_yuewiki: "Y2" },
    });
    expect(pairLanguages(a, b)).toEqual({
      clash: ["ko", "yue"],
      fromLabels: ["ko", "mul"],
      intoLabels: ["en"],
    });
  });

  it("skips a clash where one page redirects to the other's", () => {
    const a = item("Q2", { sitelinks: { kowiki: "A" }, sitelinkRedirects: { kowiki: "B" } });
    const b = item("Q1", { sitelinks: { kowiki: "B" } });
    expect(pairLanguages(a, b).clash).toEqual([]);
  });
});

describe("canReview", () => {
  const pair = { clash: ["es"], fromLabels: ["ja", "mul"], intoLabels: ["en-gb"] };
  it("needs every clash language and a readable label on each side", () => {
    expect(canReview(["en"], pair)).toBe(false); // can't read the eswiki clash
    expect(canReview(["en", "es"], pair)).toBe(true); // mul covers the first item
    expect(canReview(["es"], pair)).toBe(false); // en-gb label unreadable
    expect(canReview(["en", "es"], { ...pair, fromLabels: ["ja"] })).toBe(false);
  });

  it("reads regional variants of a language, not look-alike codes", () => {
    expect(readsLanguage(["zh"], "zh-hans")).toBe(true);
    expect(readsLanguage(["en"], "eng")).toBe(false);
  });
});

describe("languageSqlPatterns", () => {
  // Same semantics as canReview, checked with JS regexes (MariaDB's REGEXP is
  // PCRE, which agrees on these).
  const { allRead, anyRead } = languageSqlPatterns(["en", "zh"]);
  const all = new RegExp(allRead);
  const some = new RegExp(anyRead);

  it("allRead matches lists made only of read languages", () => {
    expect(all.test("")).toBe(true);
    expect(all.test(encodeLanguageList(["en", "zh-hans"]))).toBe(true);
    expect(all.test(encodeLanguageList(["en", "ko"]))).toBe(false);
    expect(all.test(encodeLanguageList(["eng"]))).toBe(false);
  });

  it("anyRead matches lists with a read language or mul", () => {
    expect(some.test("")).toBe(false);
    expect(some.test(encodeLanguageList(["de", "en-gb"]))).toBe(true);
    expect(some.test(encodeLanguageList(["ja", "mul"]))).toBe(true);
    expect(some.test(encodeLanguageList(["ja", "zhx"]))).toBe(false);
  });
});
