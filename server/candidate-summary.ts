// The CandidateSummary wire shape: the columns to select for it, the label
// lookup it needs, and the flattening. Shared by the candidates router
// (server/candidates.ts) and the Wikidata edit routes (server/edits.ts).
import { inArray } from "drizzle-orm";
import { db } from "./db.ts";
import { entityLabels, items, mergeCandidates } from "../db/schema.ts";
import type { CandidateSummary } from "../src/lib/api-types.ts";
import { IMPORT_CLASS_OPTIONS } from "../src/lib/import-classes.ts";

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
  fromType: mergeCandidates.fromType,
  intoType: mergeCandidates.intoType,
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
  fromType: string | null;
  intoType: string | null;
};

/** The pair's `instance of` when both sides share it (by primaryType), else null. */
function sharedTypeOf(row: CandidateRow): string | null {
  return row.fromType && row.fromType === row.intoType ? row.fromType : null;
}

export type SummaryLabels = {
  /** items.primaryLabel by qid, for fromLabel/intoLabel. */
  items: Map<string, string | null>;
  /** Display label by class qid, for sharedType. */
  types: Map<string, string>;
};

/**
 * Resolve every label a set of CandidateSummary rows needs in one query per
 * kind, so callers avoid an N+1 lookup: the items' primaryLabel, and a label for
 * each shared `instance of` class (the import-class presets, else the synced
 * entity_labels). Missing qids are simply absent from the maps.
 */
export async function loadLabels(rows: CandidateRow[]): Promise<SummaryLabels> {
  const labels: SummaryLabels = { items: new Map(), types: new Map() };
  const qids = [...new Set(rows.flatMap((r) => [r.fromQid, r.intoQid]))].filter(Boolean);
  const types = new Set<string>();
  for (const r of rows) {
    const type = sharedTypeOf(r);
    if (!type) continue;
    const preset = IMPORT_CLASS_OPTIONS.find((o) => o.qid === type);
    if (preset) labels.types.set(type, preset.label);
    else types.add(type);
  }
  const [itemRows, typeRows] = await Promise.all([
    qids.length === 0
      ? []
      : db
          .select({ qid: items.qid, primaryLabel: items.primaryLabel })
          .from(items)
          .where(inArray(items.qid, qids)),
    types.size === 0
      ? []
      : db
          .select({ qid: entityLabels.qid, label: entityLabels.label })
          .from(entityLabels)
          .where(inArray(entityLabels.qid, [...types])),
  ]);
  for (const r of itemRows) labels.items.set(r.qid, r.primaryLabel);
  for (const r of typeRows) labels.types.set(r.qid, r.label);
  return labels;
}

/** Flatten a candidate row + resolved labels into the wire shape. */
export function toSummary(row: CandidateRow, labels: SummaryLabels): CandidateSummary {
  const sharedType = sharedTypeOf(row);
  return {
    id: row.id,
    fromQid: row.fromQid,
    intoQid: row.intoQid,
    fromLabel: labels.items.get(row.fromQid) ?? null,
    intoLabel: labels.items.get(row.intoQid) ?? null,
    sharedType: sharedType
      ? { qid: sharedType, label: labels.types.get(sharedType) ?? null }
      : null,
    confidence: row.confidence,
    status: row.status,
    hasBlocker: row.hasBlocker,
    reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
    detectedAt: row.detectedAt,
    resolution: row.resolution,
  };
}
