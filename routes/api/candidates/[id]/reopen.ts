// POST /api/candidates/:id/reopen — un-dismiss a candidate, returning it to
// `open` and clearing the resolution stamp. Returns the updated summary; 404 if
// the candidate doesn't exist.
import { db, eq } from "void/db";
import { mergeCandidates } from "@schema";
import { defineHandler } from "void";
import type { CandidateReopenResponse } from "../../../../src/lib/api-types";
import { loadLabels, summaryColumns, toSummary } from "../index";

export const POST = defineHandler(async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) {
    return c.json({ error: "Invalid candidate id" }, 404);
  }

  const [row] = await db
    .update(mergeCandidates)
    .set({ status: "open", resolvedAt: null, resolution: null })
    .where(eq(mergeCandidates.id, id))
    .returning(summaryColumns);

  if (!row) {
    return c.json({ error: "Candidate not found" }, 404);
  }

  const labels = await loadLabels([row.fromQid, row.intoQid]);
  const payload: CandidateReopenResponse = { candidate: toSummary(row, labels) };
  return payload;
});
