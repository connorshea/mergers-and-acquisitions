// POST /api/candidates/:id/dismiss — mark a candidate dismissed and stamp
// resolvedAt. Returns the updated summary; 404 if the candidate doesn't exist.
import { db, eq } from "void/db";
import { mergeCandidates } from "@schema";
import { defineHandler } from "void";
import { type CandidateSummary, loadLabels, summaryColumns, toSummary } from "../index";

export interface CandidateDismissResponse {
  candidate: CandidateSummary;
}

export const POST = defineHandler(async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }

  const [row] = await db
    .update(mergeCandidates)
    .set({ status: "dismissed", resolvedAt: new Date().toISOString() })
    .where(eq(mergeCandidates.id, id))
    .returning(summaryColumns);

  if (!row) {
    return c.json({ error: "Candidate not found" }, 404);
  }

  const labels = await loadLabels([row.fromQid, row.intoQid]);
  const payload: CandidateDismissResponse = { candidate: toSummary(row, labels) };
  return payload;
});
