// POST /api/hunt — manually kick off the duplicate-candidate hunt.
//
// This is the same thing `crons/hunt-candidates.ts` does on a schedule: enqueue
// a single "scan" kickoff message. The heavy blocking/scoring/upserting all
// happens in `queues/hunt-candidates.ts`, so this handler returns immediately;
// candidates show up in `merge_candidates` (and the list) as the queue drains.
import { defineHandler } from "void";
import { queues } from "void/queues";
import type { HuntTriggerResponse } from "../../src/lib/api-types";

export const POST = defineHandler(async () => {
  await queues["hunt-candidates"].send({ kind: "scan" });
  const payload: HuntTriggerResponse = {
    enqueued: true,
    message: "Hunt started. New candidates appear as the queue processes them.",
  };
  return payload;
});
