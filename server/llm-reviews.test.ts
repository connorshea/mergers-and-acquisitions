import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { pairKey, reviewResolution } from "./llm-reviews.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("pairKey", () => {
  it("orders the QIDs by number, not as strings", () => {
    expect(pairKey("Q20", "Q10")).toEqual({ qidLow: "Q10", qidHigh: "Q20" });
    expect(pairKey("Q10", "Q20")).toEqual({ qidLow: "Q10", qidHigh: "Q20" });
    expect(pairKey("Q9", "Q10")).toEqual({ qidLow: "Q9", qidHigh: "Q10" });
  });
});

it("points a hidden pair's resolution at its review", () => {
  expect(reviewResolution(42)).toBe("llm-review:42");
});

/** The relative imports of a module (static, re-exports, and dynamic). */
function localImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specs = [
    ...source.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
  ].map((m) => m[1]);
  return specs.filter((s) => s.startsWith(".")).map((s) => resolve(dirname(file), s));
}

/** Every local module `entry` reaches through its imports, itself included. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    seen.add(file);
    stack.push(...localImports(file));
  }
  return seen;
}

// Claude never edits Wikidata: nothing on the review path may reach the edit
// client, or the edit routes that drive it.
describe("the Claude review path", () => {
  const entries = [
    "server/llm-reviews.ts",
    "server/llm-batch.ts",
    "server/llm-review-job.ts",
    "src/lib/llm-review.ts",
    "scripts/eval-llm.ts",
    ...readdirSync(resolve(ROOT, "jobs"))
      .filter((f) => /^llm-.*\.ts$/.test(f))
      .map((f) => `jobs/${f}`),
  ];
  const forbidden = ["server/wikidata-client.ts", "server/edits.ts"].map((f) => resolve(ROOT, f));

  it("covers the trial and review jobs", () => {
    expect(entries).toContain("jobs/llm-trial.ts");
    expect(entries).toContain("jobs/llm-review.ts");
  });

  it.each(entries)("%s doesn't import the Wikidata edit client", (entry) => {
    const modules = reachable(resolve(ROOT, entry));
    expect(modules.size).toBeGreaterThan(1);
    const hits = forbidden.filter((f) => modules.has(f)).map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });

  it("would catch one that does", () => {
    expect(reachable(resolve(ROOT, "server/app.ts")).has(forbidden[0])).toBe(true);
  });
});
