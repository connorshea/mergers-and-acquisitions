// Unit tests for the boot-time schema check (server/preflight.ts) with the
// journal and the database replaced by stubs; the DB-backed half is in
// server/preflight.db.test.ts.
import { describe, expect, it, vi } from "vite-plus/test";
import { describeError, failureMessage, runPreflight } from "./preflight.ts";

const noRetryDelay = { retryDelayMs: 0 };

describe("runPreflight", () => {
  it("is ok when every journal entry has been applied", async () => {
    const warn = vi.fn<(message: string) => void>();
    const result = await runPreflight({
      expectedMigrations: async () => 4,
      appliedMigrations: async () => 4,
      warn,
    });
    expect(result).toEqual({ status: "ok", applied: 4, expected: 4 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports pending migrations when the database is behind", async () => {
    const result = await runPreflight({
      expectedMigrations: async () => 4,
      appliedMigrations: async () => 3,
    });
    expect(result).toEqual({ status: "pending", applied: 3, expected: 4 });
  });

  it("treats a fresh database (nothing applied) as pending", async () => {
    const result = await runPreflight({
      expectedMigrations: async () => 4,
      appliedMigrations: async () => 0,
    });
    expect(result).toEqual({ status: "pending", applied: 0, expected: 4 });
  });

  it("serves, with a warning, when the database is ahead of the code", async () => {
    const warn = vi.fn<(message: string) => void>();
    const result = await runPreflight({
      expectedMigrations: async () => 4,
      appliedMigrations: async () => 5,
      warn,
    });
    expect(result).toEqual({ status: "ok", applied: 5, expected: 4 });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/5 migrations applied .* 4/);
  });

  it("does not retry a pending schema", async () => {
    const applied = vi.fn<() => Promise<number>>(async () => 1);
    await runPreflight({
      expectedMigrations: async () => 4,
      appliedMigrations: applied,
      attempts: 3,
      ...noRetryDelay,
    });
    expect(applied).toHaveBeenCalledOnce();
  });

  it("retries while the database cannot be queried, then succeeds", async () => {
    const warn = vi.fn<(message: string) => void>();
    const applied = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(
        Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      )
      .mockResolvedValueOnce(4);
    const result = await runPreflight({
      expectedMigrations: async () => 4,
      appliedMigrations: applied,
      attempts: 3,
      warn,
      ...noRetryDelay,
    });
    expect(result).toEqual({ status: "ok", applied: 4, expected: 4 });
    expect(applied).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("attempt 1/3");
    expect(warn.mock.calls[1][0]).toContain("attempt 2/3");
  });

  it("gives up after the last attempt with the final error", async () => {
    const last = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const applied = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(last);
    const warn = vi.fn<(message: string) => void>();
    const result = await runPreflight({
      expectedMigrations: async () => 4,
      appliedMigrations: applied,
      attempts: 2,
      warn,
      ...noRetryDelay,
    });
    expect(result).toEqual({ status: "unavailable", attempts: 2, error: last });
    expect(applied).toHaveBeenCalledTimes(2);
    // No "retrying" warning after the final attempt.
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("failureMessage", () => {
  it("tells the operator how many migrations are pending and how to apply them", () => {
    expect(failureMessage({ status: "pending", applied: 1, expected: 4 })).toBe(
      "DB schema is behind: 4 migrations in db/migrations, 1 applied.\n" +
        "Run `pnpm db:migrate` (locally) or the migrate job (Toolforge) before starting.",
    );
  });

  it("names the connection error when the database is unreachable", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), {
      code: "ECONNREFUSED",
    });
    const message = failureMessage({ status: "unavailable", attempts: 3, error });
    expect(message).toContain(
      "DB not reachable after 3 attempts: connect ECONNREFUSED 127.0.0.1:3306",
    );
    expect(message).toContain("DB_* env vars");
  });
});

describe("describeError", () => {
  it("appends the mysql2 code when the message does not already carry it", () => {
    const err = Object.assign(new Error("Access denied for user 'mergers'@'%'"), {
      code: "ER_ACCESS_DENIED_ERROR",
    });
    expect(describeError(err)).toBe(
      "Access denied for user 'mergers'@'%' (ER_ACCESS_DENIED_ERROR)",
    );
  });

  it("does not repeat a code the message already contains", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(describeError(err)).toBe("connect ECONNREFUSED");
  });

  it("stringifies non-Error values", () => {
    expect(describeError("boom")).toBe("boom");
  });
});
