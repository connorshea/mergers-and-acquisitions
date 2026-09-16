// GET /api/candidates/:id — one candidate with both items' full data, ready to
// feed straight into the comparison view.
import { and, asc, db, desc, eq, gt, inArray, lt, or } from "void/db";
import { entityLabels, itemDescriptions, items, mergeCandidates, properties } from "@schema";
import { defineHandler } from "void";
import type { Item } from "../../../src/lib/compare";
import { chunk, D1_MAX_BOUND_PARAMS } from "../../../src/lib/chunk";
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
  // Item-valued statements reference other Qids that need a display label too
  // (genre, platform, developer, …). Collect them from both items' statements.
  const valueQids = new Set<string>();
  for (const item of [from, into]) {
    for (const values of Object.values(item.statements)) {
      for (const v of values) {
        if (v.type === "item" && !v.label) valueQids.add(v.value);
      }
    }
  }

  // Chunk both lookups under D1's 100-bound-parameter cap: a statement-rich pair
  // can reference more than 100 property ids or item-value qids.
  const idChunk = D1_MAX_BOUND_PARAMS - 10;
  const [propertyChunks, valueChunks, descRows] = await Promise.all([
    Promise.all(
      chunk(pids, idChunk).map((ids) =>
        db
          .select({
            pid: properties.pid,
            label: properties.label,
            formatterUrl: properties.formatterUrl,
          })
          .from(properties)
          .where(inArray(properties.pid, ids)),
      ),
    ),
    Promise.all(
      chunk([...valueQids], idChunk).map((ids) =>
        db
          .select({ qid: entityLabels.qid, label: entityLabels.label })
          .from(entityLabels)
          .where(inArray(entityLabels.qid, ids)),
      ),
    ),
    db
      .select({ qid: itemDescriptions.qid, description: itemDescriptions.description })
      .from(itemDescriptions)
      .where(inArray(itemDescriptions.qid, [...new Set([row.fromQid, row.intoQid])])),
  ]);

  const propertyLabels: Record<string, string> = {};
  const propertyFormatters: Record<string, string> = {};
  for (const r of propertyChunks.flat()) {
    propertyLabels[r.pid] = r.label;
    if (r.formatterUrl) propertyFormatters[r.pid] = r.formatterUrl;
  }
  const valueLabels: Record<string, string> = {};
  for (const r of valueChunks.flat()) valueLabels[r.qid] = r.label;

  // The dump omits descriptions; backfill the synced English description onto
  // each item so the comparison view shows it under the name and treats a
  // conflicting description as a merge blocker. Never overwrite one already set.
  const descByQid = new Map(descRows.map((r) => [r.qid, r.description]));
  for (const item of [from, into]) {
    const desc = descByQid.get(item.id);
    if (desc && !item.descriptions.en) item.descriptions = { ...item.descriptions, en: desc };
  }

  const payload: CandidateDetailResponse = {
    candidate: toSummary(row, labels),
    from,
    into,
    propertyLabels,
    propertyFormatters,
    valueLabels,
    prevId: prevRows[0]?.id ?? null,
    nextId: nextRows[0]?.id ?? null,
  };
  return payload;
});
