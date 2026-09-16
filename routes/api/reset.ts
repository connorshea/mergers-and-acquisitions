// POST /api/reset — clear all found merge candidates so the hunt can run from
// scratch. Deletes every row in `merge_candidates` (including dismissed/merged
// ones, so a fresh hunt re-evaluates every pair). Leaves `items` /
// `external_ids` intact — those come from the (expensive) sync/seed, not the
// hunt. Destructive; the client guards it behind a confirmation dialog.
import { count, db } from "void/db";
import { mergeCandidates } from "@schema";
import { defineHandler } from "void";
import type { ResetResponse } from "../../src/lib/api-types";

export const POST = defineHandler(async () => {
  const [{ n }] = await db.select({ n: count() }).from(mergeCandidates);
  await db.delete(mergeCandidates);
  const payload: ResetResponse = { deleted: n };
  return payload;
});
