// The dump-import job's flags and env vars, and what it hands runDumpImport;
// the import itself is covered by server/dump-import*.test.ts.
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ImportStats, runDumpImport } from "../server/dump-import.ts";
import { expectConsole, quietLogs } from "../test/console.ts";

const m = vi.hoisted(() => ({
  runDumpImport: vi.fn<typeof runDumpImport>(),
  poolEnd: vi.fn<() => Promise<void>>(),
}));

vi.mock("../server/db.ts", () => ({ db: {}, pool: { end: m.poolEnd } }));
vi.mock("../server/dump-import.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/dump-import.ts")>()),
  runDumpImport: m.runDumpImport,
}));

const { main, parseConfig, parseShard, parseWorker, resolveDumpPath, UsageError } =
  await import("./import-dump.ts");
const { DEFAULT_DUMP_PATH, DEFAULT_SEGMENTS } = await import("../server/dump-import.ts");

const stats: ImportStats = {
  bytes: 2.5e9,
  lines: 1000,
  parsed: 300,
  matched: 250,
  unedited: 50,
  skipped: 0,
  properties: 12,
  stopped: false,
  seconds: 90,
  upserted: 200,
  unchanged: 20,
  externalIds: 900,
  failed: 0,
  lockRetries: 0,
  writeWaitSeconds: 30,
  segmentsScanned: 4,
  propertyRows: 12,
  pruned: 3,
  settled: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  m.runDumpImport.mockResolvedValue(stats);
  m.poolEnd.mockResolvedValue(undefined);
});
quietLogs();

/** Run main expecting a usage error (exit 2, no import); resolves to the one line it printed. */
async function usageError(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<unknown> {
  const error = expectConsole("error");
  expect(await main(argv, env)).toBe(2);
  expect(m.runDumpImport).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledOnce();
  const message: unknown = error.mock.lastCall?.[0];
  error.mockRestore();
  return message;
}

describe("parseShard", () => {
  it("defaults to the whole file", () => {
    expect(parseShard([])).toEqual({ index: 0, count: 1 });
  });

  it("reads i/N as a zero-based index", () => {
    expect(parseShard(["--shard", "3/8"])).toEqual({ index: 2, count: 8 });
    expect(parseShard(["--shard", "1/1"])).toEqual({ index: 0, count: 1 });
  });

  it.each(["0/4", "5/4", "1/0", "3", "a/b", "-1/4", ""])("rejects %j", (spec) => {
    expect(() => parseShard(["--shard", spec])).toThrow(
      new UsageError(`import-dump: --shard wants i/N with 1 <= i <= N, got "${spec}"`),
    );
  });

  it("rejects a missing spec", () => {
    expect(() => parseShard(["--shard"])).toThrow('got ""');
  });
});

describe("parseWorker", () => {
  const fallback = `${hostname()}-${process.pid}`;

  it("is undefined without the flag", () => {
    expect(parseWorker(["--shard", "1/2"])).toBeUndefined();
  });

  it("takes the name after the flag", () => {
    expect(parseWorker(["--worker", "import-dump-3"])).toBe("import-dump-3");
  });

  it("defaults to host-pid with no name, or with another flag next", () => {
    expect(parseWorker(["--worker"])).toBe(fallback);
    expect(parseWorker(["--worker", "--shard", "1/2"])).toBe(fallback);
  });

  it("caps the name at 64 characters", () => {
    expect(parseWorker(["--worker", "w".repeat(64)])).toBe("w".repeat(64));
    const long = "w".repeat(65);
    expect(() => parseWorker(["--worker", long])).toThrow(
      new UsageError(`import-dump: --worker name must be at most 64 characters, got "${long}"`),
    );
  });
});

describe("resolveDumpPath", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "import-dump-test-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("follows a symlink to the dated file", () => {
    const dated = join(dir, "wikidata-20260914-all.json.gz");
    writeFileSync(dated, "");
    const latest = join(dir, "latest-all.json.gz");
    symlinkSync(dated, latest);
    expect(resolveDumpPath(latest)).toBe(dated);
  });

  it("falls back to the configured path when it can't be resolved", () => {
    const missing = join(dir, "missing.json.gz");
    expect(resolveDumpPath(missing)).toBe(missing);
  });
});

describe("parseConfig options", () => {
  const options = (argv: string[], env: NodeJS.ProcessEnv = {}) => parseConfig(argv, env).options;

  it("reads the whole default dump, pruning, by default", () => {
    expect(options([])).toEqual({
      path: DEFAULT_DUMP_PATH,
      shard: { index: 0, count: 1 },
      limit: undefined,
      prune: undefined,
      forcePrune: false,
      full: false,
    });
  });

  it("passes a worker its name, segments and redo token instead of a shard", () => {
    expect(
      options(["--worker", "w1"], { DUMP_SEGMENTS: "128", DUMP_REDO: "2026-09-28" }),
    ).toMatchObject({ worker: "w1", segments: 128, redo: "2026-09-28" });
    const worker = options(["--worker", "w1"]);
    expect(worker).toMatchObject({ segments: DEFAULT_SEGMENTS, redo: undefined });
    expect(worker).not.toHaveProperty("shard");
  });

  it("reads the prune, force-prune, full and limit switches", () => {
    expect(
      options([], { DUMP_PRUNE: "0", DUMP_PRUNE_FORCE: "1", DUMP_FULL: "1", DUMP_LIMIT: "2000" }),
    ).toMatchObject({ prune: false, forcePrune: true, full: true, limit: 2000 });
    // Only the exact values switch them.
    expect(
      options([], { DUMP_PRUNE: "1", DUMP_PRUNE_FORCE: "yes", DUMP_FULL: "true" }),
    ).toMatchObject({ prune: undefined, forcePrune: false, full: false });
  });

  it("uses WIKIDATA_JSON_DUMP when set", () => {
    expect(options([], { WIKIDATA_JSON_DUMP: "/nowhere/dump.json" }).path).toBe(
      "/nowhere/dump.json",
    );
  });
});

describe("import-dump main", () => {
  it("rejects --worker with --shard", async () => {
    expect(await usageError(["--worker", "w1", "--shard", "1/2"])).toBe(
      "import-dump: --worker and --shard don't mix",
    );
  });

  it("rejects a bad --shard", async () => {
    expect(await usageError(["--shard", "9/2"])).toBe(
      'import-dump: --shard wants i/N with 1 <= i <= N, got "9/2"',
    );
  });

  it("rejects an over-long --worker name", async () => {
    const long = "w".repeat(65);
    expect(await usageError(["--worker", long])).toBe(
      `import-dump: --worker name must be at most 64 characters, got "${long}"`,
    );
  });

  it.each(["0", "-4", "1.5", "lots"])("rejects DUMP_SEGMENTS=%s", async (value) => {
    expect(await usageError(["--worker", "w1"], { DUMP_SEGMENTS: value })).toBe(
      `import-dump: DUMP_SEGMENTS must be a positive integer, got "${value}"`,
    );
  });

  it.each(["0", "-4", "1.5", "lots"])("rejects DUMP_LIMIT=%s", async (value) => {
    expect(await usageError([], { DUMP_LIMIT: value })).toBe(
      `import-dump: DUMP_LIMIT must be a positive integer, got "${value}"`,
    );
  });

  it("rejects DUMP_LIMIT on a worker", async () => {
    expect(await usageError(["--worker", "w1"], { DUMP_LIMIT: "10" })).toBe(
      "import-dump: DUMP_LIMIT is for a single run; use it without --worker",
    );
  });

  it("rejects DUMP_REDO over 32 characters, or without --worker", async () => {
    const message = "import-dump: DUMP_REDO is a token of at most 32 characters, for --worker runs";
    expect(await usageError(["--worker", "w1"], { DUMP_REDO: "r".repeat(33) })).toBe(message);
    expect(await usageError([], { DUMP_REDO: "2026-09-28" })).toBe(message);
    // 32 is fine, and an empty token is no token.
    expect(parseConfig(["--worker", "w1"], { DUMP_REDO: "r".repeat(32) }).options.redo).toBe(
      "r".repeat(32),
    );
    expect(parseConfig(["--worker", "w1"], { DUMP_REDO: "" }).options.redo).toBeUndefined();
    expect(parseConfig([], { DUMP_REDO: "" }).options.shard).toEqual({ index: 0, count: 1 });
  });

  it("logs the dump it reads, imports it, closes the pool and exits 0", async () => {
    const env = { WIKIDATA_JSON_DUMP: "/nowhere/dump.json", DUMP_LIMIT: "2000" };
    expect(await main(["--shard", "2/6"], env)).toBe(0);
    expect(m.runDumpImport).toHaveBeenCalledWith(parseConfig(["--shard", "2/6"], env).options);
    expect(vi.mocked(console.log).mock.calls).toEqual([
      ["import-dump: reading /nowhere/dump.json (shard 2/6) (limit 2000)"],
      [
        "import-dump: shard 2/6 done in 1.5 min (0.5 min waiting on writes) — 2.5 GB inflated, " +
          "1000 lines, 300 parsed, 250 matched (50 unedited), 200 items upserted (20 unchanged), " +
          "900 external ids, 12 properties, 3 pruned, 1 candidates settled",
      ],
    ]);
    expect(m.poolEnd).toHaveBeenCalledOnce();
  });

  it("names the worker, the resolved symlink, lock retries and skips in its log", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "import-dump-test-")));
    try {
      const dated = join(dir, "wikidata-20260914-all.json.gz");
      writeFileSync(dated, "");
      const latest = join(dir, "latest-all.json.gz");
      symlinkSync(dated, latest);
      m.runDumpImport.mockResolvedValue({
        ...stats,
        lockRetries: 2,
        skipped: 1,
        failed: 2,
        stopped: true,
      });
      expect(await main(["--worker", "w1"], { WIKIDATA_JSON_DUMP: latest })).toBe(0);
      expect(m.runDumpImport).toHaveBeenCalledWith(
        expect.objectContaining({ path: dated, worker: "w1" }),
      );
      const [[reading], [done]] = vi.mocked(console.log).mock.calls as [[string], [string]];
      expect(reading).toBe(
        `import-dump: reading ${latest} -> ${dated} (worker w1, ${DEFAULT_SEGMENTS} segments)`,
      );
      expect(done).toMatch(/^import-dump: worker w1 \(4 segments\) done in 1\.5 min /);
      expect(done).toContain("(0.5 min waiting on writes, 2 lock retries)");
      expect(done).toContain("1 bad lines + 2 failed items skipped, ");
      expect(done).toMatch(/ \(stopped at limit\)$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 when the import throws, closing the pool even if that fails too", async () => {
    const boom = new Error("boom");
    m.runDumpImport.mockRejectedValue(boom);
    m.poolEnd.mockRejectedValue(new Error("already closed"));
    const error = expectConsole("error");
    expect(await main([], {})).toBe(1);
    expect(error).toHaveBeenCalledWith("import-dump: failed", boom);
    expect(m.poolEnd).toHaveBeenCalledOnce();
  });
});
