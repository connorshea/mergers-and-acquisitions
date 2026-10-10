// Integration tests for the monthly Claude review job against a real MariaDB,
// with a fake Message Batches API. Opt-in via DB_TEST=1 — see
// test/global-setup.ts.
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { itemSync, items, llmReviews, mergeCandidates } from "../db/schema.ts";
import type { Review, ReviewModel } from "../src/lib/llm-review.ts";
import {
  collect,
  MAX_ATTEMPTS,
  ResultsGone,
  type ReviewApi,
  type ReviewConfig,
  runStage,
} from "./llm-review-job.ts";
import { pairKey, reviewResolution } from "./llm-reviews.ts";
import { DB_TEST, insertItem, makeItem, truncateAll } from "../test/db-helpers.ts";

type Requests = Parameters<ReviewApi["createBatch"]>[0];
type Response = Anthropic.Messages.MessageBatchIndividualResponse;
/** A request's answer: a review, or a whole result to return as-is. */
type Answer = Review | Response["result"];

const USAGE = {
  input_tokens: 900,
  output_tokens: 200,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 2100,
};

/** The Batches API, in memory: batches end when told to, and results come back reversed. */
class FakeApi implements ReviewApi {
  batches = new Map<string, { requests: Requests; ended: boolean }>();
  /** What each request answers, by model and custom_id; "different", p = 0.3 by default. */
  answer: (model: ReviewModel, customId: string) => Answer | undefined = () => undefined;
  createError: unknown = null;
  /** Leave batches running instead of ending them as soon as they're created. */
  hold = false;
  counted: string[] = [];

  async countTokens(_model: ReviewModel, text: string) {
    this.counted.push(text);
    return 3000;
  }
  async cachedTokens() {
    return 2100;
  }
  async createBatch(requests: Requests) {
    if (this.createError) throw this.createError;
    const id = `batch_${this.batches.size + 1}`;
    this.batches.set(id, { requests, ended: !this.hold });
    return id;
  }
  async batchEnded(batchId: string) {
    return this.batches.get(batchId)?.ended ?? null;
  }
  async *batchResults(batchId: string): AsyncIterable<Response> {
    for (const r of [...this.batches.get(batchId)!.requests].reverse()) {
      const answer = this.answer(r.params.model, r.custom_id) ?? {
        verdict: "different",
        probability: 0.3,
        rationale: "test",
      };
      yield {
        custom_id: r.custom_id,
        result:
          "type" in answer
            ? answer
            : {
                type: "succeeded",
                message: {
                  content: [{ type: "text", text: JSON.stringify(answer) }],
                  stop_reason: "end_turn",
                  usage: USAGE,
                },
              },
      } as unknown as Response;
    }
  }
  /** Every request sent, as [model, custom_id], in order. */
  sent(): [string, string][] {
    return [...this.batches.values()].flatMap((b) =>
      b.requests.map((r): [string, string] => [r.params.model, r.custom_id]),
    );
  }
}

const CONFIG: ReviewConfig = { budgetUsd: 200, maxPairs: 60_000, confirmMaxP: 0.1 };
const quiet = { wait: true, log: () => {}, pollMs: 0 };
const HAIKU = "claude-haiku-5-5";
const OPUS = "claude-opus-5-5";

async function candidate(from: string, into: string, confidence = 0.5, status = "open") {
  for (const qid of [from, into]) {
    if ((await db.select().from(items).where(eq(items.qid, qid))).length === 0) {
      await insertItem(makeItem(qid, "Alpha Quest"));
    }
  }
  const [{ id }] = await db
    .insert(mergeCandidates)
    .values({ fromQid: from, intoQid: into, confidence, reasons: [], status })
    .$returningId();
  return id;
}

type Row = typeof llmReviews.$inferInsert;
async function review(a: string, b: string, over: Partial<Row> = {}): Promise<number> {
  const [{ id }] = await db
    .insert(llmReviews)
    .values({
      ...pairKey(a, b),
      stage: "first_pass",
      status: "succeeded",
      model: HAIKU,
      effort: "medium",
      promptVersion: 3,
      verdict: "different",
      probability: 0.3,
      rationale: "earlier",
      costUsd: 0.0001,
      completedAt: "2026-09-01 00:00:00",
      ...over,
    })
    .$returningId();
  return id;
}

const rowsFor = (stage: string) =>
  db.select().from(llmReviews).where(eq(llmReviews.stage, stage)).orderBy(llmReviews.id);

const statusOf = async (id: number) =>
  (await db.select().from(mergeCandidates).where(eq(mergeCandidates.id, id)))[0];

describe.skipIf(!DB_TEST)("the monthly Claude review job", () => {
  let api: FakeApi;

  beforeEach(async () => {
    await truncateAll();
    api = new FakeApi();
  });

  afterAll(() => pool.end());

  it("sends Haiku each open, unreviewed pair once, lowest confidence first", async () => {
    await candidate("Q2", "Q1", 0.7);
    await candidate("Q4", "Q3", 0.5); // already reviewed
    await review("Q3", "Q4");
    await candidate("Q6", "Q5", 0.4, "dismissed"); // not open
    const forward = await candidate("Q8", "Q7", 0.45); // two candidates, one pair
    await candidate("Q7", "Q8", 0.9);

    const { submit } = await runStage(db, api, CONFIG, "first_pass", quiet);
    expect(api.sent()).toEqual([
      [HAIKU, "Q7_Q8_f"],
      [HAIKU, "Q1_Q2_f"],
    ]);
    expect(submit).toMatchObject({ needed: 2, submitted: 2, deferred: 0 });
    // Small prompts are bounded by their size, not counted.
    expect(api.counted).toEqual([]);

    const rows = await rowsFor("first_pass");
    expect(rows).toHaveLength(3);
    const q1 = rows.find((r) => r.qidLow === "Q1")!;
    expect(q1).toMatchObject({
      qidLow: "Q1",
      qidHigh: "Q2",
      status: "succeeded",
      verdict: "different",
      probability: 0.3,
      attempts: 1,
      batchId: "batch_1",
      inputTokens: 900,
      outputTokens: 200,
    });
    expect(q1.costUsd).toBeGreaterThan(0);
    // The prompt follows the first candidate's direction: from Q8 into Q7.
    const prompt = api.batches.get("batch_1")!.requests[0].params.messages[0].content;
    expect(prompt.indexOf("Item Q8")).toBeLessThan(prompt.indexOf("Item Q7"));
    // A first pass never hides anything, whatever it says.
    expect((await statusOf(forward)).status).toBe("open");

    // Nothing is left to send.
    const again = new FakeApi();
    await runStage(db, again, CONFIG, "first_pass", quiet);
    expect(again.sent()).toEqual([]);
  });

  it("sends Opus every Haiku 'different', at any probability, and nothing else", async () => {
    for (const [i, over] of [
      { probability: 0.6 },
      { probability: 0.02 },
      { verdict: "same", probability: 0.9 },
      { verdict: "unsure", probability: 0.5 },
      { status: "failed", verdict: null, probability: null },
    ].entries()) {
      const [a, b] = [`Q${10 + 2 * i}`, `Q${11 + 2 * i}`];
      await candidate(b, a);
      await review(a, b, over);
    }
    // Haiku said "different", but a human dismissed it since.
    await candidate("Q31", "Q30", 0.5, "dismissed");
    await review("Q30", "Q31", { probability: 0.01 });
    // Already confirmed.
    await candidate("Q33", "Q32");
    await review("Q32", "Q33", { probability: 0.05 });
    await review("Q32", "Q33", { stage: "confirmation", model: OPUS, verdict: "same" });

    api.answer = () => ({ verdict: "same", probability: 0.8, rationale: "no" });
    const { submit } = await runStage(db, api, CONFIG, "confirmation", quiet);
    expect(api.sent()).toEqual([
      [OPUS, "Q12_Q13_c"],
      [OPUS, "Q10_Q11_c"],
    ]);
    expect(submit?.needed).toBe(2);
    const confirmations = await rowsFor("confirmation");
    expect(confirmations).toHaveLength(3);
    const [haiku] = (await rowsFor("first_pass")).filter((r) => r.qidLow === "Q12");
    expect(confirmations.find((r) => r.qidLow === "Q12")).toMatchObject({
      model: OPUS,
      status: "succeeded",
      verdict: "same",
      confirms: haiku.id,
    });
  });

  it("confirms only first passes that have come back, without waiting on the rest", async () => {
    await candidate("Q2", "Q1");
    await candidate("Q4", "Q3");
    api.hold = true;
    const run = { ...quiet, wait: false };
    await runStage(db, api, CONFIG, "first_pass", run);

    const lines: string[] = [];
    await runStage(db, api, CONFIG, "confirmation", { ...run, log: (l) => lines.push(l) });
    expect(lines).toContain("2 first passes still running; their pairs wait for next month");
    expect(api.sent().filter(([model]) => model === OPUS)).toEqual([]);

    // Once the batch ends, the next collect and confirm pick them up.
    for (const batch of api.batches.values()) batch.ended = true;
    await collect(db, api, CONFIG, run);
    await runStage(db, api, CONFIG, "confirmation", run);
    expect(api.sent().filter(([model]) => model === OPUS)).toHaveLength(2);
  });

  it("reuses Haiku's prompt count for Opus only while both items are unchanged", async () => {
    await candidate("Q2", "Q1");
    await candidate("Q4", "Q3");
    await db.update(itemSync).set({ sourceRevid: 100 });
    const tokens = { inputTokens: 900, cacheReadInputTokens: 2100 };
    await review("Q1", "Q2", { ...tokens, lowRevid: 100, highRevid: 100 });
    await review("Q3", "Q4", { ...tokens, lowRevid: 100, highRevid: 99 }); // Q4 edited since

    await runStage(db, api, CONFIG, "confirmation", quiet);
    expect(api.counted).toHaveLength(1);
    expect(api.counted[0]).toContain("Item Q4");
  });

  it("counts Opus's prompt when either item's revision is unknown", async () => {
    await candidate("Q2", "Q1");
    await db.update(itemSync).set({ sourceRevid: 100 }).where(eq(itemSync.qid, "Q1"));
    await review("Q1", "Q2", { inputTokens: 900, lowRevid: 100, highRevid: null });

    await runStage(db, api, CONFIG, "confirmation", quiet);
    expect(api.counted).toHaveLength(1);
  });

  it("hides a pair only when Opus says 'different' under the cut-off, and only if still open", async () => {
    const pairs = {
      hide: [await candidate("Q2", "Q1"), await candidate("Q1", "Q2")],
      atCutoff: await candidate("Q4", "Q3"),
      same: await candidate("Q6", "Q5"),
      human: await candidate("Q8", "Q7"),
    };
    for (const [a, b] of [
      ["Q1", "Q2"],
      ["Q3", "Q4"],
      ["Q5", "Q6"],
      ["Q7", "Q8"],
    ]) {
      await review(a, b);
    }
    const answers: Record<string, Review> = {
      Q1_Q2_c: { verdict: "different", probability: 0.02, rationale: "two games" },
      Q3_Q4_c: { verdict: "different", probability: 0.1, rationale: "probably two" },
      Q5_Q6_c: { verdict: "same", probability: 0.9, rationale: "one game" },
      Q7_Q8_c: { verdict: "different", probability: 0.01, rationale: "two games" },
    };
    api.answer = (_model, id) => answers[id];
    api.hold = true;
    await runStage(db, api, CONFIG, "confirmation", { ...quiet, wait: false });
    // A human dismisses one while Opus is still working on it.
    await db
      .update(mergeCandidates)
      .set({ status: "dismissed", resolution: "by hand" })
      .where(eq(mergeCandidates.id, pairs.human));

    for (const b of api.batches.values()) b.ended = true;
    const result = await collect(db, api, CONFIG, quiet);
    expect(result.hidden).toBe(2);

    const [confirmation] = await db
      .select({ id: llmReviews.id })
      .from(llmReviews)
      .where(eq(llmReviews.customId, "Q1_Q2_c"));
    for (const id of pairs.hide) {
      expect(await statusOf(id)).toMatchObject({
        status: "auto_dismissed",
        resolution: reviewResolution(confirmation.id),
        resolvedBy: null,
      });
    }
    expect((await statusOf(pairs.atCutoff)).status).toBe("open");
    expect((await statusOf(pairs.same)).status).toBe("open");
    expect(await statusOf(pairs.human)).toMatchObject({
      status: "dismissed",
      resolution: "by hand",
    });
  });

  it("stops at the monthly budget, counting this month's spend", async () => {
    for (let i = 0; i < 4; i++) await candidate(`Q${2 * i + 2}`, `Q${2 * i + 1}`, 0.4 + i / 10);
    // Spent this month already (last month's spend doesn't count).
    await review("Q100", "Q101", { costUsd: 0.0003, completedAt: "2026-10-01 00:00:00" });
    await review("Q102", "Q103", { costUsd: 5, completedAt: "2026-09-30 23:59:59" });
    const now = () => new Date("2026-10-01T06:00:00Z");

    // Haiku is budgeted at the trial's mean, $0.00012, plus half: $0.00018 a request.
    const config = { ...CONFIG, budgetUsd: 0.0003 + 0.0004 };
    const { submit } = await runStage(db, api, config, "first_pass", { ...quiet, now });
    expect(submit).toMatchObject({ needed: 4, submitted: 2, deferred: 2 });
    expect(api.sent().map(([, id]) => id)).toEqual(["Q1_Q2_f", "Q3_Q4_f"]);

    // LLM_MAX_PAIRS_PER_RUN caps a run too.
    const capped = new FakeApi();
    await runStage(db, capped, { ...CONFIG, maxPairs: 1 }, "first_pass", { ...quiet, now });
    expect(capped.sent().map(([, id]) => id)).toEqual(["Q5_Q6_f"]);
  });

  it("doesn't spend a run's slots on pairs it skips", async () => {
    await candidate("Q2", "Q1", 0.1);
    await db.delete(items).where(eq(items.qid, "Q1")); // gone from the mirror
    await candidate("Q4", "Q3", 0.2);
    await candidate("Q6", "Q5", 0.3);
    const lines: string[] = [];
    const { submit } = await runStage(db, api, { ...CONFIG, maxPairs: 1 }, "first_pass", {
      ...quiet,
      log: (l) => lines.push(l),
    });
    expect(api.sent().map(([, id]) => id)).toEqual(["Q3_Q4_f"]);
    expect(submit).toMatchObject({ submitted: 1, deferred: 1, skipped: { missingItem: 1 } });
    expect(lines).toContain(
      "claude-haiku-5-5: 1 pairs left for next month by LLM_MAX_PAIRS_PER_RUN",
    );
  });

  it("splits a run into batches by request count and by size", async () => {
    const pairs = async () => {
      await truncateAll();
      for (let i = 0; i < 5; i++) await candidate(`Q${2 * i + 2}`, `Q${2 * i + 1}`, 0.4 + i / 10);
    };
    await pairs();
    await runStage(db, api, CONFIG, "first_pass", {
      ...quiet,
      batchLimits: { requests: 2, bytes: 1e9 },
    });
    const batches = [...api.batches.values()].map((b) => b.requests);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    expect((await rowsFor("first_pass")).map((r) => r.status)).toEqual(Array(5).fill("succeeded"));

    // A cap that fits three of these requests, with their commas, but not four.
    const size = Math.max(...batches.flat().map((r) => Buffer.byteLength(JSON.stringify(r)) + 1));
    await pairs();
    const bySize = new FakeApi();
    await runStage(db, bySize, CONFIG, "first_pass", {
      ...quiet,
      batchLimits: { requests: 100, bytes: 3 * size },
    });
    const sized = [...bySize.batches.values()].map((b) => b.requests);
    expect(sized.map((b) => b.length)).toEqual([3, 2]);
    for (const b of sized)
      expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(3 * size);
  });

  it("releases its claims when the batch can't be created", async () => {
    await candidate("Q2", "Q1");
    await candidate("Q4", "Q3");
    await review("Q3", "Q4", { status: "failed", verdict: null, error: "stop_reason max_tokens" });

    api.createError = new Error("network down");
    await expect(runStage(db, api, CONFIG, "first_pass", quiet)).rejects.toThrow("network down");
    const rows = await rowsFor("first_pass");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ qidLow: "Q3", status: "failed", attempts: 1, batchId: null });
  });

  it("keeps its claims when the batch may have been made", async () => {
    await candidate("Q2", "Q1");
    api.createError = new Anthropic.APIConnectionTimeoutError();
    await expect(runStage(db, api, CONFIG, "first_pass", quiet)).rejects.toThrow("timed out");
    expect(await rowsFor("first_pass")).toMatchObject([{ status: "pending", batchId: null }]);
    // Nothing goes again this month while the claim stands.
    const again = new FakeApi();
    await runStage(db, again, CONFIG, "first_pass", quiet);
    expect(again.sent()).toEqual([]);
  });

  it("stops cleanly when the API is out of credit", async () => {
    await candidate("Q2", "Q1");
    await review("Q1", "Q2", { status: "failed", verdict: null, attempts: 2 });
    api.createError = Anthropic.APIError.generate(
      400,
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Your credit balance is too low to access the Anthropic API.",
        },
      },
      undefined,
      new Headers(),
    );
    const lines: string[] = [];
    const result = await runStage(db, api, CONFIG, "first_pass", {
      ...quiet,
      log: (l) => lines.push(l),
    });
    expect(result.outOfCredit).toBe(true);
    expect(lines.at(-1)).toMatch(/^Stopped: .*credit balance/);
    // The retry's claim is undone; next month tries again.
    expect(await rowsFor("first_pass")).toMatchObject([{ status: "failed", attempts: 2 }]);
  });

  it("records failed results, and retries a failed review until it runs out of attempts", async () => {
    for (let i = 0; i < 4; i++) await candidate(`Q${2 * i + 2}`, `Q${2 * i + 1}`, 0.4 + i / 10);
    api.answer = (_model, id) =>
      ({
        Q1_Q2_f: {
          type: "errored",
          error: { type: "error", error: { type: "billing_error", message: "no credit" } },
        },
        Q3_Q4_f: { type: "expired" },
      })[id] as Answer | undefined;
    // Q7_Q8_f gets no result at all.
    const batchResults = api.batchResults.bind(api);
    api.batchResults = async function* (batchId) {
      for await (const r of batchResults(batchId)) if (r.custom_id !== "Q7_Q8_f") yield r;
    };
    const result = await runStage(db, api, CONFIG, "first_pass", quiet);
    expect(result.submit?.submitted).toBe(4);
    expect(
      (await rowsFor("first_pass")).map((r) => [r.qidLow, r.status, r.error, r.attempts]),
    ).toEqual([
      ["Q1", "failed", "errored: billing_error", 1],
      ["Q3", "failed", "expired", 1],
      ["Q5", "succeeded", null, 1],
      ["Q7", "failed", "no result", 1],
    ]);

    // The failures go again on the next run, until MAX_ATTEMPTS.
    for (let attempt = 2; attempt <= MAX_ATTEMPTS + 1; attempt++) {
      const next = new FakeApi();
      next.answer = () => ({ type: "expired" }) as Answer;
      await runStage(db, next, CONFIG, "first_pass", quiet);
      expect(next.sent()).toHaveLength(attempt <= MAX_ATTEMPTS ? 3 : 0);
    }
    expect((await rowsFor("first_pass")).map((r) => r.attempts)).toEqual([3, 3, 1, 3]);
  });

  it("writes back a batch bigger than one write, each result to its own row", async () => {
    for (let i = 0; i < 501; i++) await candidate(`Q${2 * i + 2}`, `Q${2 * i + 1}`);
    // Every third pair "same", with its index as the probability's last digits.
    api.answer = (_model, id) => {
      const n = Number(id.split("_")[0].slice(1));
      return n % 3 === 0
        ? { verdict: "same", probability: 0.5 + n / 1e6, rationale: id }
        : { verdict: "different", probability: 0.2, rationale: id };
    };
    const result = await runStage(db, api, CONFIG, "first_pass", quiet);
    expect(result.submit?.submitted).toBe(501);
    const rows = await rowsFor("first_pass");
    expect(rows.every((r) => r.status === "succeeded")).toBe(true);
    for (const r of rows) {
      const n = Number(r.qidLow.slice(1));
      expect(r.rationale).toBe(`${r.qidLow}_${r.qidHigh}_f`);
      expect(r.verdict).toBe(n % 3 === 0 ? "same" : "different");
      expect(r.probability).toBeCloseTo(n % 3 === 0 ? 0.5 + n / 1e6 : 0.2, 9);
    }
  });

  it("adds a retry's cost to this month's earlier attempts, not last month's", async () => {
    await candidate("Q2", "Q1");
    await candidate("Q4", "Q3");
    const failed = { status: "failed", verdict: null, error: "stop_reason max_tokens" };
    await review("Q1", "Q2", { ...failed, costUsd: 0.04, completedAt: "2026-10-01 06:30:00" });
    await review("Q3", "Q4", { ...failed, costUsd: 0.04, completedAt: "2026-09-01 06:30:00" });
    const now = () => new Date("2026-10-01T08:00:00Z");
    await runStage(db, api, CONFIG, "first_pass", { ...quiet, now });

    const [thisMonth, lastMonth] = await rowsFor("first_pass");
    expect(thisMonth.status).toBe("succeeded");
    expect(thisMonth.costUsd! - lastMonth.costUsd!).toBeCloseTo(0.04);
    expect(lastMonth.costUsd).toBeLessThan(0.01);
  });

  it("fails a batch whose results are gone, and goes on to the rest", async () => {
    await candidate("Q2", "Q1");
    await candidate("Q4", "Q3");
    api.hold = true;
    await runStage(db, api, CONFIG, "first_pass", {
      ...quiet,
      wait: false,
      batchLimits: { requests: 1, bytes: 1e9 },
    });
    for (const b of api.batches.values()) b.ended = true;
    const batchResults = api.batchResults.bind(api);
    api.batchResults = async function* (batchId) {
      if (batchId === "batch_1") throw new ResultsGone("expired");
      yield* batchResults(batchId);
    };
    const result = await collect(db, api, CONFIG, quiet);
    expect(result).toMatchObject({ succeeded: 1, errors: { "results gone": 1 } });
  });

  it("fails a batch the API has lost, and a claim no batch was ever recorded for", async () => {
    await candidate("Q2", "Q1");
    await candidate("Q4", "Q3");
    await review("Q1", "Q2", {
      status: "pending",
      verdict: null,
      batchId: "batch_gone",
      createdAt: "2026-10-01 00:00:00",
    });
    await review("Q3", "Q4", {
      status: "pending",
      verdict: null,
      createdAt: "2026-10-01 00:00:00",
    });
    const result = await collect(db, api, CONFIG, {
      ...quiet,
      now: () => new Date("2026-10-01T03:00:00Z"),
    });
    expect(result.errors).toEqual({ "batch not found": 1, "never submitted": 1 });
    expect((await rowsFor("first_pass")).map((r) => r.status)).toEqual(["failed", "failed"]);
  });
});
