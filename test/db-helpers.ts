// Shared helpers for the DB-backed tests (`*.db.test.ts`). See
// test/global-setup.ts for how the database is selected and migrated.
import { sql } from "drizzle-orm";
import { db } from "../server/db.ts";
import { externalIds, items, sessions, users } from "../db/schema.ts";
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from "../server/auth/session.ts";
import { randomToken, sha256Hex } from "../server/auth/crypto.ts";
import { addSeconds, toSqlDatetime } from "../server/auth/time.ts";
import type { Item, Value } from "../src/lib/compare.ts";
import { externalIdRows, primaryLabel, primaryType } from "../src/lib/wikidata.ts";

/** True when the DB tests should run; use with `describe.skipIf(!DB_TEST)`. */
export const DB_TEST = process.env.DB_TEST === "1";

const TABLES = [
  "merge_candidates",
  "external_ids",
  "items",
  "properties",
  "entity_labels",
  "item_descriptions",
  "sync_state",
];

// The auth tables are linked by foreign keys, which MariaDB refuses to
// TRUNCATE through; DELETE them children-first instead.
const FK_TABLES = ["wikidata_edits", "sessions", "oauth_tokens", "users"];

/** Empty every application table (not the migrations journal). */
export async function truncateAll(): Promise<void> {
  for (const table of TABLES) {
    await db.execute(sql.raw(`TRUNCATE TABLE \`${table}\``));
  }
  for (const table of FK_TABLES) {
    await db.execute(sql.raw(`DELETE FROM \`${table}\``));
  }
}

/**
 * Create a user (if needed) and a live session for them, returning the headers
 * a logged-in same-origin request needs. Admin status comes from ADMIN_USERS
 * at request time, so tests set that env var themselves.
 */
export async function loginAs(
  userId: number,
  username = `User${userId}`,
): Promise<Record<string, string>> {
  const now = new Date();
  await db
    .insert(users)
    .values({ id: userId, username, groups: ["user"] })
    .onDuplicateKeyUpdate({ set: { username } });
  const token = randomToken(32);
  await db.insert(sessions).values({
    id: sha256Hex(token),
    userId,
    lastSeenAt: toSqlDatetime(now),
    expiresAt: toSqlDatetime(addSeconds(now, SESSION_TTL_SECONDS)),
  });
  return { ...SAME_ORIGIN, Cookie: `${SESSION_COOKIE}=${token}` };
}

/** Headers that satisfy the same-origin check on state-changing requests. */
export const SAME_ORIGIN: Record<string, string> = { "Sec-Fetch-Site": "same-origin" };

/**
 * Build a minimal video-game `Item`. Every item is P31 = Q7889 (video game)
 * unless `statements` overrides P31, and has an English label.
 */
export function makeItem(
  id: string,
  label: string,
  statements: Record<string, Value[]> = {},
  extra: Partial<Omit<Item, "id" | "statements">> = {},
): Item {
  return {
    id,
    labels: { en: label },
    descriptions: {},
    aliases: {},
    sitelinks: {},
    ...extra,
    statements: {
      P31: [{ type: "item", value: "Q7889", label: "video game" }],
      ...statements,
    },
  };
}

/**
 * Insert an item the way the seed/import scripts do: the `items` row with its
 * denormalized label/type, plus one `external_ids` row per external-id value.
 */
export async function insertItem(item: Item): Promise<void> {
  await db.insert(items).values({
    qid: item.id,
    primaryLabel: primaryLabel(item) ?? null,
    primaryType: primaryType(item) ?? null,
    data: item,
  });
  const rows = externalIdRows(item).map((r) => ({ qid: item.id, ...r }));
  if (rows.length > 0) await db.insert(externalIds).values(rows);
}
