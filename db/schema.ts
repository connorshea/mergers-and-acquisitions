import {
  bigint,
  boolean,
  customType,
  datetime,
  double,
  index,
  int,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";

// JSON column that (de)serializes in the ORM layer rather than relying on the
// driver. MariaDB implements `JSON` as `LONGTEXT` + a `json_valid` CHECK and,
// unlike MySQL 8, mysql2 hands JSON columns back as *strings*. Parsing here (and
// tolerating an already-parsed object, in case a driver does parse) makes reads
// return real objects on both MariaDB and MySQL. `dataType() = "json"` keeps
// MariaDB's validation. Replaces SQLite's `text(..., { mode: "json" })`.
const json = <T>(name: string) =>
  customType<{ data: T; driverData: string }>({
    dataType() {
      return "json";
    },
    toDriver(value: T): string {
      return JSON.stringify(value);
    },
    fromDriver(value: unknown): T {
      return typeof value === "string" ? (JSON.parse(value) as T) : (value as T);
    },
  })(name);

// One row per synced Wikidata item. `data` holds the mapped `Item` (from
// src/lib/compare.ts) as JSON so the comparison UI and scorer can consume it
// without a second round-trip. `primaryLabel` / `primaryType` are denormalized
// out of `data` for cheap search, filtering, and blocking.
export const items = mysqlTable(
  "items",
  {
    qid: varchar("qid", { length: 32 }).primaryKey(), // e.g. "Q42"
    primaryLabel: varchar("primary_label", { length: 255 }), // Item.labels.en ?? mul, nullable
    primaryType: varchar("primary_type", { length: 32 }), // first P31 value QID, e.g. "Q7889"
    data: json<import("../src/lib/compare.ts").Item>("data").notNull(), // JSON-encoded Item
    lastSyncedAt: datetime("last_synced_at", { mode: "string" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("idx_items_primary_label").on(t.primaryLabel),
    index("idx_items_primary_type").on(t.primaryType),
  ],
);

// External identifiers pulled out of each item's statements. `(property, value)`
// is the blocking key the hunt job groups on to find shared-ID duplicates
// without an O(n²) scan. Rebuilt wholesale for an item on each sync.
export const externalIds = mysqlTable(
  "external_ids",
  {
    id: int("id").autoincrement().primaryKey(),
    qid: varchar("qid", { length: 32 }).notNull(),
    property: varchar("property", { length: 16 }).notNull(), // e.g. "P1733" (Steam application ID)
    // 512 (not 255): some Wikidata identifiers are long slug-style titles that
    // overflow 255 (MariaDB strict mode rejects with ER_DATA_TOO_LONG). Stays
    // well under the 3072-byte index limit in idx_external_ids_unique.
    value: varchar("value", { length: 512 }).notNull(),
  },
  (t) => [
    index("idx_external_ids_property_value").on(t.property, t.value),
    index("idx_external_ids_qid").on(t.qid),
    uniqueIndex("idx_external_ids_unique").on(t.qid, t.property, t.value),
  ],
);

// A scored, ordered pair of items that may be duplicates. The pair is stored
// ordered by `orderByAge` (higher QID = `fromQid`, merged into the lower
// `intoQid`), so `(fromQid, intoQid)` is unique per candidate.
export const mergeCandidates = mysqlTable(
  "merge_candidates",
  {
    id: int("id").autoincrement().primaryKey(),
    fromQid: varchar("from_qid", { length: 32 }).notNull(),
    intoQid: varchar("into_qid", { length: 32 }).notNull(),
    confidence: double("confidence").notNull(),
    // open | merging | dismissed | merged. `merging` is the short-lived claim an
    // edit request (merge or "different from") takes via an optimistic
    // UPDATE … WHERE status = 'open', so two submits can't both reach Wikidata;
    // it reverts to `open` on failure.
    status: varchar("status", { length: 16 }).notNull().default("open"),
    reasons: json<string[]>("reasons").notNull(), // string[]
    hasBlocker: boolean("has_blocker").notNull().default(false),
    detectedAt: datetime("detected_at", { mode: "string" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    resolvedAt: datetime("resolved_at", { mode: "string" }),
    resolution: varchar("resolution", { length: 255 }), // free-form note on how it was resolved
    // The user (central id) who resolved it, when a logged-in action did. No
    // foreign key: the row is history and must survive whatever happens to
    // the users table.
    resolvedBy: int("resolved_by"),
  },
  (t) => [
    uniqueIndex("idx_merge_candidates_pair").on(t.fromQid, t.intoQid),
    index("idx_merge_candidates_status_confidence").on(t.status, t.confidence),
  ],
);

// Human-readable labels for Wikidata properties, synced wholesale from Wikidata
// (see jobs/sync-properties.ts). Lets the UI show "Steam application ID"
// instead of a bare "P1733" without hard-coding a map. `datatype` is Wikidata's
// property type (e.g. "ExternalId", "WikibaseItem").
export const properties = mysqlTable("properties", {
  pid: varchar("pid", { length: 16 }).primaryKey(), // e.g. "P1733"
  label: varchar("label", { length: 255 }).notNull(), // English label, e.g. "Steam application ID"
  datatype: varchar("datatype", { length: 64 }), // Wikidata property type, nullable
  // Wikidata formatter URL (P1630) with "$1" as the value placeholder, e.g.
  // "https://store.steampowered.com/app/$1/". Lets the UI turn an external-id
  // value into a link. The preferred-rank value is used when several exist.
  formatterUrl: varchar("formatter_url", { length: 2048 }), // nullable — most non-identifier props have none
  // True when the property is instance of (P31) "Wikidata property for authority
  // control, with reciprocal use of Wikidata" (Q24075706): the external service
  // sources its ids *from* Wikidata, so each Wikidata item gets its own id. A
  // shared value is circular and a differing value is not evidence of distinct
  // subjects. Synced from Wikidata; the hunt feeds this into scoreCandidate so
  // such ids count neither for a match nor against one (see MIRRORED_ID_PROPS).
  mirrorsWikidata: boolean("mirrors_wikidata").notNull().default(false),
  syncedAt: datetime("synced_at", { mode: "string" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// Human-readable labels for Wikidata *items* that appear as statement values
// (genre, platform, developer, instance of, …), synced from Wikidata (see
// jobs/sync-entity-labels.ts). Lets the comparison view show "role-playing
// video game" instead of a bare "Q744038". Populated from the set of item
// values actually referenced by in-scope games, so it stays far smaller than
// all of Wikidata.
export const entityLabels = mysqlTable("entity_labels", {
  qid: varchar("qid", { length: 32 }).primaryKey(), // e.g. "Q744038"
  label: varchar("label", { length: 512 }).notNull(), // English label, e.g. "role-playing video game"
  syncedAt: datetime("synced_at", { mode: "string" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// Cursor bookkeeping for the paged Wikidata sync. One row per scope (e.g. the
// video-game population); `cursor` is the SPARQL OFFSET reached so far.
export const syncState = mysqlTable("sync_state", {
  scope: varchar("scope", { length: 64 }).primaryKey(), // e.g. "video-games"
  cursor: int("cursor").notNull().default(0),
  lastRunAt: datetime("last_run_at", { mode: "string" }),
});

// ---------------------------------------------------------------------------
// Authentication (Wikimedia OAuth 2.0) — see server/auth/.
// ---------------------------------------------------------------------------

// One row per Wikimedia account that has logged in. Keyed on the *central*
// (SUL) user id from the OAuth profile endpoint's `sub`, never the username —
// accounts get renamed, ids don't. `groups`/`blocked` are a snapshot from the
// last login, kept for display and gating (Wikidata enforces the real rights on
// every edit regardless).
export const users = mysqlTable("users", {
  id: int("id").primaryKey(), // Wikimedia central user id (OAuth profile `sub`)
  username: varchar("username", { length: 255 }).notNull(),
  groups: json<string[]>("groups").notNull(), // e.g. ["*", "user", "autoconfirmed"]
  blocked: boolean("blocked").notNull().default(false),
  createdAt: datetime("created_at", { mode: "string" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  lastLoginAt: datetime("last_login_at", { mode: "string" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// Server-side sessions. The browser cookie holds a random 256-bit token; this
// table stores only its SHA-256, so a leaked ToolsDB dump does not yield live
// sessions. `expiresAt` is the absolute lifetime; the idle timeout is enforced
// against `lastSeenAt` in server/auth/session.ts.
export const sessions = mysqlTable(
  "sessions",
  {
    id: varchar("id", { length: 64 }).primaryKey(), // hex SHA-256 of the cookie token
    userId: int("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: datetime("created_at", { mode: "string" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: datetime("last_seen_at", { mode: "string" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    expiresAt: datetime("expires_at", { mode: "string" }).notNull(),
  },
  (t) => [
    index("idx_sessions_user_id").on(t.userId),
    index("idx_sessions_expires_at").on(t.expiresAt),
  ],
);

// The user's OAuth access/refresh tokens, one row per user. Both are encrypted
// at rest (AES-256-GCM, key from the environment — see server/auth/crypto.ts)
// because ToolsDB is a shared server. They never leave the server process.
export const oauthTokens = mysqlTable("oauth_tokens", {
  userId: int("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(), // encrypted
  refreshToken: text("refresh_token"), // encrypted; null if the provider issued none
  accessExpiresAt: datetime("access_expires_at", { mode: "string" }).notNull(),
  updatedAt: datetime("updated_at", { mode: "string" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// ---------------------------------------------------------------------------
// Wikidata edits made through the app — see server/wikidata-client.ts.
// ---------------------------------------------------------------------------

// One row per edit *attempt* against Wikidata (a merge, or one direction of a
// "different from" claim), success or failure, so there is an audit trail of
// what the tool did under whose account and which revisions it produced.
// `candidateId` is not a foreign key: /api/reset deletes candidates and the
// history should outlive that. Revision ids are bigint — Wikidata's are past
// 2^31 already.
export const wikidataEdits = mysqlTable(
  "wikidata_edits",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("user_id")
      .notNull()
      .references(() => users.id),
    candidateId: int("candidate_id"),
    action: varchar("action", { length: 32 }).notNull(), // "merge" | "different-from"
    fromQid: varchar("from_qid", { length: 32 }).notNull(), // merge: merged away; claim: the item edited
    intoQid: varchar("into_qid", { length: 32 }).notNull(), // merge: survivor; claim: the value pointed at
    params: json<Record<string, unknown>>("params"), // e.g. { ignoreConflicts: ["description"] }
    ok: boolean("ok").notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    errorText: text("error_text"),
    fromRevid: bigint("from_revid", { mode: "number" }),
    intoRevid: bigint("into_revid", { mode: "number" }),
    // wbmergeitems only redirects the source when the merge emptied it; with
    // ignored sitelink conflicts it can survive as a stub (null for claims).
    redirected: boolean("redirected"),
    createdAt: datetime("created_at", { mode: "string" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("idx_wikidata_edits_user_id").on(t.userId),
    index("idx_wikidata_edits_candidate_id").on(t.candidateId),
  ],
);
