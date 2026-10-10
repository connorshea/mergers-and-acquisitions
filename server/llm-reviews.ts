// Stored Claude reviews of candidate pairs (the `llm_reviews` table) and the
// one thing a review may do to a candidate: hide it as `auto_dismissed`.
//
// A review never edits Wikidata and never changes a pair's score. This module,
// and everything on the review job's path, must not import the Wikidata edit
// client; server/llm-reviews.test.ts walks the imports to keep it that way.
import { and, asc, eq } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import type * as schema from "../db/schema.ts";
import { llmReviews, mergeCandidates } from "../db/schema.ts";
import { toSqlDatetime } from "./auth/time.ts";
import type { LlmReviewSummary } from "../src/lib/api-types.ts";

export type ReviewStage = LlmReviewSummary["stage"];
export type ReviewStatus = "pending" | "succeeded" | "failed";

/** The `resolution` of a pair hidden by the review with this id. */
export const reviewResolution = (reviewId: number): string => `llm-review:${reviewId}`;

/**
 * A pair's key in `llm_reviews`: its QIDs ordered by number, so the same two
 * items key the same row whichever direction the candidate runs.
 */
export function pairKey(a: string, b: string): { qidLow: string; qidHigh: string } {
  const n = (qid: string) => Number(qid.slice(1));
  return n(a) <= n(b) ? { qidLow: a, qidHigh: b } : { qidLow: b, qidHigh: a };
}

/**
 * Move an open candidate to `auto_dismissed`, pointing at the confirming
 * review. Only an `open` pair moves (the check is in the UPDATE itself), so a
 * human's merge, dismissal or in-flight edit always wins over the job. No
 * `resolved_by`: no human was involved, and the leaderboard never credits it.
 * Returns whether the pair was hidden.
 */
export async function hidePair(
  db: MySql2Database<typeof schema>,
  candidateId: number,
  confirmingReviewId: number,
): Promise<boolean> {
  const [result] = await db
    .update(mergeCandidates)
    .set({
      status: "auto_dismissed",
      resolvedAt: toSqlDatetime(new Date()),
      resolution: reviewResolution(confirmingReviewId),
      resolvedBy: null,
    })
    .where(and(eq(mergeCandidates.id, candidateId), eq(mergeCandidates.status, "open")));
  return result.affectedRows > 0;
}

/** A pair's succeeded reviews, first pass before confirmation. */
export async function loadPairReviews(
  db: MySql2Database<typeof schema>,
  a: string,
  b: string,
): Promise<LlmReviewSummary[]> {
  const { qidLow, qidHigh } = pairKey(a, b);
  const rows = await db
    .select({
      id: llmReviews.id,
      stage: llmReviews.stage,
      model: llmReviews.model,
      verdict: llmReviews.verdict,
      probability: llmReviews.probability,
      rationale: llmReviews.rationale,
      completedAt: llmReviews.completedAt,
    })
    .from(llmReviews)
    .where(
      and(
        eq(llmReviews.qidLow, qidLow),
        eq(llmReviews.qidHigh, qidHigh),
        eq(llmReviews.status, "succeeded"),
      ),
    )
    .orderBy(asc(llmReviews.id));
  return rows
    .filter((r) => r.verdict !== null && r.probability !== null)
    .map((r) => ({
      ...r,
      stage: r.stage as ReviewStage,
      verdict: r.verdict as LlmReviewSummary["verdict"],
      probability: r.probability!,
      rationale: r.rationale ?? "",
    }))
    .sort((x, y) => (x.stage === y.stage ? 0 : x.stage === "first_pass" ? -1 : 1));
}
