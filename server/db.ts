// The web server's Drizzle handle, backed by a mysql2 connection pool. Route
// handlers and the sync modules import `db` from here. Batch jobs that need
// session-level settings (the hunt's `group_concat_max_len`) open their own
// dedicated connection instead — see server/hunt.ts.
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import * as schema from "../db/schema.ts";
import { connConfig } from "./db-config.ts";

export const pool = mysql.createPool({
  ...connConfig(),
  connectionLimit: Number(process.env.DB_POOL ?? 5),
  waitForConnections: true,
});

export const db = drizzle(pool, { schema, mode: "default" });

export { schema };
