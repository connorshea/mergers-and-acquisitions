// The monthly Claude review job's command dispatch; runStage and collect are
// covered by server/llm-review-job.db.test.ts.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { expectConsole, quietLogs } from "../test/console.ts";
import type { collect, runStage } from "../server/llm-review-job.ts";

const m = vi.hoisted(() => ({
  runStage: vi.fn<typeof runStage>(),
  collect: vi.fn<typeof collect>(),
  poolEnd: vi.fn<() => Promise<void>>(),
  api: { fake: "api" },
  db: { fake: "db" },
}));

vi.mock("../server/db.ts", () => ({ db: m.db, pool: { end: m.poolEnd } }));
vi.mock("../server/llm-review-job.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/llm-review-job.ts")>()),
  runStage: m.runStage,
  collect: m.collect,
  anthropicApi: () => m.api,
}));

const { main } = await import("./llm-review.ts");
const { configFromEnv } = await import("../server/llm-review-job.ts");

const USAGE =
  "usage: node jobs/llm-review.ts first-pass | confirm | collect [--wait] [--max-pairs N]";
const env = {};
const config = configFromEnv(env);

beforeEach(() => {
  vi.resetAllMocks();
  m.poolEnd.mockResolvedValue(undefined);
});
quietLogs();

describe("llm-review main", () => {
  it.each([
    ["first-pass", "first_pass"],
    ["confirm", "confirmation"],
  ])("%s runs the %s stage", async (command, stage) => {
    expect(await main([command], env)).toBe(0);
    expect(m.runStage).toHaveBeenCalledWith(m.db, m.api, config, stage, { wait: false });
    expect(m.collect).not.toHaveBeenCalled();
    expect(m.poolEnd).toHaveBeenCalledOnce();
  });

  it("collect collects", async () => {
    expect(await main(["collect"], env)).toBe(0);
    expect(m.collect).toHaveBeenCalledWith(m.db, m.api, config, { wait: false });
    expect(m.runStage).not.toHaveBeenCalled();
  });

  it("passes --wait through", async () => {
    await main(["collect", "--wait"], env);
    expect(m.collect).toHaveBeenCalledWith(m.db, m.api, config, { wait: true });
    await main(["confirm", "--wait"], env);
    expect(m.runStage).toHaveBeenCalledWith(m.db, m.api, config, "confirmation", { wait: true });
  });

  it("reads the config from the env, and --max-pairs overrides its pair cap", async () => {
    await main(["first-pass", "--max-pairs", "25"], { LLM_MONTHLY_BUDGET_USD: "5" });
    expect(m.runStage).toHaveBeenCalledWith(
      m.db,
      m.api,
      { ...config, budgetUsd: 5, maxPairs: 25 },
      "first_pass",
      { wait: false },
    );
  });

  it.each([["x"], ["-1"], ["1.5"], [undefined]])(
    "rejects --max-pairs %s with exit 1",
    async (value) => {
      const error = expectConsole("error");
      const argv = ["first-pass", "--max-pairs", ...(value === undefined ? [] : [value])];
      expect(await main(argv, env)).toBe(1);
      expect(error).toHaveBeenCalledWith(
        "llm-review: failed",
        new Error("--max-pairs must be a count"),
      );
      expect(m.runStage).not.toHaveBeenCalled();
      expect(m.poolEnd).toHaveBeenCalledOnce();
    },
  );

  it("prints the usage and exits 0 with no command", async () => {
    expect(await main([], env)).toBe(0);
    expect(console.log).toHaveBeenCalledWith(USAGE);
    expect(m.poolEnd).toHaveBeenCalledOnce();
  });

  it("prints the usage and exits 1 for an unknown command", async () => {
    expect(await main(["review"], env)).toBe(1);
    expect(console.log).toHaveBeenCalledWith(USAGE);
  });

  it("exits 1 and still closes the pool when the stage throws", async () => {
    const boom = new Error("boom");
    m.runStage.mockRejectedValue(boom);
    const error = expectConsole("error");
    expect(await main(["first-pass"], env)).toBe(1);
    expect(error).toHaveBeenCalledWith("llm-review: failed", boom);
    expect(m.poolEnd).toHaveBeenCalledOnce();
  });
});
