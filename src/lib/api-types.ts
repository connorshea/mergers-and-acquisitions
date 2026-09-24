// Shared request/response contract for the candidate API. Imported by both the
// server routes (routes/api/candidates/*) and the client pages so the shapes
// stay in sync from one definition.

import type { Item } from "./compare.ts";

export const CANDIDATE_STATUSES = ["open", "merging", "dismissed", "merged"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/**
 * Statuses a human (or an in-flight merge) owns: the hunt never rescores,
 * resurrects, or drops a candidate in one of these, and the list's default
 * view excludes them.
 */
export const PROTECTED_STATUSES = ["merging", "dismissed", "merged"] as const;

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
  /** How a non-open candidate got that way (e.g. the merge's revision, "merged elsewhere"). */
  resolution: string | null;
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

// --- Wikidata edits (merge / "different from") ---

/** One saved revision on Wikidata, with a link to view it. */
export interface WikidataRevision {
  qid: string;
  revid: number;
  url: string;
}

export interface CandidateMergeResponse {
  candidate: CandidateSummary;
  from: WikidataRevision;
  into: WikidataRevision;
  /**
   * Whether the source item became a redirect. The app never ignores sitelink
   * conflicts (the one thing that leaves a merged item alive), so this is
   * expected to be true; false means Wikidata left it standing and it needs a
   * look by hand.
   */
  redirected: boolean;
}

/** The outcome of one direction of a "different from" claim. */
export interface DifferentFromEdit {
  /** The item the claim was added to. */
  qid: string;
  /** The item it points at. */
  target: string;
  /** Set when the claim already existed on our mirror and nothing was sent. */
  skipped?: boolean;
  revision?: WikidataRevision;
  error?: string;
}

export interface CandidateDifferentResponse {
  candidate: CandidateSummary;
  edits: DifferentFromEdit[];
}

/**
 * Error body for the edit endpoints. `code` lets the client react (offer a
 * re-login, explain a merge conflict) without parsing the message, which
 * is Wikidata's own text where it came from there.
 */
export interface EditErrorResponse {
  error: string;
  code?:
    | "login-required"
    | "blocked"
    | "rate-limited"
    | "not-open"
    | "conflict"
    | "permission-denied"
    | "wikidata-error";
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
  /** Referenced QIDs skipped after repeated lookup failures. */
  failed: number;
}

export interface ResetResponse {
  /** Number of merge candidates deleted. */
  deleted: number;
}

/** The logged-in user as exposed to the client (never tokens). */
export interface AuthUserInfo {
  id: number;
  username: string;
  isAdmin: boolean;
  blocked: boolean;
}

export interface AuthMeResponse {
  user: AuthUserInfo | null;
  /** False when the server has no OAuth consumer configured (login is unavailable). */
  configured: boolean;
  /** Origin of the Wikidata instance edits go to, e.g. "https://test.wikidata.org". */
  wikiBaseUrl: string;
}

export interface LogoutResponse {
  ok: true;
}
