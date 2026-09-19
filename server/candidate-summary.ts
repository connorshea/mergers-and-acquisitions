// The CandidateSummary wire shape: the columns to select for it, the label
// lookup it needs, and the flattening. Shared by the candidates router
// (server/candidates.ts) and the Wikidata edit routes (server/edits.ts).
import { inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { items, mergeCandidates } from "../db/schema.ts";
import type { CandidateSummary } from "../src/lib/api-types.ts";

/** Column set selected for a CandidateSummary; reused across all handlers. */
export const summaryColumns = {
  id: mergeCandidates.id,
  fromQid: mergeCandidates.fromQid,
  intoQid: mergeCandidates.intoQid,
  confidence: mergeCandidates.confidence,
  status: mergeCandidates.status,
  hasBlocker: mergeCandidates.hasBlocker,
  reasons: mergeCandidates.reasons,
  detectedAt: mergeCandidates.detectedAt,
  resolution: mergeCandidates.resolution,
};

export type CandidateRow = {
  id: number;
  fromQid: string;
  intoQid: string;
  confidence: number;
  status: string;
  hasBlocker: boolean;
  reasons: unknown;
  detectedAt: string;
  resolution: string | null;
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
    resolution: row.resolution,
  };
}
