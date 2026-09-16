// GET /api/candidates/:id — one candidate with both items' full data, ready to
// feed straight into the comparison view.
import { and, asc, db, desc, eq, gt, inArray, lt, or } from "void/db";
import { items, mergeCandidates, properties } from "@schema";
import { defineHandler } from "void";
import type { Item } from "../../../src/lib/compare";
import type { CandidateDetailResponse } from "../../../src/lib/api-types";
import { loadLabels, summaryColumns, toSummary } from "./index";

export const GET = defineHandler(async (c) => {
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
  // "next" is the following pair in that order, "prev" the preceding one.
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
  // never synced). We can't render a comparison without both, so treat a
  // missing item as a 404 with a message naming the absent qid.
  if (!from || !into) {
    const missing = [!from && row.fromQid, !into && row.intoQid].filter(Boolean).join(", ");
    return c.json({ error: `Item data missing for: ${missing}` }, 404);
  }

  // Resolve human labels for just the property ids present on this pair, so the
  // comparison view shows names instead of bare Pxxx. Missing rows (unsynced
  // properties) simply fall back to the id client-side.
  const pids = [...new Set([...Object.keys(from.statements), ...Object.keys(into.statements)])];
  const propertyLabels: Record<string, string> = {};
  if (pids.length > 0) {
    const labelRows = await db
      .select({ pid: properties.pid, label: properties.label })
      .from(properties)
      .where(inArray(properties.pid, pids));
    for (const r of labelRows) propertyLabels[r.pid] = r.label;
  }

  const payload: CandidateDetailResponse = {
    candidate: toSummary(row, labels),
    from,
    into,
    propertyLabels,
    prevId: prevRows[0]?.id ?? null,
    nextId: nextRows[0]?.id ?? null,
  };
  return payload;
});
