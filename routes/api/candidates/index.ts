// GET /api/candidates — paginated, filterable, sortable list of merge
// candidates. Shared response types and helpers live here and are imported by
// the sibling routes ([id].ts, [id]/dismiss.ts) so the shapes stay in sync.
import { and, count, db, desc, eq, gte, inArray, sql } from "void/db";
import { items, mergeCandidates } from "@schema";
import { defineHandler } from "void";

/** One merge candidate, flattened for list/detail rendering. */
export interface CandidateSummary {
  id: number;
  fromQid: string;
  intoQid: string;
  /** items.primaryLabel for the respective qid; null if the item row is absent. */
  fromLabel: string | null;
  intoLabel: string | null;
  confidence: number;
  status: string;
  hasBlocker: boolean;
  reasons: string[];
  detectedAt: string;
}

export interface CandidateListResponse {
  candidates: CandidateSummary[];
  total: number;
  page: number;
  pageSize: number;
}

const STATUSES = ["open", "dismissed", "merged"] as const;
const SORTS = ["confidence", "detectedAt"] as const;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/** Column set selected for a CandidateSummary; reused across all three routes. */
export const summaryColumns = {
  id: mergeCandidates.id,
  fromQid: mergeCandidates.fromQid,
  intoQid: mergeCandidates.intoQid,
  confidence: mergeCandidates.confidence,
  status: mergeCandidates.status,
  hasBlocker: mergeCandidates.hasBlocker,
  reasons: mergeCandidates.reasons,
  detectedAt: mergeCandidates.detectedAt,
};

/** Row shape produced by selecting `summaryColumns`. `reasons` is JSON-decoded by Drizzle. */
export type CandidateRow = {
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
export async function loadLabels(qids: string[]): Promise<Map<string, string | null>> {
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
export function toSummary(row: CandidateRow, labels: Map<string, string | null>): CandidateSummary {
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

export const GET = defineHandler(async (c): Promise<CandidateListResponse> => {
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
    // Correlated subqueries keep the filter (and thus `total`/pagination) in SQL
    // without needing to alias the items table twice.
    const pattern = `%${q.toLowerCase()}%`;
    conditions.push(
      sql`(
        exists (select 1 from items where items.qid = ${mergeCandidates.fromQid} and lower(items.primary_label) like ${pattern})
        or exists (select 1 from items where items.qid = ${mergeCandidates.intoQid} and lower(items.primary_label) like ${pattern})
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
  const candidates = rows.map((r) => toSummary(r, labels));

  return { candidates, total, page, pageSize };
});
