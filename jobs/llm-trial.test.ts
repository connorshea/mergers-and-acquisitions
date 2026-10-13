// The one-off Claude review trial's offline half: `report` over a run copied
// into a temp TOOL_DATA_DIR, finding the latest run, and the command dispatch.
// `submit` and `collect` need the DB and the API, and aren't covered here.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ResultRecord } from "../server/llm-batch.ts";
import { expectConsole, quietLogs } from "../test/console.ts";
import { latestRunDir, main, report } from "./llm-trial.ts";

const USAGE =
  "usage: node jobs/llm-trial.ts submit [--per-band N] [--wait] | collect [run-dir] [--wait] | report [run-dir]";

const pair = (id: number, confidence: number, band: string) => ({
  pair: String(id),
  candidateId: id,
  fromQid: `Q${id}1`,
  intoQid: `Q${id}2`,
  fromLabel: `From ${id}`,
  intoLabel: null,
  confidence,
  band,
  promptTokens: 1000,
});

const result = (
  model: ResultRecord["model"],
  id: number,
  verdict: "same" | "different" | "unsure",
  probability: number,
): ResultRecord => ({
  pair: String(id),
  model,
  review: { verdict, probability, rationale: `${model} on ${id}` },
  costUsd: 0.01,
});

/** A complete run: two pairs in the 0.4–0.5 band, one in ≥ 0.8. */
function writeRun(root: string, name: string): string {
  const dir = join(root, "llm-trial", name);
  mkdirSync(dir, { recursive: true });
  const run = {
    createdAt: "2026-10-01T00:00:00.000Z",
    promptVersion: 4,
    openPerBand: { "0.4–0.5": 100, "≥ 0.8": 50 },
    batches: [],
  };
  writeFileSync(join(dir, "run.json"), JSON.stringify(run));
  const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(
    join(dir, "pairs.jsonl"),
    jsonl([pair(1, 0.45, "0.4–0.5"), pair(2, 0.42, "0.4–0.5"), pair(3, 0.9, "≥ 0.8")]),
  );
  // Pair 1: both confidently "different" → hidden. Pair 2: Haiku escalates,
  // Opus says "same" → kept, and a same/different disagreement. Pair 3: Opus
  // failed.
  writeFileSync(
    join(dir, "results-haiku.jsonl"),
    jsonl([
      result("claude-haiku-5-5", 1, "different", 0.02),
      result("claude-haiku-5-5", 2, "different", 0.05),
      result("claude-haiku-5-5", 3, "same", 0.95),
    ]),
  );
  writeFileSync(
    join(dir, "results-opus.jsonl"),
    jsonl([
      result("claude-opus-5-5", 1, "different", 0.01),
      result("claude-opus-5-5", 2, "same", 0.9),
      {
        pair: "3",
        model: "claude-opus-5-5",
        review: null,
        error: "errored: overloaded",
        costUsd: 0,
      },
    ]),
  );
  return dir;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "llm-trial-test-"));
  vi.stubEnv("TOOL_DATA_DIR", root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
quietLogs();

const logged = () =>
  vi
    .mocked(console.log)
    .mock.calls.map((c) => String(c[0]))
    .join("\n");

describe("report", () => {
  it("summarizes each band and writes review.md", async () => {
    const dir = writeRun(root, "2026-10-01T00-00-00-000Z");
    await report(dir);

    const out = logged();
    expect(out).toContain(`Claude review trial — prompt v4, 3 open candidates, run ${dir}`);
    expect(out).toContain("Band 0.4–0.5 (2 sampled of 100 open):");
    expect(out).toContain("  haiku  0 same / 2 diff / 0 unsure");
    expect(out).toContain("  opus   1 same / 1 diff / 0 unsure");
    expect(out).toContain(
      '  haiku confidently "different": 2 (100%) → opus confirms 1; would hide 50% of the band; ' +
        "1 same/different disagreements",
    );
    expect(out).toContain("  opus   0 same / 0 diff / 0 unsure / 1 failed");
    expect(out).toContain("  haiku  $0.030 this run");
    expect(out).toContain(
      "review.md: 1 would hide, 1 haiku would escalate, opus doesn't confirm, " +
        "0 opus is confident, haiku isn't, 1 same vs different",
    );

    const md = readFileSync(join(dir, "review.md"), "utf8");
    expect(md).toMatch(/^# Claude review trial, 2026-10-01\n/);
    expect(md).toContain("## Would hide (1)");
    expect(md).toContain(
      "- [From 1 (Q11) → Q12 (Q12)](https://mna.toolforge.org/candidates/1) · heuristic 0.45",
    );
    expect(md).toContain("  - **opus** different (p=0.01): claude-opus-5-5 on 1");
  });

  it("refuses a run whose results haven't been collected", async () => {
    const dir = writeRun(root, "run");
    rmSync(join(dir, "results-opus.jsonl"));
    await expect(report(dir)).rejects.toThrow(
      `${dir} has no claude-opus-5-5 results yet: run collect first`,
    );
  });
});

describe("latestRunDir", () => {
  it("picks the newest run by its timestamped name", async () => {
    writeRun(root, "2026-09-01T00-00-00-000Z");
    const latest = writeRun(root, "2026-10-01T00-00-00-000Z");
    writeFileSync(join(root, "llm-trial", "notes.txt"), "not a run");
    expect(await latestRunDir()).toBe(latest);
  });

  it("throws when there are no runs", async () => {
    mkdirSync(join(root, "llm-trial"));
    await expect(latestRunDir()).rejects.toThrow(
      `no runs under ${join(root, "llm-trial")}; submit one first`,
    );
  });
});

describe("llm-trial main", () => {
  it("reports the latest run when no dir is given", async () => {
    writeRun(root, "2026-09-01T00-00-00-000Z");
    const latest = writeRun(root, "2026-10-01T00-00-00-000Z");
    expect(await main(["report"])).toBe(0);
    expect(logged()).toContain(`run ${latest}`);
  });

  it("reports the given run dir", async () => {
    const older = writeRun(root, "2026-09-01T00-00-00-000Z");
    writeRun(root, "2026-10-01T00-00-00-000Z");
    expect(await main(["report", older])).toBe(0);
    expect(logged()).toContain(`run ${older}`);
  });

  it("prints the usage, exiting 0 with no command and 1 for an unknown one", async () => {
    expect(await main([])).toBe(0);
    expect(await main(["review"])).toBe(1);
    expect(vi.mocked(console.log).mock.calls).toEqual([[USAGE], [USAGE]]);
  });

  it("exits 2 with the error when the command fails", async () => {
    const error = expectConsole("error");
    expect(await main(["report"])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
  });
});
