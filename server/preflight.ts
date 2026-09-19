// Boot-time schema check for the web server: refuse to serve against a database
// whose migrations are missing or behind, so a stale schema fails at startup
// with an actionable message instead of deep inside the first request handler
// (`Table 'mergers.users' doesn't exist`).
//
// The check compares the number of rows in Drizzle's `__drizzle_migrations`
// journal table with the entries in db/migrations/meta/_journal.json. Counting
// avoids re-implementing the migrator's file hashing, and is exact because the
// migrator inserts one row per applied migration and the journal only grows.
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "./db.ts";

/** The journal drizzle-kit maintains; resolved from this file, not the cwd. */
const JOURNAL_URL = new URL("../db/migrations/meta/_journal.json", import.meta.url);

/** The table the drizzle migrator records applied migrations in (its default name). */
const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * How many times to try reaching the database before giving up. A DB that is
 * still coming up when the pod starts should not fail the boot outright, but a
 * bounded wait keeps the process from hanging forever on a dead host — exit
 * instead, and let the supervisor (Kubernetes on Toolforge) restart it.
 */
export const CONNECT_ATTEMPTS = 3;
export const CONNECT_RETRY_DELAY_MS = 2_000;

export type PreflightResult =
  /** Every journal entry has been applied. */
  | { status: "ok"; applied: number; expected: number }
  /** The database is reachable but at least one migration has not been applied. */
  | { status: "pending"; applied: number; expected: number }
  /** The database could not be queried after `attempts` tries. */
  | { status: "unavailable"; attempts: number; error: unknown };

/** The pieces of `runPreflight` that touch the filesystem or the database. */
export interface PreflightDeps {
  /** Number of migrations the checked-in journal expects. */
  expectedMigrations: () => Promise<number>;
  /** Number of migrations recorded as applied; 0 on a fresh database. */
  appliedMigrations: () => Promise<number>;
  attempts?: number;
  retryDelayMs?: number;
  warn?: (message: string) => void;
}

/** Count the entries in db/migrations/meta/_journal.json. */
export async function expectedMigrations(): Promise<number> {
  const journal = JSON.parse(await readFile(JOURNAL_URL, "utf8")) as {
    entries?: unknown[];
  };
  if (!Array.isArray(journal.entries)) {
    throw new Error(`${JOURNAL_URL.pathname} has no "entries" array`);
  }
  return journal.entries.length;
}

/**
 * Count the rows in the migrator's journal table. A missing table means the
 * migrator has never run against this database (fresh DB): zero applied.
 */
export async function appliedMigrations(): Promise<number> {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `select count(*) as n from \`${MIGRATIONS_TABLE}\``,
    );
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    if (errorCode(err) === "ER_NO_SUCH_TABLE") return 0;
    throw err;
  }
}

/** The mysql2 error code (`ECONNREFUSED`, `ER_NO_SUCH_TABLE`, …), if any. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Compare the journal with the database, retrying while the database cannot be
 * queried. Never exits; `preflight()` turns the result into a log line + exit.
 */
export async function runPreflight({
  expectedMigrations: expected,
  appliedMigrations: applied,
  attempts = CONNECT_ATTEMPTS,
  retryDelayMs = CONNECT_RETRY_DELAY_MS,
  warn = (message) => console.warn(message),
}: PreflightDeps): Promise<PreflightResult> {
  const want = await expected();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let have: number;
    try {
      have = await applied();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        warn(
          `preflight: database not reachable (attempt ${attempt}/${attempts}): ` +
            `${describeError(err)}; retrying in ${retryDelayMs}ms`,
        );
        await sleep(retryDelayMs);
      }
      continue;
    }
    if (have < want) return { status: "pending", applied: have, expected: want };
    if (have > want) {
      // The database is ahead of this code (a rolled-back deploy). Older code
      // against a newer schema usually works, so serve, but say so.
      warn(
        `preflight: database has ${have} migrations applied but this build only ` +
          `knows ${want}; is the deploy older than the schema?`,
      );
    }
    return { status: "ok", applied: have, expected: want };
  }
  return { status: "unavailable", attempts, error: lastError };
}

/** A one-line rendering of an error for log output. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = errorCode(err);
    return code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

/** The operator-facing message for each failing preflight outcome. */
export function failureMessage(result: Exclude<PreflightResult, { status: "ok" }>): string {
  switch (result.status) {
    case "pending":
      return (
        `DB schema is behind: ${result.expected} migrations in db/migrations, ` +
        `${result.applied} applied.\n` +
        "Run `pnpm db:migrate` (locally) or the migrate job (Toolforge) before starting."
      );
    case "unavailable":
      return (
        `DB not reachable after ${result.attempts} attempts: ${describeError(result.error)}\n` +
        "Check the DB_* env vars and that the database is up; exiting so the supervisor can retry."
      );
  }
}

/**
 * Verify the schema is current before the server binds its port. Logs the
 * outcome and exits the process with status 1 on any failure: a pending
 * migration is an operator error that a restart will not fix, and an
 * unreachable database has already been retried.
 */
export async function preflight(): Promise<void> {
  const result = await runPreflight({ expectedMigrations, appliedMigrations });
  if (result.status === "ok") {
    console.log(`preflight: schema is current (${result.applied} migrations applied)`);
    return;
  }
  console.error(failureMessage(result));
  process.exit(1);
}
