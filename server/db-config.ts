// Shared MariaDB connection settings, read from the environment. Kept separate
// from `server/db.ts` so batch jobs (the hunt) can open their own dedicated
// connection from this config without importing — and thus spinning up — the
// web server's connection pool.
import "dotenv/config";
import type { ConnectionOptions } from "mysql2/promise";

/**
 * Build a mysql2 connection config from env. Defaults target a local dev DB
 * (Homebrew MariaDB, db/user `mergers`). In production these come from the
 * Toolforge tool's ToolsDB credentials.
 *
 * `dateStrings: true` returns DATETIME/TIMESTAMP columns as strings (MySQL's
 * `YYYY-MM-DD HH:MM:SS`), which the wire types (`detectedAt: string`) and the
 * client's `.slice(0, 10)` date formatting both expect.
 *
 * `charset: "utf8mb4"` so non-BMP characters in labels/descriptions round-trip.
 */
export function connConfig(): ConnectionOptions {
  return {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? "mergers",
    password: process.env.DB_PASSWORD ?? "mergers",
    database: process.env.DB_NAME ?? "mergers",
    dateStrings: true,
    charset: "utf8mb4",
    // ToolsDB terminates idle connections; keep the pool honest.
    enableKeepAlive: true,
  };
}
