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
}

export interface CandidateDismissResponse {
  candidate: CandidateSummary;
}
