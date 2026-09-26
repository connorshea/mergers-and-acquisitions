// Router for /api/candidates — the list, one candidate's full detail, and the
// dismiss/reopen actions. The Wikidata edit routes on the same prefix live in
// server/edits.ts; both build their responses with server/candidate-summary.ts
// so the wire shapes stay in sync.
import { Hono } from "hono";
import { and, asc, count, desc, eq, gt, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { type AuthEnv, requireUser } from "./auth/session.ts";
import { addSeconds, toSqlDatetime } from "./auth/time.ts";
import { MERGING_STALE_SECONDS } from "./edits.ts";
import { loadLabels, summaryColumns, toSummary } from "./candidate-summary.ts";
import { attachSitelinkRedirects } from "./sitelink-overlay.ts";
import { loadCreations } from "./item-creations.ts";
import { entityLabels, itemCreations, items, mergeCandidates, properties } from "../db/schema.ts";
import type { Item } from "../src/lib/compare.ts";
import { chunk } from "../src/lib/chunk.ts";
import { normalizeUserName } from "../src/lib/creation.ts";
import { languageSqlPatterns, normalizeLanguages } from "../src/lib/languages.ts";
import {
  CANDIDATE_SORTS,
  CANDIDATE_STATUSES,
  type CandidateCreationsResponse,
  type CandidateDetailResponse,
  type CandidateDismissResponse,
  type CandidateListResponse,
  type CandidateReopenResponse,
} from "../src/lib/api-types.ts";

const STATUSES = CANDIDATE_STATUSES;
const SORTS = CANDIDATE_SORTS;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
/** Most instance-of types one list request filters on. */
const MAX_TYPE_FILTERS = 50;
// Qids/pids loaded per IN list. MariaDB has no tight bound-param cap.
const ID_CHUNK = 1000;

function parseIntParam(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const candidates = new Hono<AuthEnv>();

// Reading is open; resolving a candidate requires a logged-in editor.
candidates.use("/:id/dismiss", requireUser);
candidates.use("/:id/reopen", requireUser);

// GET /api/candidates — paginated, filterable, sortable list.
candidates.get("/", async (c) => {
  const req = c.req;

  const q = req.query("q")?.trim();
  const statusParam = req.query("status");
  const status = STATUSES.includes(statusParam as (typeof STATUSES)[number])
    ? (statusParam as (typeof STATUSES)[number])
    : "open";
  const sortParam = req.query("sort");
  const sort = SORTS.includes(sortParam as (typeof SORTS)[number])
    ? (sortParam as (typeof SORTS)[number])
    : "confidence";

  const page = Math.max(1, Math.floor(parseIntParam(req.query("page"), 1)));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(parseIntParam(req.query("pageSize"), DEFAULT_PAGE_SIZE))),
  );

  const conditions = [eq(mergeCandidates.status, status)];

  const minConfidenceRaw = req.query("minConfidence");
  if (minConfidenceRaw !== undefined && minConfidenceRaw !== "") {
    const minConfidence = Number(minConfidenceRaw);
    if (Number.isFinite(minConfidence)) {
      conditions.push(gte(mergeCandidates.confidence, minConfidence));
    }
  }

  // Hide pairs with a conflict that blocks the merge (the list's "Blocker"
  // flag). Off unless `noBlockers=1`.
  if (req.query("noBlockers") === "1") {
    conditions.push(eq(mergeCandidates.hasBlocker, false));
  }

  // Item-side filters, matching pairs where *either* item matches (the hunt's
  // label+type path pairs items of the same type, but the shared-id path can
  // pair across types). Both read the pair's own copies of the items'
  // primaryLabel/primaryType (see server/candidate-item-info.ts), so neither
  // has to join `items`.
  if (q) {
    // Case-insensitive substring match. The database collation is utf8mb4_bin
    // (case-sensitive), so fold both sides with lower().
    const pattern = `%${q.toLowerCase()}%`;
    conditions.push(
      or(
        sql`lower(${mergeCandidates.fromLabel}) like ${pattern}`,
        sql`lower(${mergeCandidates.intoLabel}) like ${pattern}`,
      )!,
    );
  }

  // Instance-of (P31) filter: a comma-separated list of QIDs, matching a pair
  // of any of them. Entries that aren't valid QIDs are ignored.
  const types = [
    ...new Set(
      (req.query("type") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => /^Q\d+$/.test(t)),
    ),
  ].slice(0, MAX_TYPE_FILTERS);
  if (types.length > 0) {
    conditions.push(
      or(inArray(mergeCandidates.fromType, types), inArray(mergeCandidates.intoType, types))!,
    );
  }

  // Creator filter: pairs where either item was created by this user (exact
  // match on the normalized name, via the item_creations user index). Only
  // items with an item_creations row can match; the nightly job fills those
  // for open candidates, and viewing a pair fills its two.
  const creatorParam = req.query("creator")?.trim();
  if (creatorParam) {
    const createdBy = db
      .select({ qid: itemCreations.qid })
      .from(itemCreations)
      .where(eq(itemCreations.userName, normalizeUserName(creatorParam)));
    conditions.push(
      or(inArray(mergeCandidates.fromQid, createdBy), inArray(mergeCandidates.intoQid, createdBy))!,
    );
  }

  // Reader-language filter: a comma-separated list of the languages the
  // reviewer reads (the client sends the user's setting). Hides pairs with a
  // sitelink clash on a wiki in another language, or an item with no label in
  // one of them (nor `mul`). Rows the hunt hasn't annotated (null) pass.
  const langs = normalizeLanguages((req.query("lang") ?? "").split(","));
  if (langs.length > 0) {
    const { allRead, anyRead } = languageSqlPatterns(langs);
    for (const column of [mergeCandidates.fromLabelLangs, mergeCandidates.intoLabelLangs]) {
      conditions.push(sql`(${column} is null or ${column} regexp ${anyRead})`);
    }
    conditions.push(
      sql`(${mergeCandidates.clashLangs} is null or ${mergeCandidates.clashLangs} regexp ${allRead})`,
    );
  }

  const where = and(...conditions);
  const sortColumn =
    sort === "confidence" ? mergeCandidates.confidence : mergeCandidates.detectedAt;

  // The count and the page are independent; run them concurrently (each takes
  // its own pool connection).
  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(mergeCandidates).where(where),
    db
      .select(summaryColumns)
      .from(mergeCandidates)
      .where(where)
      // Always descending; id as a stable tiebreaker for deterministic paging.
      .orderBy(desc(sortColumn), desc(mergeCandidates.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ]);

  const labels = await loadLabels(rows);
  const candidateList = rows.map((r) => toSummary(r, labels));

  const payload: CandidateListResponse = {
    candidates: candidateList,
    total,
    page,
    pageSize,
  };
  return c.json(payload);
});

// GET /api/candidates/:id — one candidate with both items' full data.
candidates.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }

  const [row] = await db
    .select(summaryColumns)
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!row) {
    return c.json({ error: "Candidate not found" }, 404);
  }

  // Neighbours for prev/next navigation, within the same status and using the
  // list's default order (confidence desc, then id asc as a stable tiebreak).
  const sameStatus = eq(mergeCandidates.status, row.status);
  const afterCurrent = or(
    lt(mergeCandidates.confidence, row.confidence),
    and(eq(mergeCandidates.confidence, row.confidence), gt(mergeCandidates.id, row.id)),
  );
  const beforeCurrent = or(
    gt(mergeCandidates.confidence, row.confidence),
    and(eq(mergeCandidates.confidence, row.confidence), lt(mergeCandidates.id, row.id)),
  );

  const [labels, itemRows, nextRows, prevRows] = await Promise.all([
    loadLabels([row]),
    db
      .select({ qid: items.qid, data: items.data })
      .from(items)
      .where(inArray(items.qid, [...new Set([row.fromQid, row.intoQid])])),
    db
      .select({ id: mergeCandidates.id })
      .from(mergeCandidates)
      .where(and(sameStatus, afterCurrent))
      .orderBy(desc(mergeCandidates.confidence), asc(mergeCandidates.id))
      .limit(1),
    db
      .select({ id: mergeCandidates.id })
      .from(mergeCandidates)
      .where(and(sameStatus, beforeCurrent))
      .orderBy(asc(mergeCandidates.confidence), desc(mergeCandidates.id))
      .limit(1),
  ]);

  const dataByQid = new Map(itemRows.map((r) => [r.qid, r.data as Item]));
  const from = dataByQid.get(row.fromQid);
  const into = dataByQid.get(row.intoQid);

  // A candidate can outlive one of its item rows: a merge drops the
  // merged-away item from the mirror (server/edits.ts), or an item was deleted
  // or never synced. We can't render a comparison without both, so 404 naming
  // the absent qid (and the reason, when it is a merge).
  if (!from || !into) {
    const missing = [!from && row.fromQid, !into && row.intoQid].filter(Boolean).join(", ");
    const why = row.status === "merged" ? " (merged away; the mirror no longer holds it)" : "";
    return c.json({ error: `Item data missing for: ${missing}${why}` }, 404);
  }
  await attachSitelinkRedirects(db, [[from, into]]);

  // Resolve human labels for just the property ids present on this pair.
  const pids = [...new Set([...Object.keys(from.statements), ...Object.keys(into.statements)])];
  // Item-valued statements reference other Qids that need a display label too
  // (genre, platform, developer, …). Collect them from both items' statements.
  const valueQids = new Set<string>();
  for (const item of [from, into]) {
    for (const values of Object.values(item.statements)) {
      for (const v of values) {
        if (v.type === "item" && !v.label) valueQids.add(v.value);
      }
    }
  }

  const [propertyChunks, valueChunks] = await Promise.all([
    Promise.all(
      chunk(pids, ID_CHUNK).map((ids) =>
        db
          .select({
            pid: properties.pid,
            label: properties.label,
            formatterUrl: properties.formatterUrl,
            mirrorsWikidata: properties.mirrorsWikidata,
          })
          .from(properties)
          .where(inArray(properties.pid, ids)),
      ),
    ),
    Promise.all(
      chunk([...valueQids], ID_CHUNK).map((ids) =>
        db
          .select({ qid: entityLabels.qid, label: entityLabels.label })
          .from(entityLabels)
          .where(inArray(entityLabels.qid, ids)),
      ),
    ),
  ]);

  const propertyLabels: Record<string, string> = {};
  const propertyFormatters: Record<string, string> = {};
  // Properties whose ids are sourced *from* Wikidata (P31=Q24075706, the synced
  // `mirrors_wikidata` flag). The UI marks these; it unions this with the
  // hardcoded floor (isHardcodedMirrorProp) for services Wikidata hasn't tagged.
  const propertyMirrors: string[] = [];
  for (const r of propertyChunks.flat()) {
    propertyLabels[r.pid] = r.label;
    if (r.formatterUrl) propertyFormatters[r.pid] = r.formatterUrl;
    if (r.mirrorsWikidata) propertyMirrors.push(r.pid);
  }
  const valueLabels: Record<string, string> = {};
  for (const r of valueChunks.flat()) valueLabels[r.qid] = r.label;

  const payload: CandidateDetailResponse = {
    candidate: toSummary(row, labels),
    from,
    into,
    propertyLabels,
    propertyFormatters,
    propertyMirrors,
    valueLabels,
    prevId: prevRows[0]?.id ?? null,
    nextId: nextRows[0]?.id ?? null,
  };
  return c.json(payload);
});

// GET /api/candidates/:id/creations — who created each item, when, and how.
// Separate from the detail so the comparison renders without waiting on the
// Action API for items the nightly replica job hasn't reached yet.
candidates.get("/:id/creations", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }
  const [row] = await db
    .select({ fromQid: mergeCandidates.fromQid, intoQid: mergeCandidates.intoQid })
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!row) {
    return c.json({ error: "Candidate not found" }, 404);
  }
  const payload: CandidateCreationsResponse = {
    creations: await loadCreations([row.fromQid, row.intoQid]),
  };
  return c.json(payload);
});

// POST /api/candidates/:id/dismiss — mark dismissed, stamp resolvedAt.
// A merged candidate stays merged (dismiss → reopen would otherwise revive a
// pair whose source item is already a redirect), and one being edited right
// now keeps its claim until it goes stale. The status check lives in the
// UPDATE itself so a concurrent merge claim can't slip in between.
candidates.post("/:id/dismiss", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }

  const staleBefore = toSqlDatetime(addSeconds(new Date(), -MERGING_STALE_SECONDS));
  const [result] = await db
    .update(mergeCandidates)
    .set({
      status: "dismissed",
      resolvedAt: sql`CURRENT_TIMESTAMP`,
      resolvedBy: c.get("user")?.id ?? null,
    })
    .where(
      and(
        eq(mergeCandidates.id, id),
        or(
          inArray(mergeCandidates.status, ["open", "dismissed"]),
          and(eq(mergeCandidates.status, "merging"), lt(mergeCandidates.resolvedAt, staleBefore)),
        ),
      ),
    );

  // MariaDB has no UPDATE … RETURNING, so re-select the summary either way.
  const [row] = await db
    .select(summaryColumns)
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!row) {
    return c.json({ error: "Candidate not found" }, 404);
  }
  if (result.affectedRows === 0) {
    return c.json(
      {
        error:
          row.status === "merging"
            ? "An edit of this candidate is in progress"
            : "A merged candidate can't be dismissed",
      },
      409,
    );
  }

  const labels = await loadLabels([row]);
  const payload: CandidateDismissResponse = { candidate: toSummary(row, labels) };
  return c.json(payload);
});

// POST /api/candidates/:id/reopen — un-dismiss back to `open`, clear stamps.
// A merged candidate stays merged (the merge already happened on Wikidata and
// the merged-away item is gone from the mirror), and one that is being edited
// right now can only be reopened once its claim has gone stale.
candidates.post("/:id/reopen", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }

  const [current] = await db
    .select({ status: mergeCandidates.status, resolvedAt: mergeCandidates.resolvedAt })
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!current) {
    return c.json({ error: "Candidate not found" }, 404);
  }
  if (current.status === "merged") {
    return c.json({ error: "A merged candidate can't be reopened" }, 409);
  }
  if (
    current.status === "merging" &&
    (current.resolvedAt ?? "") >= toSqlDatetime(addSeconds(new Date(), -MERGING_STALE_SECONDS))
  ) {
    return c.json({ error: "An edit of this candidate is in progress" }, 409);
  }

  await db
    .update(mergeCandidates)
    .set({ status: "open", resolvedAt: null, resolution: null, resolvedBy: null })
    .where(eq(mergeCandidates.id, id));

  const [row] = await db
    .select(summaryColumns)
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!row) {
    return c.json({ error: "Candidate not found" }, 404);
  }

  const labels = await loadLabels([row]);
  const payload: CandidateReopenResponse = { candidate: toSummary(row, labels) };
  return c.json(payload);
});
