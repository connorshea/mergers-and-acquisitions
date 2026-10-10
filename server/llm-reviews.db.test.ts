// Integration tests for stored Claude reviews and the `auto_dismissed` status
// against a real MariaDB. Opt-in via DB_TEST=1 — see test/global-setup.ts.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { app } from "./app.ts";
import { db, pool } from "./db.ts";
import { llmReviews, mergeCandidates } from "../db/schema.ts";
import { hidePair, pairKey, reviewResolution } from "./llm-reviews.ts";
import type {
  CandidateDetailResponse,
  CandidateListResponse,
  CandidateReopenResponse,
  LeaderboardResponse,
} from "../src/lib/api-types.ts";
import { DB_TEST, insertItem, loginAs, makeItem, truncateAll } from "../test/db-helpers.ts";

async function get<T>(path: string): Promise<T> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

type Review = typeof llmReviews.$inferInsert;
const review = (stage: "first_pass" | "confirmation", over: Partial<Review> = {}): Review => ({
  ...pairKey("Q20", "Q10"),
  stage,
  status: "succeeded",
  model: stage === "first_pass" ? "claude-haiku-5-5" : "claude-opus-5-5",
  effort: "medium",
  promptVersion: 3,
  verdict: "different",
  probability: 0.03,
  rationale: `${stage} rationale`,
  completedAt: "2026-10-01 00:00:00",
  ...over,
});

/** Drizzle's wrapper around MariaDB's duplicate-key error. */
const DUPLICATE = { cause: { code: "ER_DUP_ENTRY" } };

async function insertReview(values: Review): Promise<number> {
  const [{ id }] = await db.insert(llmReviews).values(values).$returningId();
  return id;
}

const statusOf = async (id: number) =>
  (
    await db
      .select({ status: mergeCandidates.status })
      .from(mergeCandidates)
      .where(eq(mergeCandidates.id, id))
  )[0]?.status;

describe.skipIf(!DB_TEST)("llm_reviews and auto_dismissed", () => {
  let pair: number; // Q20 -> Q10, open

  beforeEach(async () => {
    await truncateAll();
    await insertItem(makeItem("Q10", "Alpha Quest"));
    await insertItem(makeItem("Q20", "Alpha Quest"));
    [{ id: pair }] = await db
      .insert(mergeCandidates)
      .values({ fromQid: "Q20", intoQid: "Q10", confidence: 0.5, reasons: [] })
      .$returningId();
  });

  afterAll(() => pool.end());

  it("allows one review per pair and stage, whichever way the pair runs", async () => {
    await insertReview(review("first_pass"));
    await insertReview(review("confirmation"));
    // Same pair, same stage, other direction and another model: still a duplicate.
    await expect(
      insertReview(review("first_pass", { ...pairKey("Q10", "Q20"), model: "claude-opus-5-5" })),
    ).rejects.toMatchObject(DUPLICATE);
    await expect(insertReview(review("confirmation"))).rejects.toMatchObject(DUPLICATE);
    // Another pair is its own key.
    await insertReview(review("first_pass", pairKey("Q10", "Q30")));
    expect(await db.select().from(llmReviews)).toHaveLength(3);
  });

  it("hides only an open pair, with no human credited", async () => {
    const confirmation = await insertReview(review("confirmation"));
    expect(await hidePair(db, pair, confirmation)).toBe(true);
    const [row] = await db.select().from(mergeCandidates).where(eq(mergeCandidates.id, pair));
    expect(row).toMatchObject({
      status: "auto_dismissed",
      resolvedBy: null,
      resolution: reviewResolution(confirmation),
    });
    expect(row.resolvedAt).not.toBeNull();

    // A human's resolution always wins: nothing but `open` moves.
    for (const status of ["dismissed", "merged", "merging"]) {
      await db.update(mergeCandidates).set({ status }).where(eq(mergeCandidates.id, pair));
      expect(await hidePair(db, pair, confirmation)).toBe(false);
      expect(await statusOf(pair)).toBe(status);
    }
  });

  it("leaves the open list, and is listed under its own status", async () => {
    await hidePair(db, pair, await insertReview(review("confirmation")));
    expect((await get<CandidateListResponse>("/api/candidates")).total).toBe(0);
    const hidden = await get<CandidateListResponse>("/api/candidates?status=auto_dismissed");
    expect(hidden.candidates.map((c) => c.id)).toEqual([pair]);
  });

  it("shows the reviews on a hidden pair's detail, and only there", async () => {
    await insertReview(review("first_pass", { probability: 0.1 }));
    await insertReview(review("confirmation"));
    // A failed review has no answer to show.
    await insertReview(
      review("first_pass", {
        ...pairKey("Q10", "Q30"),
        status: "failed",
        verdict: null,
        probability: null,
      }),
    );

    const open = await get<CandidateDetailResponse>(`/api/candidates/${pair}`);
    expect(open.llmReviews).toEqual([]);

    const [confirmation] = await db
      .select({ id: llmReviews.id })
      .from(llmReviews)
      .where(eq(llmReviews.stage, "confirmation"));
    await hidePair(db, pair, confirmation.id);
    const hidden = await get<CandidateDetailResponse>(`/api/candidates/${pair}`);
    expect(hidden.llmReviews).toMatchObject([
      { stage: "first_pass", model: "claude-haiku-5-5", verdict: "different", probability: 0.1 },
      { stage: "confirmation", model: "claude-opus-5-5", verdict: "different", probability: 0.03 },
    ]);
    expect(hidden.llmReviews[1].rationale).toBe("confirmation rationale");
  });

  it("can be reopened, keeping its reviews so it's never queued again", async () => {
    await insertReview(review("first_pass"));
    await hidePair(db, pair, await insertReview(review("confirmation")));
    const editor = await loginAs(7, "Editor");
    const res = await app.request(`/api/candidates/${pair}/reopen`, {
      method: "POST",
      headers: editor,
    });
    expect(res.status).toBe(200);
    const { candidate } = (await res.json()) as CandidateReopenResponse;
    expect(candidate).toMatchObject({ status: "open", resolution: null, resolvedBy: null });
    expect(await db.select().from(llmReviews)).toHaveLength(2);
    // Open again, it doesn't show them.
    expect((await get<CandidateDetailResponse>(`/api/candidates/${pair}`)).llmReviews).toEqual([]);
  });

  it("never counts on the leaderboard", async () => {
    await hidePair(db, pair, await insertReview(review("confirmation")));
    const { entries, totals } = await get<LeaderboardResponse>("/api/leaderboard");
    expect(entries).toEqual([]);
    expect(totals).toMatchObject({ dismissals: 0, total: 0 });
  });
});
