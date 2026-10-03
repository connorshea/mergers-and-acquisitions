import { describe, expect, it } from "vite-plus/test";
import { editSummary, newEditGroup, TOOL_CREDIT } from "./edits.ts";

describe("editSummary", () => {
  it("credits the tool and links the EditGroups batch", () => {
    expect(editSummary("Merge duplicate items Q20 → Q10", "0123456789abcdef")).toBe(
      `Merge duplicate items Q20 → Q10 (${TOOL_CREDIT}) ` +
        "([[:toolforge:editgroups/b/CB/0123456789abcdef|details]])",
    );
  });

  it("shortens a long text so the link survives Wikidata's length limit", () => {
    const summary = editSummary(`Remove enwiki sitelink "${"x".repeat(600)}"`, "abcd1234");
    expect(summary.length).toBeLessThanOrEqual(400);
    expect(summary).toContain("…");
    expect(summary).toMatch(/\(\[\[:toolforge:editgroups\/b\/CB\/abcd1234\|details\]\]\)$/);
  });
});

describe("newEditGroup", () => {
  it("makes a fresh 16-hex-digit id each time", () => {
    const a = newEditGroup();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(newEditGroup()).not.toBe(a);
  });
});
