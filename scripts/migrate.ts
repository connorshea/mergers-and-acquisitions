// Apply pending Drizzle migrations to the configured database. Run locally with
// `pnpm db:migrate`, and on Toolforge as a one-off job before/after deploys.
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { connConfig } from "../server/db-config";

async function main() {
  const conn = await mysql.createConnection({ ...connConfig(), multipleStatements: true });
  const db = drizzle(conn);
  await migrate(db, { migrationsFolder: "db/migrations" });
  await conn.end();
  console.log("migrations applied");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("migrate failed", err);
    process.exit(1);
  });
