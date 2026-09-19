// Vitest global setup for the DB-backed tests (`*.db.test.ts`). Runs once per
// `vp test` invocation, before any test file.
//
// The DB tests are opt-in: they only run when DB_TEST=1, because they need a
// reachable MariaDB and they TRUNCATE every table between tests. As a guard
// against pointing them at a real dev/prod database, the database name must
// contain "test" (e.g. `test_mergers` locally, `mergers_test` in CI).
//
// When enabled, this applies the checked-in migrations to that database so the
// tests always run against the exact schema a deploy would produce.
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { connConfig } from "../server/db-config.ts";

export default async function setup(): Promise<void> {
  if (process.env.DB_TEST !== "1") return;

  const config = connConfig();
  if (!/test/i.test(config.database ?? "")) {
    throw new Error(
      `DB_TEST=1 but DB_NAME="${config.database}" does not contain "test". ` +
        "The DB tests truncate every table; point DB_NAME at a dedicated test database.",
    );
  }

  const conn = await mysql.createConnection({ ...config, multipleStatements: true });
  try {
    await migrate(drizzle(conn), { migrationsFolder: "db/migrations" });
  } finally {
    await conn.end();
  }
}
