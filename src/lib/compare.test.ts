import { describe, expect, it } from "vite-plus/test";
import {
  buildRows,
  compareValues,
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
