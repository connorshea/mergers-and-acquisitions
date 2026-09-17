// Shared request/response contract for the candidate API. Imported by both the
// server routes (routes/api/candidates/*) and the client pages so the shapes
// stay in sync from one definition.

import type { Item } from "./compare";

export const CANDIDATE_STATUSES = ["open", "dismissed", "merged"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const CANDIDATE_SORTS = ["confidence", "detectedAt"] as const;
export type CandidateSort = (typeof CANDIDATE_SORTS)[number];

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

export interface CandidateDetailResponse {
  candidate: CandidateSummary;
  /** Parsed items.data for fromQid / intoQid, ready for the comparison view. */
  from: Item;
  into: Item;
  /** Pxxx → human label, for the property ids present on this pair. */
  propertyLabels: Record<string, string>;
  /** Pxxx → formatter URL (with "$1" placeholder), for props that have one. */
  propertyFormatters: Record<string, string>;
  /** Pxxx that source their ids from Wikidata (synced `mirrors_wikidata`); the UI
   * unions this with its hardcoded floor to mark Wikidata-sourced identifiers. */
  propertyMirrors: string[];
  /** Qxxx → human label, for the item values present on this pair. */
  valueLabels: Record<string, string>;
  /** Neighbour candidate ids for prev/next navigation (same status, confidence order). */
  prevId: number | null;
  nextId: number | null;
}

export interface CandidateDismissResponse {
  candidate: CandidateSummary;
}

/** Response for reopening (un-dismissing) a candidate back to `open`. */
export interface CandidateReopenResponse {
  candidate: CandidateSummary;
}

export interface HuntTriggerResponse {
  enqueued: boolean;
  message: string;
}

export interface PropertiesSyncResponse {
  /** Number of property labels fetched and upserted. */
  synced: number;
}

export interface EntityLabelsSyncResponse {
  /** Number of item/value labels fetched and upserted. */
  synced: number;
}

export interface DescriptionsSyncResponse {
  /** Number of game descriptions fetched and upserted. */
  synced: number;
}

export interface ResetResponse {
  /** Number of merge candidates deleted. */
  deleted: number;
}
