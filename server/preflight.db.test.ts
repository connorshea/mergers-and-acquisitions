// The boot-time schema check (server/preflight.ts) against a real, migrated
// MariaDB: the journal count must agree with what the migrator recorded.
// Opt-in via DB_TEST=1 — see test/global-setup.ts.
import { afterAll, describe, expect, it } from "vite-plus/test";
import { pool } from "./db.ts";
import { appliedMigrations, expectedMigrations, runPreflight } from "./preflight.ts";
import { DB_TEST } from "../test/db-helpers.ts";

describe.skipIf(!DB_TEST)("preflight against the migrated test database", () => {
  afterAll(() => pool.end());

  it("finds every journal entry applied", async () => {
    const expected = await expectedMigrations();
    expect(expected).toBeGreaterThan(0);
    await expect(appliedMigrations()).resolves.toBe(expected);
    await expect(runPreflight({ expectedMigrations, appliedMigrations })).resolves.toEqual({
      status: "ok",
      applied: expected,
      expected,
    });
  });
});
