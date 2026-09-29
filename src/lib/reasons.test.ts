import { describe, expect, it } from "vite-plus/test";
import { capIdReason, confidenceVerdict, groupReasons, reasonPids, reasonTone } from "./reasons.ts";

describe("capIdReason", () => {
  it("splits an identifier list past the cap", () => {
    expect(
      capIdReason("shares external identifier: P1, Steam application ID, P3, P4, P5", 3),
    ).toEqual({
      prefix: "shares external identifier",
      shown: ["P1", "Steam application ID", "P3"],
      hidden: ["P4", "P5"],
    });
    expect(capIdReason("shares account/social identifier: P1, P2", 1)).toMatchObject({
      shown: ["P1"],
      hidden: ["P2"],
    });
  });

  it("leaves short lists and other reasons alone", () => {
    expect(capIdReason("shares external identifier: P1, P2, P3", 3)).toBeNull();
    expect(capIdReason("identical label", 3)).toBeNull();
    expect(capIdReason("one item references the other (P1, P2, P3, P4)", 3)).toBeNull();
  });
});

describe("reasonTone", () => {
  it("classifies positive and negative signals by strength", () => {
    expect(reasonTone("shares external identifier: P1085")).toEqual({
      polarity: "positive",
      strength: 3,
    });
    expect(reasonTone("identical label")).toMatchObject({ polarity: "positive", strength: 3 });
    expect(reasonTone("same instance of (P31)")).toMatchObject({
      polarity: "positive",
      strength: 1,
    });
    expect(reasonTone("identical description")).toMatchObject({ polarity: "positive" });
    expect(reasonTone("different names (20%)")).toMatchObject({
      polarity: "negative",
      strength: 3,
    });
    expect(reasonTone("different names in native script (髙野綾 / タカノ綾)")).toMatchObject({
      polarity: "negative",
      strength: 2,
    });
    expect(reasonTone("different developer")).toMatchObject({ polarity: "negative", strength: 2 });
    expect(reasonTone("different entries in a series (sequel), not a duplicate")).toMatchObject({
      polarity: "negative",
      strength: 3,
    });
    expect(reasonTone("1 conflict would block the merge")).toMatchObject({
      polarity: "negative",
      strength: 3,
    });
    expect(reasonTone("something new")).toMatchObject({ polarity: "neutral" });
  });

  it("scales shared-statement agreement by the share that agrees", () => {
    expect(reasonTone("4 of 18 shared statements agree").strength).toBe(1);
    expect(reasonTone("9 of 10 shared statements agree").strength).toBe(2);
  });
});

describe("groupReasons", () => {
  it("splits signals by polarity, strongest first, and pulls out the ceiling note", () => {
    const g = groupReasons([
      "same instance of (P31)",
      "shares external identifier: P8383",
      "different developer",
      "identifier declared shared between the two items (P4070), not counted: P1",
      "held below near-certain: the names only loosely match",
    ]);
    expect(g.positive.map((r) => r.text)).toEqual([
      "shares external identifier: P8383",
      "same instance of (P31)",
    ]);
    expect(g.negative.map((r) => r.text)).toEqual(["different developer"]);
    expect(g.notes).toEqual([
      "identifier declared shared between the two items (P4070), not counted: P1",
    ]);
    expect(g.heldBelow).toBe("the names only loosely match");
    expect(groupReasons(["held below near-certain — corroboration is thin"]).heldBelow).toBe(
      "corroboration is thin",
    );
  });
});

describe("confidenceVerdict", () => {
  it("reads the score in words", () => {
    expect(confidenceVerdict(0.95)).toBe("Almost certainly the same item");
    expect(confidenceVerdict(0.6)).toBe("Likely the same item");
    expect(confidenceVerdict(0.45)).toBe("Possibly the same item");
    expect(confidenceVerdict(0.1)).toBe("Probably different items");
  });
});

describe("reasonPids", () => {
  it("lists each property id once", () => {
    expect(reasonPids("one item references the other (P155, P156, P155)")).toEqual([
      "P155",
      "P156",
    ]);
    expect(reasonPids("identical label")).toEqual([]);
  });
});
