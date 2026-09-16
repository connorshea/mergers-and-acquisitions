// Schedules the duplicate-candidate hunt.
//
// The cron only *enqueues* a single "scan" kickoff message; all the real work —
// blocking, scoring, and upserting into `merge_candidates` — happens in
// `queues/hunt-candidates.ts`. Keeping the cron a thin enqueuer means the
// scheduled invocation itself stays well within Worker CPU/subrequest limits and
// the heavy work runs (and retries) on the queue. See that file's header for the
// full scan/score design.

import { defineScheduled } from "void";
import { queues } from "void/queues";

// Nightly at 03:00 UTC — well clear of the Wikidata sync so items are settled
// before we hunt over them.
export const cron = "0 3 * * *";

export default defineScheduled(async () => {
  await queues["hunt-candidates"].send({ kind: "scan" });
  console.log("hunt-candidates: enqueued scan");
});
