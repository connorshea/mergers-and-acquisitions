// Router for /api/candidates — the list, one candidate's full detail, and the
// dismiss/reopen actions. Shared helpers (summaryColumns, loadLabels, toSummary)
// live here and are used across all four handlers so the wire shapes stay in
// sync.
import { Hono } from "hono";
import { and, asc, count, desc, eq, gt, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "./db.ts";
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
  type CandidateSummary,
} from "../src/lib/api-types.ts";

const STATUSES = CANDIDATE_STATUSES;
const SORTS = CANDIDATE_SORTS;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
// Qids/pids loaded per IN list. MariaDB has no tight bound-param cap.
const ID_CHUNK = 1000;

/** Column set selected for a CandidateSummary; reused across all handlers. */
const summaryColumns = {
  id: mergeCandidates.id,
  fromQid: mergeCandidates.fromQid,
  intoQid: mergeCandidates.intoQid,
  confidence: mergeCandidates.confidence,
  status: mergeCandidates.status,
  hasBlocker: mergeCandidates.hasBlocker,
  reasons: mergeCandidates.reasons,
  detectedAt: mergeCandidates.detectedAt,
};

type CandidateRow = {
  id: number;
  fromQid: string;
  intoQid: string;
  confidence: number;
  status: string;
  hasBlocker: boolean;
  reasons: unknown;
  detectedAt: string;
};

/**
 * Look up `items.primaryLabel` for a set of qids in one query. Returns a map so
 * callers can attach fromLabel/intoLabel without an N+1 lookup. Missing qids are
 * simply absent from the map.
 */
async function loadLabels(qids: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const unique = [...new Set(qids)].filter(Boolean);
  if (unique.length === 0) return map;
  const rows = await db
    .select({ qid: items.qid, primaryLabel: items.primaryLabel })
    .from(items)
    .where(inArray(items.qid, unique));
  for (const r of rows) map.set(r.qid, r.primaryLabel);
  return map;
}

/** Flatten a candidate row + resolved labels into the wire shape. */
function toSummary(row: CandidateRow, labels: Map<string, string | null>): CandidateSummary {
  return {
    id: row.id,
    fromQid: row.fromQid,
    intoQid: row.intoQid,
    fromLabel: labels.get(row.fromQid) ?? null,
    intoLabel: labels.get(row.intoQid) ?? null,
    confidence: row.confidence,
    status: row.status,
    hasBlocker: row.hasBlocker,
    reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
    detectedAt: row.detectedAt,
  };
}

function parseIntParam(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const candidates = new Hono();

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

  // A candidate can outlive one of its item rows (e.g. an item was deleted or
  // never synced). We can't render a comparison without both, so 404 naming the
  // absent qid.
  if (!from || !into) {
    const missing = [!from && row.fromQid, !into && row.intoQid].filter(Boolean).join(", ");
    return c.json({ error: `Item data missing for: ${missing}` }, 404);
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
    .set({ status: "dismissed", resolvedAt: sql`CURRENT_TIMESTAMP` })
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
candidates.post("/:id/reopen", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }

  await db
    .update(mergeCandidates)
    .set({ status: "open", resolvedAt: null, resolution: null })
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
