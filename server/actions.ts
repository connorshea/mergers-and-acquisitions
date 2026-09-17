// Router for the maintenance actions: POST /api/hunt (kick off the duplicate
// hunt) and POST /api/reset (clear all found candidates).
import { Hono } from "hono";
import { count } from "drizzle-orm";
import { db } from "./db";
import { mergeCandidates } from "../db/schema";
import { runHunt } from "./hunt";
import type { HuntTriggerResponse, ResetResponse } from "../src/lib/api-types";

// The Void version enqueued a Cloudflare-Queues message and returned at once.
// Here we start the hunt in the background and return immediately, preserving
// that async UX (the client refetches shortly after). A module-level guard keeps
// a double-click from launching two concurrent full scans.
let huntRunning = false;

export const actions = new Hono();

actions.post("/hunt", (c) => {
  const alreadyRunning = huntRunning;
  if (!huntRunning) {
    huntRunning = true;
    runHunt()
      .then((s) => console.log(`hunt: done — ${s.upserted} upserted, ${s.deleted} deleted`))
      .catch((err) => console.error("hunt: failed", err))
      .finally(() => {
        huntRunning = false;
      });
  }

  const payload: HuntTriggerResponse = {
    enqueued: true,
    message: alreadyRunning
      ? "A hunt is already running. New candidates appear as it processes pairs."
      : "Hunt started. New candidates appear as it processes pairs.",
  };
  return c.json(payload);
});

// POST /api/reset — delete every merge candidate (including dismissed/merged)
// so the hunt can re-evaluate every pair from scratch. Leaves items/external_ids
// intact — those come from the (expensive) sync/seed. Destructive; the client
// guards it behind a confirmation dialog.
actions.post("/reset", async (c) => {
  const [{ n }] = await db.select({ n: count() }).from(mergeCandidates);
  await db.delete(mergeCandidates);
  const payload: ResetResponse = { deleted: n };
  return c.json(payload);
});
