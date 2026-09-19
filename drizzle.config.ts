import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// MariaDB uses Drizzle's MySQL dialect (there is no `mariadb` dialect). Credentials
// come from the same env vars the app uses; only `generate` runs offline, but
// `migrate`/`push`/`studio` need a reachable DB.
export default defineConfig({
  dialect: "mysql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  // Name migrations with a UTC `YYYYMMDDHHMMSS` timestamp prefix instead of the
  // default sequential `0000` index, so tags sort chronologically and don't
  // collide when generated on separate branches.
  migrations: { prefix: "timestamp" },
  dbCredentials: {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "mergers",
    password: process.env.DB_PASSWORD ?? "mergers",
    database: process.env.DB_NAME ?? "mergers",
  },
});
