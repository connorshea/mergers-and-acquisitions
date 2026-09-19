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
import {
  entityLabels,
  itemDescriptions,
  items,
  mergeCandidates,
  properties,
} from "../db/schema.ts";
import type { Item } from "../src/lib/compare.ts";
import { chunk } from "../src/lib/chunk.ts";
import {
  CANDIDATE_SORTS,
  CANDIDATE_STATUSES,
  type CandidateDetailResponse,
  type CandidateDismissResponse,
  type CandidateListResponse,
  type CandidateReopenResponse,
} from "../src/lib/api-types.ts";

const STATUSES = CANDIDATE_STATUSES;
const SORTS = CANDIDATE_SORTS;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
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

  if (q) {
    // Case-insensitive substring match against either item's primaryLabel.
    // MariaDB's default collation is case-insensitive, so LIKE already folds
    // case; lower() is belt-and-braces. Correlated subqueries keep the filter
    // (and thus `total`/pagination) in SQL.
    const pattern = `%${q.toLowerCase()}%`;
    conditions.push(
      sql`(
        exists (select 1 from items where items.qid = ${mergeCandidates.fromQid} and lower(items.primary_label) like ${pattern})
        or exists (select 1 from items where items.qid = ${mergeCandidates.intoQid} and lower(items.primary_label) like ${pattern})
      )`,
    );
  }

  // Instance-of (P31) filter: keep pairs where *either* item's denormalized
  // primaryType matches the given QID (the hunt's label+type path pairs items of
  // the same type, but the shared-id path can pair across types, so match either
  // side — same shape as the `q` search above). Ignored unless it's a valid QID.
  const typeParam = req.query("type")?.trim();
  if (typeParam && /^Q\d+$/.test(typeParam)) {
    conditions.push(
      sql`(
        exists (select 1 from items where items.qid = ${mergeCandidates.fromQid} and items.primary_type = ${typeParam})
        or exists (select 1 from items where items.qid = ${mergeCandidates.intoQid} and items.primary_type = ${typeParam})
      )`,
    );
  }

  const where = and(...conditions);
  const sortColumn =
    sort === "confidence" ? mergeCandidates.confidence : mergeCandidates.detectedAt;

  const [{ total }] = await db.select({ total: count() }).from(mergeCandidates).where(where);

  const rows = await db
    .select(summaryColumns)
    .from(mergeCandidates)
    .where(where)
    // Always descending; id as a stable tiebreaker for deterministic paging.
    .orderBy(desc(sortColumn), desc(mergeCandidates.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const labels = await loadLabels(rows.flatMap((r) => [r.fromQid, r.intoQid]));
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
    loadLabels([row.fromQid, row.intoQid]),
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

  const [propertyChunks, valueChunks, descRows] = await Promise.all([
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
    db
      .select({ qid: itemDescriptions.qid, description: itemDescriptions.description })
      .from(itemDescriptions)
      .where(inArray(itemDescriptions.qid, [...new Set([row.fromQid, row.intoQid])])),
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

  // The dump omits descriptions; backfill the synced English description onto
  // each item so the comparison view shows it and treats a conflicting
  // description as a merge blocker. Never overwrite one already set.
  const descByQid = new Map(descRows.map((r) => [r.qid, r.description]));
  for (const item of [from, into]) {
    const desc = descByQid.get(item.id);
    if (desc && !item.descriptions.en) item.descriptions = { ...item.descriptions, en: desc };
  }

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

// POST /api/candidates/:id/dismiss — mark dismissed, stamp resolvedAt.
candidates.post("/:id/dismiss", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }

  // MariaDB has no UPDATE … RETURNING, so update then re-select the summary.
  await db
    .update(mergeCandidates)
    .set({
      status: "dismissed",
      resolvedAt: sql`CURRENT_TIMESTAMP`,
      resolvedBy: c.get("user")?.id ?? null,
    })
    .where(eq(mergeCandidates.id, id));

  const [row] = await db
    .select(summaryColumns)
    .from(mergeCandidates)
    .where(eq(mergeCandidates.id, id));
  if (!row) {
    return c.json({ error: "Candidate not found" }, 404);
  }

  const labels = await loadLabels([row.fromQid, row.intoQid]);
  const payload: CandidateDismissResponse = { candidate: toSummary(row, labels) };
  return c.json(payload);
});

// POST /api/candidates/:id/reopen — un-dismiss back to `open`, clear stamps.
// A merged candidate stays merged (the merge already happened on Wikidata and
// the merged-away item is gone from the mirror), and one that is being merged
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
    return c.json({ error: "A merge of this candidate is in progress" }, 409);
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

  const labels = await loadLabels([row.fromQid, row.intoQid]);
  const payload: CandidateReopenResponse = { candidate: toSummary(row, labels) };
  return c.json(payload);
});
