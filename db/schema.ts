import { index, integer, real, sqliteTable, text, uniqueIndex } from "void/schema-d1";
import { sql } from "void/db";

// One row per synced Wikidata item. `data` holds the mapped `Item` (from
// src/lib/compare.ts) as JSON so the comparison UI and scorer can consume it
// without a second round-trip. `primaryLabel` / `primaryType` are denormalized
// out of `data` for cheap search, filtering, and blocking.
export const items = sqliteTable(
  "items",
  {
    qid: text("qid").primaryKey(), // e.g. "Q42"
    primaryLabel: text("primary_label"), // Item.labels.en ?? mul, nullable
    primaryType: text("primary_type"), // first P31 value QID, e.g. "Q7889"
    data: text("data", { mode: "json" }).notNull(), // JSON-encoded Item
    lastSyncedAt: text("last_synced_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index("idx_items_primary_label").on(t.primaryLabel),
    index("idx_items_primary_type").on(t.primaryType),
  ],
);

// External identifiers pulled out of each item's statements. `(property, value)`
// is the blocking key the hunt job groups on to find shared-ID duplicates
// without an O(n²) scan. Rebuilt wholesale for an item on each sync.
export const externalIds = sqliteTable(
  "external_ids",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    qid: text("qid").notNull(),
    property: text("property").notNull(), // e.g. "P1733" (Steam application ID)
    value: text("value").notNull(),
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
export const mergeCandidates = sqliteTable(
  "merge_candidates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromQid: text("from_qid").notNull(),
    intoQid: text("into_qid").notNull(),
    confidence: real("confidence").notNull(),
    status: text("status").notNull().default("open"), // open | dismissed | merged
    reasons: text("reasons", { mode: "json" }).notNull().default("[]"), // string[]
    hasBlocker: integer("has_blocker", { mode: "boolean" }).notNull().default(false),
    detectedAt: text("detected_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    resolvedAt: text("resolved_at"),
    resolution: text("resolution"), // free-form note on how it was resolved
  },
  (t) => [
    uniqueIndex("idx_merge_candidates_pair").on(t.fromQid, t.intoQid),
    index("idx_merge_candidates_status_confidence").on(t.status, t.confidence),
  ],
);

// Human-readable labels for Wikidata properties, synced wholesale from Wikidata
// (see crons/sync-properties.ts). Lets the UI show "Steam application ID"
// instead of a bare "P1733" without hard-coding a map. `datatype` is Wikidata's
// property type (e.g. "ExternalId", "WikibaseItem").
export const properties = sqliteTable("properties", {
  pid: text("pid").primaryKey(), // e.g. "P1733"
  label: text("label").notNull(), // English label, e.g. "Steam application ID"
  datatype: text("datatype"), // Wikidata property type, nullable
  syncedAt: text("synced_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// Cursor bookkeeping for the paged Wikidata sync. One row per scope (e.g. the
// video-game population); `cursor` is the SPARQL OFFSET reached so far.
export const syncState = sqliteTable("sync_state", {
  scope: text("scope").primaryKey(), // e.g. "video-games"
  cursor: integer("cursor").notNull().default(0),
  lastRunAt: text("last_run_at"),
});
