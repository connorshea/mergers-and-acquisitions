import {
  bigint,
  boolean,
  customType,
  datetime,
  double,
  index,
  int,
  mediumtext,
  mysqlTable,
  primaryKey,
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
    // storedBlockingKey(primaryLabel) (src/lib/compare.ts), so the hunt can
    // group items by label+type in SQL instead of loading every label into
    // memory. Written with primaryLabel by the dump import; a row whose key is
    // missing (older rows, or other writers) is filled in by the hunt before it
    // scans. Null when primaryLabel is.
    blockingKey: varchar("blocking_key", { length: 255 }),
    data: json<import("../src/lib/compare.ts").Item>("data").notNull(), // JSON-encoded Item
    lastSyncedAt: datetime("last_synced_at", { mode: "string" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    // The dump this row was last seen in (e.g. "20260914"), stamped by the dump
    // import. Lets the prune of a sharded import work across jobs: once every
    // shard of a dump has finished, rows not stamped with it have left the dump.
    lastDump: varchar("last_dump", { length: 32 }),
    // SHA-1 (hex) of everything the dump import wrote for this row (see
    // server/dump-import.ts `itemHash`), so a re-import can skip an item whose
    // converted data hasn't changed. Null when something else rewrote `data`,
    // which makes the next import write the item in full.
    dataHash: varchar("data_hash", { length: 40 }),
    // The Wikidata revision `data` was converted from, and the converter
    // version that converted it (server/converter-version.ts). When the dump
    // has the same revision and the version is still current, the dump import
    // skips the item without parsing it. Null when the revision isn't known
    // (the single-item importer without one, or a local edit to `data`).
    sourceRevid: bigint("source_revid", { mode: "number", unsigned: true }),
    converterVersion: int("converter_version", { unsigned: true }),
  },
  (t) => [
    index("idx_items_primary_label").on(t.primaryLabel),
    index("idx_items_primary_type").on(t.primaryType),
    // The hunt's label+type blocking: GROUP BY (blocking_key, primary_type) →
    // group_concat(qid), answered from this index alone; also finds the rows
    // whose key is still null.
    index("idx_items_blocking").on(t.blockingKey, t.primaryType, t.qid),
    // The dump import's prune looks for rows not stamped with the current dump;
    // nearly every row is, so this turns a full scan into a short range read.
    index("idx_items_last_dump").on(t.lastDump),
    // Covers the dump import's revision index load: a keyset over qid within
    // one converter version, read from the index alone rather than the rows
    // (which carry the JSON).
    index("idx_items_revision").on(t.converterVersion, t.qid, t.sourceRevid, t.primaryType),
  ],
);

// External identifiers pulled out of each item's statements. `(property, value)`
// is the blocking key the hunt job groups on to find shared-ID duplicates
// without an O(n²) scan. Brought in line with the item on each sync.
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
    // `qid` is included so the hunt's GROUP BY (property, value) →
    // group_concat(qid) is answered from the index alone; without it every one
    // of the ~2M rows costs a primary-key lookup (~10x slower).
    index("idx_external_ids_property_value_qid").on(t.property, t.value, t.qid),
    index("idx_external_ids_qid").on(t.qid),
    uniqueIndex("idx_external_ids_unique").on(t.qid, t.property, t.value),
  ],
);

// The `(property, value)` keys of `external_ids` held by two or more qids, so
// the hunt's shared-id blocking reads only these instead of grouping every
// external id. Kept by the hunt itself (`refreshDupeKeys` in server/hunt.ts):
// one full rebuild, then only the keys of rows added since its last run
// (a `sync_state` watermark on `external_ids.id`). May hold keys that are no
// longer shared — the hunt re-counts each one and drops those.
export const externalIdDupes = mysqlTable(
  "external_id_dupes",
  {
    property: varchar("property", { length: 16 }).notNull(),
    value: varchar("value", { length: 512 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.property, t.value] })],
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
    // Copies of both items' primaryType/primaryLabel, so the list's type filter
    // and label search are index ranges on this table rather than joins through
    // `items`. Written by the hunt's upsert, re-synced by
    // server/candidate-item-info.ts; nullable like the columns they copy.
    fromType: varchar("from_type", { length: 32 }),
    intoType: varchar("into_type", { length: 32 }),
    fromLabel: varchar("from_label", { length: 255 }),
    intoLabel: varchar("into_label", { length: 255 }),
    // The languages a reviewer needs to read to judge the pair, for the list's
    // language filter (src/lib/languages.ts): the wikis of its blocking
    // sitelink clashes, and each item's label languages. Encoded ",de,es" (""
    // for none) so the filter is a REGEXP over the row. Written by the hunt;
    // null on rows it hasn't rescored since (resolved ones), which the filter
    // lets through.
    clashLangs: text("clash_langs"),
    fromLabelLangs: text("from_label_langs"),
    intoLabelLangs: text("into_label_langs"),
    // Both items' mirror data as the reviewer saw it, saved when the pair is
    // merged or marked "different from": the merge drops the merged-away item
    // from `items`, and later syncs rewrite both, so without this the detail
    // view has nothing (or the wrong thing) to show. Null on open pairs and
    // plain dismissals. Pairs resolved before this column existed were filled
    // in once from Wikidata's revision history.
    snapshot: json<{
      from: import("../src/lib/compare.ts").Item;
      into: import("../src/lib/compare.ts").Item;
    }>("snapshot"),
  },
  (t) => [
    uniqueIndex("idx_merge_candidates_pair").on(t.fromQid, t.intoQid),
    index("idx_merge_candidates_status_confidence").on(t.status, t.confidence),
    // Backs the list's "newest" sort (status filter + ORDER BY detected_at),
    // which otherwise filesorts every row of the status.
    index("idx_merge_candidates_status_detected").on(t.status, t.detectedAt),
    // Lookups by either side's qid (settling a merged item's other pairs); the
    // pair index above covers from_qid, this covers into_qid.
    index("idx_merge_candidates_into").on(t.intoQid),
    // The list's type filter, `(from_type = ? or into_type = ?)`: MariaDB
    // answers it with an index-merge union of these two ranges.
    index("idx_merge_candidates_status_from_type").on(t.status, t.fromType, t.confidence),
    index("idx_merge_candidates_status_into_type").on(t.status, t.intoType, t.confidence),
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
  // The property's subject type constraints (P2302 = Q21503250): allowed
  // classes, relation, exceptions. Null when it has none. With
  // `class_ancestors`, the hunt ignores an id on an item every constraint
  // rules out, such as an author's person id copied onto their works (see
  // src/lib/subject-types.ts).
  subjectTypes:
    json<import("../src/lib/subject-types.ts").SubjectTypeConstraint[]>("subject_types"),
  syncedAt: datetime("synced_at", { mode: "string" })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

// For every class our items are an instance of (P31) or subclass of (P279),
// its ancestors along P279* (itself included) that some subject type
// constraint names — not the whole subclass tree, just enough to tell whether
// a constraint on a superclass covers the item. Rebuilt weekly by
// jobs/sync-properties.ts (server/class-ancestors.ts). A class with no rows
// hasn't been looked up, and the constraint check treats it as unknown.
export const classAncestors = mysqlTable(
  "class_ancestors",
  {
    class: varchar("class", { length: 32 }).notNull(), // e.g. "Q7725634"
    ancestor: varchar("ancestor", { length: 32 }).notNull(), // e.g. "Q47461344"
  },
  (t) => [primaryKey({ columns: [t.class, t.ancestor] })],
);

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

// Whether a sitelinked page is a redirect, and where it points, resolved from
// the Wiki Replicas by jobs/resolve-sitelinks.ts (server/sitelink-redirects.ts).
// Only the pages behind a same-wiki sitelink clash on an open candidate are
// checked: the dump's "sitelink to redirect" badges say nothing about the
// target and are missing on pages that became redirects after being linked.
// Keyed on the sitelink as Wikidata stores it (site id + display title).
export const sitelinkPages = mysqlTable(
  "sitelink_pages",
  {
    wiki: varchar("wiki", { length: 64 }).notNull(), // site id = replica db name, e.g. "enwiki"
    title: varchar("title", { length: 255 }).notNull(), // sitelink title, spaces not underscores
    // The page doesn't exist (deleted since the dump, or not yet replicated).
    missing: boolean("missing").notNull(),
    isRedirect: boolean("is_redirect").notNull(),
    // Target page title (spaces) and section. Prefixed MediaWiki-style when the
    // target isn't a main-namespace page on this wiki ("Category:Foo",
    // "wikt:Foo"); null when it can't be named (a namespace with no canonical
    // name) or the replica has the page flagged as a redirect but no `redirect`
    // row for it.
    redirectTarget: varchar("redirect_target", { length: 255 }),
    redirectFragment: varchar("redirect_fragment", { length: 255 }),
    checkedAt: datetime("checked_at", { mode: "string" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    primaryKey({ columns: [t.wiki, t.title] }),
    index("idx_sitelink_pages_checked").on(t.checkedAt),
  ],
);

// Who created each candidate item, when, and with what edit summary/tags (so
// the UI can say "QuickStatements batch" or "OpenRefine"): the item's first
// revision, plus the creator's edit count and bot flag. Reviewers weigh a
// drive-by or bot creation differently from one by an editor they know. Filled
// nightly from the wikidatawiki replica for open candidates
// (jobs/resolve-creations.ts) and on demand from the Action API when a pair
// is viewed before that (server/item-creations.ts). The revision never
// changes; the creator's stats are refreshed when the row gets old.
export const itemCreations = mysqlTable(
  "item_creations",
  {
    qid: varchar("qid", { length: 32 }).primaryKey(),
    revId: bigint("rev_id", { mode: "number" }).notNull(),
    createdAt: datetime("created_at", { mode: "string" }).notNull(), // UTC
    // Null when the revision's user or summary is revision-deleted.
    userName: varchar("user_name", { length: 255 }),
    // Null for a logged-out (IP) creation, or a hidden user.
    userId: int("user_id"),
    userEditCount: int("user_edit_count"),
    userIsBot: boolean("user_is_bot").notNull().default(false),
    comment: text("comment"),
    tags: json<string[]>("tags").notNull(),
    checkedAt: datetime("checked_at", { mode: "string" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("idx_item_creations_checked").on(t.checkedAt),
    // The candidate list's "created by" filter.
    index("idx_item_creations_user").on(t.userName),
  ],
);

// Cursor bookkeeping for the paged Wikidata sync. One row per scope (e.g. the
// video-game population); `cursor` is the SPARQL OFFSET reached so far.
export const syncState = mysqlTable("sync_state", {
  scope: varchar("scope", { length: 64 }).primaryKey(), // e.g. "video-games"
  cursor: int("cursor").notNull().default(0),
  lastRunAt: datetime("last_run_at", { mode: "string" }),
});

// The dump import's work queue (server/dump-import.ts). A pass over `dump` is
// split into `segments` byte ranges of the .gz; workers claim them one at a
// time (`claimed_by` is the worker's name, `claim` a token for this claim,
// `claimed_at` refreshed as a heartbeat while it scans) and mark each done
// with its match count. The worker that marks the last segment of the set
// done prunes. A `--shard i/N` run records itself as segment i-1 of N. The
// set's rows are created by whichever worker starts first.
export const dumpImportSegments = mysqlTable(
  "dump_import_segments",
  {
    dump: varchar("dump", { length: 32 }).notNull(), // e.g. "20260914"
    segments: int("segments").notNull(),
    segment: int("segment").notNull(), // 0-based
    claimedBy: varchar("claimed_by", { length: 64 }),
    claim: varchar("claim", { length: 16 }),
    claimedAt: datetime("claimed_at", { mode: "string" }),
    doneAt: datetime("done_at", { mode: "string" }),
    matched: int("matched"),
    // The DUMP_REDO token of the last re-import of a finished set, so a worker
    // starting late with the same token doesn't reset the set a second time.
    pass: varchar("pass", { length: 32 }),
  },
  (t) => [primaryKey({ columns: [t.dump, t.segments, t.segment] })],
);

// The linked QIDs (loadLinkedQids) of one worker pass over a segment set, read
// from the mirror once by the first worker to start and shared with the rest,
// so N workers don't each run the same minute-long JSON_TABLE query. `qids` is
// the sorted numeric ids, comma-separated; `sources` the classes they were
// drawn from, so a pass with a different class list reads the mirror afresh.
export const dumpImportLinked = mysqlTable(
  "dump_import_linked",
  {
    dump: varchar("dump", { length: 32 }).notNull(),
    segments: int("segments").notNull(),
    sources: varchar("sources", { length: 1024 }).notNull(),
    qids: mediumtext("qids").notNull(),
    createdAt: datetime("created_at", { mode: "string" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [primaryKey({ columns: [t.dump, t.segments] })],
);

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
  // Languages the user reads (Wikidata codes, e.g. ["en", "de"]), set on the
  // settings page. When non-empty the candidate list hides pairs that need
  // another language to review (src/lib/languages.ts).
  languages: json<string[]>("languages"),
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
// `candidateId` is not a foreign key: the hunt prunes candidates and the
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
    // The EditGroups batch (https://editgroups.toolforge.org) the request's
    // edits were tagged with; one per merge or "different from" request.
    editGroup: varchar("edit_group", { length: 32 }),
    createdAt: datetime("created_at", { mode: "string" })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("idx_wikidata_edits_user_id").on(t.userId),
    index("idx_wikidata_edits_candidate_id").on(t.candidateId),
    index("idx_wikidata_edits_edit_group").on(t.editGroup),
  ],
);
