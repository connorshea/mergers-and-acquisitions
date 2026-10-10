// The monthly Claude review of open candidates (#292). Haiku reviews every
// open pair that has never had a review; Opus reviews only the pairs Haiku
// called "different"; a pair Opus also calls "different" with a probability
// under LLM_CONFIRM_MAX_P is hidden as `auto_dismissed`. A wrong "same" costs
// nothing (the pair stays open), so only "different" is ever escalated.
//
// Three scheduled jobs (jobs.yaml), none of which sits waiting on the API:
//
//   first-pass  1st of the month: send Haiku every open pair with no review yet
//   confirm     2nd: collect Haiku's answers, send Opus the "different" pairs
//   collect     hourly on the 1st to 3rd: write back whatever batches have
//               ended, hiding the pairs Opus confirms; a no-op otherwise
//
// A batch ends within 24 h (most within the hour), so the confirm run a day
// after the first pass finds Haiku's answers in, and the hourly collect picks
// up each batch soon after it ends; a missed run catches up within the API's
// 29-day result window. A pair is reviewed once per stage: it's never re-sent
// unless its review failed (up to MAX_ATTEMPTS). Spending stops at
// LLM_MONTHLY_BUDGET_USD, and if the API refuses for lack of credit or the
// workspace spend limit, the run stops cleanly and the pairs it didn't send
// wait for next month.
//
// Nothing here edits Wikidata or changes a pair's score; the only write
// outside `llm_reviews` is hidePair's `open → auto_dismissed`.
import Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import type * as schema from "../db/schema.ts";
import { items, llmReviews, mergeCandidates } from "../db/schema.ts";
import type { Item } from "../src/lib/compare.ts";
import { chunk } from "../src/lib/chunk.ts";
import {
  MAX_PROMPT_TOKENS,
  outputTokenBudget,
  PROMPT_VERSION,
  REVIEW_MODELS,
  type ReviewModel,
  renderPair,
  reviewRequest,
} from "../src/lib/llm-review.ts";
import { toSqlDatetime } from "./auth/time.ts";
import {
  cachedPromptTokens,
  countPromptTokens,
  isOutOfCredit,
  loadLabelLookup,
  toRecord,
} from "./llm-batch.ts";
import { hidePair, pairKey, type ReviewStage } from "./llm-reviews.ts";
import { attachSitelinkRedirects } from "./sitelink-overlay.ts";

type Db = MySql2Database<typeof schema>;

export const STAGE_MODEL: Record<ReviewStage, ReviewModel> = {
  first_pass: "claude-haiku-5-5",
  confirmation: "claude-opus-5-5",
};

/** Submissions per pair and stage before a failing review is given up on. */
export const MAX_ATTEMPTS = 3;
/**
 * What one batch may hold. The API takes up to 100,000 requests or 256 MB;
 * these stay well under both, and the byte cap also bounds the request body
 * the SDK builds in memory. A typical request is ~20 KB with the system
 * prompt, so the request cap usually binds first, but a pair near
 * MAX_PROMPT_TOKENS runs to hundreds of KB.
 */
export const BATCH_LIMITS = { requests: 5000, bytes: 100 * 1024 * 1024 };
/** Pairs rendered at a time, to bound the items held in memory. */
const RENDER_CHUNK = 500;
const ID_CHUNK = 1000;
/** Results written back per UPDATE. */
const WRITE_CHUNK = 500;
/** How often `--wait` checks on running batches. */
const POLL_MS = 60_000;
/** How long a new batch may 404 while the API catches up. */
const NEW_BATCH_GRACE_MS = 10 * 60_000;
/** How long a claim may sit without a batch before it's taken for a crashed run's. */
const STALE_CLAIM_MS = 60 * 60_000;

/**
 * The expected cost of one request, until a model has MIN_COST_SAMPLES stored
 * reviews to average: the means from the 500-pair production trial.
 */
const TRIAL_MEAN_COST_USD: Partial<Record<ReviewModel, number>> = {
  "claude-haiku-5-5": 0.00012,
  "claude-opus-5-5": 0.0037,
};
const MIN_COST_SAMPLES = 200;
/**
 * The budget counts each request at its model's mean cost times this. The
 * per-pair cap bounds a single request, but planning for every request to hit
 * it would let Opus confirm only ~4,000 pairs on $200 when the trial puts the
 * whole queue at ~$117; the workspace spend limit is the hard stop.
 */
const COST_MARGIN = 1.5;

export interface ReviewConfig {
  /** LLM_MONTHLY_BUDGET_USD: both models' spend in a calendar month (UTC). */
  budgetUsd: number;
  /** LLM_MAX_PAIRS_PER_RUN: requests one run may submit. */
  maxPairs: number;
  /** LLM_CONFIRM_MAX_P: Opus must say "different" with a probability under this to hide. */
  confirmMaxP: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ReviewConfig {
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  return {
    budgetUsd: num("LLM_MONTHLY_BUDGET_USD", 200),
    maxPairs: num("LLM_MAX_PAIRS_PER_RUN", 60_000),
    confirmMaxP: num("LLM_CONFIRM_MAX_P", 0.1),
  };
}

// ---------- the API ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type BatchRequest = { custom_id: string; params: ReturnType<typeof reviewRequest> };

/** The few Message Batches calls the job makes; tests pass a fake. */
export interface ReviewApi {
  /** A pair's exact prompt tokens on `model` (count_tokens, free). */
  countTokens(model: ReviewModel, text: string): Promise<number>;
  /** The tokens up to the cache breakpoint: the system prompt. */
  cachedTokens(): Promise<number>;
  /**
   * Create a batch. It must not retry once the API may have taken the request:
   * see createdUnknown.
   */
  createBatch(requests: BatchRequest[]): Promise<string>;
  /** Whether the batch has ended; null when the API doesn't know it. */
  batchEnded(batchId: string): Promise<boolean | null>;
  /** The batch's results; throws ResultsGone when the API no longer has them. */
  batchResults(batchId: string): AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>;
}

/** The API has no results for a batch: it never had it, or they've expired. */
export class ResultsGone extends Error {}

/**
 * Whether a failed createBatch may still have made the batch: the connection
 * dropped or timed out, or the server failed after reading the body. A 4xx,
 * a 529 (overloaded) or any other error means the API refused it.
 */
export function createdUnknown(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  return err instanceof Anthropic.APIError && (err.status ?? 0) >= 500 && err.status !== 529;
}

const CREATE_ATTEMPTS = 5;

export function anthropicApi(client = new Anthropic({ maxRetries: 5 })): ReviewApi {
  return {
    countTokens: (model, text) => countPromptTokens(client, model, text),
    cachedTokens: () => cachedPromptTokens(client),
    async createBatch(requests) {
      // The SDK's own retries would re-send a body the API may already have
      // made a batch of, so only the refusals that say it didn't are retried.
      for (let attempt = 1; ; attempt++) {
        try {
          return (await client.messages.batches.create({ requests }, { maxRetries: 0 })).id;
        } catch (err) {
          const refused =
            err instanceof Anthropic.RateLimitError ||
            (err instanceof Anthropic.APIError && err.status === 529);
          if (!refused || attempt === CREATE_ATTEMPTS) throw err;
          await sleep(30_000 * attempt);
        }
      }
    },
    async batchEnded(batchId) {
      try {
        const batch = await client.messages.batches.retrieve(batchId);
        return batch.processing_status === "ended";
      } catch (err) {
        if (err instanceof Anthropic.NotFoundError) return null;
        throw err;
      }
    },
    async *batchResults(batchId) {
      try {
        yield* await client.messages.batches.results(batchId);
      } catch (err) {
        if (err instanceof Anthropic.NotFoundError) throw new ResultsGone(err.message);
        throw err;
      }
    },
  };
}

// ---------- spend ----------

const monthStart = (now: Date): string =>
  toSqlDatetime(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));

/**
 * What one request on `model` is budgeted at: its mean stored cost, with the
 * margin. Failed reviews count too: one cut off at max_tokens is among the
 * dearest.
 */
async function expectedCost(db: Db, model: ReviewModel): Promise<number> {
  const [row] = await db
    .select({ mean: sql<number | null>`avg(${llmReviews.costUsd})`, n: sql<number>`count(*)` })
    .from(llmReviews)
    .where(
      and(
        eq(llmReviews.model, model),
        inArray(llmReviews.status, ["succeeded", "failed"]),
        isNotNull(llmReviews.costUsd),
      ),
    );
  const mean =
    Number(row.n) >= MIN_COST_SAMPLES && row.mean !== null
      ? Number(row.mean)
      : (TRIAL_MEAN_COST_USD[model] ?? REVIEW_MODELS[model].output / 1000);
  return mean * COST_MARGIN;
}

/**
 * This month's spend: what the reviews completed since the 1st cost, plus
 * the expected cost of every request still in a batch.
 */
async function monthSpend(db: Db, now: Date): Promise<number> {
  const [done] = await db
    .select({ usd: sql<number | null>`sum(${llmReviews.costUsd})` })
    .from(llmReviews)
    .where(gte(llmReviews.completedAt, monthStart(now)));
  let usd = Number(done.usd ?? 0);
  const pending = await db
    .select({ model: llmReviews.model, n: sql<number>`count(*)` })
    .from(llmReviews)
    .where(eq(llmReviews.status, "pending"))
    .groupBy(llmReviews.model);
  for (const p of pending) usd += Number(p.n) * (await expectedCost(db, p.model as ReviewModel));
  return usd;
}

// ---------- picking pairs ----------

interface Pick {
  qidLow: string;
  qidHigh: string;
  /** The candidate's direction, which the prompt follows (from = newer). */
  fromQid: string;
  intoQid: string;
  /** The failed review row this retries, if any. */
  retry?: { id: number };
  /** On a confirmation, the first pass it checks and what its prompt came to. */
  confirms?: {
    id: number;
    promptTokens: number | null;
    lowRevid: number | null;
    highRevid: number | null;
  };
}

const keyOf = (qidLow: string, qidHigh: string) => `${qidLow} ${qidHigh}`;

/** Each open pair once, lowest heuristic confidence first, in the direction of its first candidate. */
async function openPairs(db: Db) {
  const rows = await db
    .select({ fromQid: mergeCandidates.fromQid, intoQid: mergeCandidates.intoQid })
    .from(mergeCandidates)
    .where(eq(mergeCandidates.status, "open"))
    .orderBy(asc(mergeCandidates.confidence), asc(mergeCandidates.id));
  const pairs = new Map<string, { fromQid: string; intoQid: string }>();
  for (const r of rows) {
    const { qidLow, qidHigh } = pairKey(r.fromQid, r.intoQid);
    const key = keyOf(qidLow, qidHigh);
    if (!pairs.has(key)) pairs.set(key, r);
  }
  return pairs;
}

/** A stage's existing rows, by pair. */
async function stageRows(db: Db, stage: ReviewStage) {
  const rows = await db
    .select({
      id: llmReviews.id,
      qidLow: llmReviews.qidLow,
      qidHigh: llmReviews.qidHigh,
      status: llmReviews.status,
      attempts: llmReviews.attempts,
    })
    .from(llmReviews)
    .where(eq(llmReviews.stage, stage));
  return new Map(rows.map((r) => [keyOf(r.qidLow, r.qidHigh), r]));
}

/** Whether a pair needs this stage: no row yet, or a failed one with attempts left. */
function needs(row: { status: string; attempts: number } | undefined): boolean {
  return !row || (row.status === "failed" && row.attempts < MAX_ATTEMPTS);
}

/** Open pairs Haiku hasn't reviewed, lowest heuristic confidence first. */
export async function firstPassPicks(db: Db): Promise<Pick[]> {
  const existing = await stageRows(db, "first_pass");
  const picks: Pick[] = [];
  for (const [key, c] of await openPairs(db)) {
    const row = existing.get(key);
    if (!needs(row)) continue;
    picks.push({ ...pairKey(c.fromQid, c.intoQid), ...c, retry: row && { id: row.id } });
  }
  return picks;
}

/**
 * Pairs still open that Haiku called "different", at any probability, and
 * Opus hasn't confirmed or refused. Haiku's most confident first, so a budget
 * stop leaves the likeliest-to-hide pairs done.
 */
export async function confirmPicks(db: Db): Promise<Pick[]> {
  const firstPasses = await db
    .select({
      id: llmReviews.id,
      qidLow: llmReviews.qidLow,
      qidHigh: llmReviews.qidHigh,
      inputTokens: llmReviews.inputTokens,
      cacheCreation: llmReviews.cacheCreationInputTokens,
      cacheRead: llmReviews.cacheReadInputTokens,
      lowRevid: llmReviews.lowRevid,
      highRevid: llmReviews.highRevid,
    })
    .from(llmReviews)
    .where(
      and(
        eq(llmReviews.stage, "first_pass"),
        eq(llmReviews.status, "succeeded"),
        eq(llmReviews.verdict, "different"),
      ),
    )
    .orderBy(asc(llmReviews.probability), asc(llmReviews.id));
  const open = await openPairs(db);
  const existing = await stageRows(db, "confirmation");
  const picks: Pick[] = [];
  for (const fp of firstPasses) {
    const key = keyOf(fp.qidLow, fp.qidHigh);
    const c = open.get(key);
    const row = existing.get(key);
    if (!c || !needs(row)) continue;
    picks.push({
      qidLow: fp.qidLow,
      qidHigh: fp.qidHigh,
      ...c,
      retry: row && { id: row.id },
      confirms: {
        id: fp.id,
        promptTokens:
          fp.inputTokens === null
            ? null
            : fp.inputTokens + (fp.cacheCreation ?? 0) + (fp.cacheRead ?? 0),
        lowRevid: fp.lowRevid,
        highRevid: fp.highRevid,
      },
    });
  }
  return picks;
}

// ---------- rendering ----------

interface Rendered {
  text: string;
  lowRevid: number | null;
  highRevid: number | null;
}

/** Each pick's prompt, as the detail page shows the items; null when an item is gone from the mirror. */
async function renderPicks(db: Db, picks: Pick[]): Promise<(Rendered | null)[]> {
  const qids = [...new Set(picks.flatMap((p) => [p.fromQid, p.intoQid]))];
  const byQid = new Map<string, { data: Item; revid: number | null }>();
  for (const ids of chunk(qids, ID_CHUNK)) {
    const rows = await db
      .select({ qid: items.qid, data: items.data, revid: items.sourceRevid })
      .from(items)
      .where(inArray(items.qid, ids));
    for (const r of rows) byQid.set(r.qid, { data: r.data as Item, revid: r.revid });
  }
  const found = picks.filter((p) => byQid.has(p.fromQid) && byQid.has(p.intoQid));
  // Each pair gets its own copies, since the overlay mutates them.
  const itemPairs = found.map((p): [Item, Item] => [
    structuredClone(byQid.get(p.fromQid)!.data),
    structuredClone(byQid.get(p.intoQid)!.data),
  ]);
  await attachSitelinkRedirects(db, itemPairs);
  const labelOf = await loadLabelLookup(db, itemPairs.flat());
  const texts = new Map(found.map((p, i) => [p, renderPair(...itemPairs[i], labelOf)]));
  return picks.map((p) => {
    const text = texts.get(p);
    if (text === undefined) return null;
    return {
      text,
      lowRevid: byQid.get(p.qidLow)!.revid,
      highRevid: byQid.get(p.qidHigh)!.revid,
    };
  });
}

/**
 * A request's prompt tokens, calling count_tokens only when it matters. A
 * token is at least a byte, so the cached system prompt plus the pair's
 * UTF-8 length bounds the prompt from above: for Haiku, whose per-pair cap
 * never binds under MAX_PROMPT_TOKENS, that's enough unless the bound passes
 * it. Opus's max_tokens does depend on the prompt, so it gets the exact count:
 * the first pass's, when both items are at the revisions Haiku saw (the two
 * models count alike), otherwise count_tokens.
 */
async function promptTokensFor(
  api: ReviewApi,
  model: ReviewModel,
  pick: Pick,
  rendered: Rendered,
  cached: number,
): Promise<number> {
  const fp = pick.confirms;
  if (
    fp?.promptTokens != null &&
    fp.lowRevid !== null &&
    fp.highRevid !== null &&
    fp.lowRevid === rendered.lowRevid &&
    fp.highRevid === rendered.highRevid
  ) {
    return fp.promptTokens;
  }
  const bound = cached + Buffer.byteLength(rendered.text);
  if (model === "claude-haiku-5-5" && bound <= MAX_PROMPT_TOKENS) return bound;
  return api.countTokens(model, rendered.text);
}

// ---------- claim, submit, release ----------

/** The request's custom_id: unique per pair and stage, like the row it writes back to. */
const customIdOf = (p: Pick, stage: ReviewStage): string =>
  `${p.qidLow}_${p.qidHigh}_${stage === "first_pass" ? "f" : "c"}`;

interface Claim {
  pick: Pick;
  customId: string;
  rendered: Rendered;
}

/**
 * Insert (or, for a retry, reset) the `pending` rows before the batch exists,
 * so a crash between the two leaves a claim the next run can see rather than
 * a batch nobody collects. The unique key stops two runs claiming one pair.
 */
async function claim(db: Db, stage: ReviewStage, claims: Claim[], now: Date): Promise<void> {
  const model = STAGE_MODEL[stage];
  const values = (c: Claim) => ({
    stage,
    model,
    effort: REVIEW_MODELS[model].defaultEffort,
    promptVersion: PROMPT_VERSION,
    confirms: c.pick.confirms?.id ?? null,
    lowRevid: c.rendered.lowRevid,
    highRevid: c.rendered.highRevid,
    customId: c.customId,
    batchId: null,
    // When this attempt was claimed, so a fresh batch's 404 grace starts now.
    createdAt: toSqlDatetime(now),
  });
  const fresh = claims.filter((c) => !c.pick.retry);
  for (const part of chunk(fresh, ID_CHUNK)) {
    await db
      .insert(llmReviews)
      .values(part.map((c) => ({ ...values(c), qidLow: c.pick.qidLow, qidHigh: c.pick.qidHigh })));
  }
  // A retry's row keeps what earlier attempts cost this month, which the next
  // result adds to (an earlier month's is already spent there); the rest of
  // the last attempt's outcome goes.
  for (const c of claims.filter((c) => c.pick.retry)) {
    await db
      .update(llmReviews)
      .set({
        ...values(c),
        status: "pending",
        attempts: sql`${llmReviews.attempts} + 1`,
        costUsd: sql`case when ${llmReviews.completedAt} >= ${monthStart(now)} then ${llmReviews.costUsd} end`,
        verdict: null,
        probability: null,
        rationale: null,
        error: null,
        inputTokens: null,
        outputTokens: null,
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
      })
      .where(and(eq(llmReviews.id, c.pick.retry!.id), eq(llmReviews.status, "failed")));
  }
}

/** Undo claims whose batch was never created: drop new rows, return retries to `failed`. */
async function release(db: Db, customIds: string[]): Promise<void> {
  for (const ids of chunk(customIds, ID_CHUNK)) {
    const unsent = and(
      inArray(llmReviews.customId, ids),
      eq(llmReviews.status, "pending"),
      isNull(llmReviews.batchId),
    );
    await db.delete(llmReviews).where(and(unsent, eq(llmReviews.attempts, 1)));
    await db
      .update(llmReviews)
      .set({ status: "failed", attempts: sql`${llmReviews.attempts} - 1` })
      .where(unsent);
  }
}

interface SubmitResult {
  /** Pairs that needed the stage. */
  needed: number;
  submitted: number;
  /** Left for next month by the budget or LLM_MAX_PAIRS_PER_RUN. */
  deferred: number;
  skipped: { missingItem: number; tooLong: number; overCap: number };
}

async function submitStage(
  db: Db,
  api: ReviewApi,
  config: ReviewConfig,
  stage: ReviewStage,
  picks: Pick[],
  log: (line: string) => void,
  now: () => Date,
  limits: typeof BATCH_LIMITS,
): Promise<SubmitResult> {
  const model = STAGE_MODEL[stage];
  const effort = REVIEW_MODELS[model].defaultEffort;
  const perRequest = await expectedCost(db, model);
  const spent = await monthSpend(db, now());
  const affordable = Math.max(0, Math.floor((config.budgetUsd - spent) / perRequest));
  // Requests this run may send; pairs skipped below don't use one up.
  const limit = Math.min(config.maxPairs, affordable);
  const result: SubmitResult = {
    needed: picks.length,
    submitted: 0,
    deferred: 0,
    skipped: { missingItem: 0, tooLong: 0, overCap: 0 },
  };
  log(
    `${model}: ${picks.length} pairs need a ${stage}; month's spend so far $${spent.toFixed(2)} ` +
      `of $${config.budgetUsd}, budgeting $${perRequest.toFixed(5)} a request`,
  );

  const cached = limit > 0 && picks.length > 0 ? await api.cachedTokens() : 0;
  let requests: BatchRequest[] = [];
  let claims: Claim[] = [];
  let bytes = 0;
  const flush = async () => {
    if (requests.length === 0) return;
    await claim(db, stage, claims, now());
    const customIds = claims.map((c) => c.customId);
    let batchId: string;
    try {
      batchId = await api.createBatch(requests);
    } catch (err) {
      // When the batch may exist, keep the claims: re-sending would pay
      // twice, and collect fails them as "never submitted" once they're stale.
      if (createdUnknown(err)) {
        log(`${model}: batch creation failed in a way that may have made it; keeping its claims`);
      } else {
        await release(db, customIds);
      }
      throw err;
    }
    for (const ids of chunk(customIds, ID_CHUNK)) {
      await db
        .update(llmReviews)
        .set({ batchId })
        .where(
          and(
            inArray(llmReviews.customId, ids),
            eq(llmReviews.status, "pending"),
            isNull(llmReviews.batchId),
          ),
        );
    }
    result.submitted += requests.length;
    log(
      `${model}: batch ${batchId}, ${requests.length} requests, ${(bytes / 1024 / 1024).toFixed(1)} MB`,
    );
    requests = [];
    claims = [];
    bytes = 0;
  };

  let accepted = 0;
  let reached = 0;
  while (reached < picks.length && accepted < limit) {
    // Render only as many as could still be sent, so most of a chunk is used.
    const part = picks.slice(reached, reached + Math.min(RENDER_CHUNK, limit - accepted));
    reached += part.length;
    const rendered = await renderPicks(db, part);
    for (const [i, pick] of part.entries()) {
      const r = rendered[i];
      if (!r) {
        result.skipped.missingItem++;
        continue;
      }
      const tokens = await promptTokensFor(api, model, pick, r, cached);
      if (tokens > MAX_PROMPT_TOKENS) {
        result.skipped.tooLong++;
        continue;
      }
      const maxTokens = outputTokenBudget(model, tokens, cached);
      if (maxTokens === null) {
        result.skipped.overCap++;
        continue;
      }
      const customId = customIdOf(pick, stage);
      const request = {
        custom_id: customId,
        params: reviewRequest(model, effort, r.text, maxTokens),
      };
      // Its share of the batch's JSON body, plus a comma.
      const size = Buffer.byteLength(JSON.stringify(request)) + 1;
      if (requests.length >= limits.requests || bytes + size > limits.bytes) await flush();
      requests.push(request);
      claims.push({ pick, customId, rendered: r });
      bytes += size;
      accepted++;
    }
  }
  await flush();
  result.deferred = picks.length - reached;
  if (result.deferred > 0) {
    const why = affordable < config.maxPairs ? "the monthly budget" : "LLM_MAX_PAIRS_PER_RUN";
    log(`${model}: ${result.deferred} pairs left for next month by ${why}`);
  }
  const { missingItem, tooLong, overCap } = result.skipped;
  if (missingItem + tooLong + overCap > 0) {
    log(
      `${model}: skipped ${missingItem} with an item missing from the mirror, ` +
        `${tooLong} over ${MAX_PROMPT_TOKENS} prompt tokens, ${overCap} over the per-pair cap`,
    );
  }
  return result;
}

// ---------- collect ----------

interface CollectResult {
  /** Batches not yet ended when collect returned. */
  running: number;
  succeeded: number;
  failed: number;
  /** Verdict counts per stage, from the results written this time. */
  verdicts: Record<ReviewStage, Record<string, number>>;
  /** Failures by reason. */
  errors: Record<string, number>;
  hidden: number;
  costUsd: number;
}

/**
 * Write back every ended batch's results, hiding the pairs Opus confirms.
 * With `wait`, keep polling until no batch is left running.
 */
export async function collect(
  db: Db,
  api: ReviewApi,
  config: ReviewConfig,
  opts: { wait: boolean; log?: (line: string) => void; now?: () => Date; pollMs?: number },
): Promise<CollectResult> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? (() => new Date());
  const result: CollectResult = {
    running: 0,
    succeeded: 0,
    failed: 0,
    verdicts: { first_pass: {}, confirmation: {} },
    errors: {},
    hidden: 0,
    costUsd: 0,
  };
  const fail = async (where: ReturnType<typeof and>, error: string) => {
    const [res] = await db
      .update(llmReviews)
      .set({ status: "failed", error, completedAt: toSqlDatetime(now()) })
      .where(and(where, eq(llmReviews.status, "pending")));
    if (res.affectedRows > 0) {
      result.failed += res.affectedRows;
      result.errors[error] = (result.errors[error] ?? 0) + res.affectedRows;
    }
  };

  // A claim whose batch was never recorded belongs to a run that died between
  // claiming and creating it: nothing is coming back for it.
  const stale = toSqlDatetime(new Date(now().getTime() - STALE_CLAIM_MS));
  await fail(and(isNull(llmReviews.batchId), lt(llmReviews.createdAt, stale)), "never submitted");

  for (;;) {
    const batches = await db
      .select({ batchId: llmReviews.batchId, claimedAt: sql<string>`min(${llmReviews.createdAt})` })
      .from(llmReviews)
      .where(and(eq(llmReviews.status, "pending"), isNotNull(llmReviews.batchId)))
      .groupBy(llmReviews.batchId);
    result.running = 0;
    for (const { batchId, claimedAt } of batches) {
      const ended = await api.batchEnded(batchId!);
      if (ended === null) {
        const age = now().getTime() - Date.parse(`${claimedAt.replace(" ", "T")}Z`);
        if (age < NEW_BATCH_GRACE_MS) result.running++;
        else await fail(eq(llmReviews.batchId, batchId!), "batch not found");
      } else if (!ended) {
        result.running++;
      } else {
        try {
          await writeResults(db, api, config, batchId!, result, now);
        } catch (err) {
          // One unreadable batch mustn't stop the others, or the run's submit.
          if (err instanceof ResultsGone) {
            await fail(eq(llmReviews.batchId, batchId!), "results gone");
          } else {
            log(
              `batch ${batchId}: couldn't read its results (${(err as Error).message}); next collect tries again`,
            );
          }
        }
      }
    }
    if (result.running === 0 || !opts.wait) break;
    log(`waiting on ${result.running} batch${result.running === 1 ? "" : "es"}…`);
    await sleep(opts.pollMs ?? POLL_MS);
  }

  for (const stage of ["first_pass", "confirmation"] as const) {
    const v = result.verdicts[stage];
    const total = Object.values(v).reduce((s, n) => s + n, 0);
    if (total === 0) continue;
    log(
      `${STAGE_MODEL[stage]}: ${total} answers: ${v.same ?? 0} same, ` +
        `${v.different ?? 0} different (${Math.round((100 * (v.different ?? 0)) / total)}%), ${v.unsure ?? 0} unsure`,
    );
  }
  if (result.failed > 0) {
    log(
      `${result.failed} failed: ${Object.entries(result.errors)
        .map(([e, n]) => `${n} ${e}`)
        .join(", ")}`,
    );
  }
  if (result.succeeded + result.failed > 0) {
    log(`collected $${result.costUsd.toFixed(2)}; ${result.hidden} pairs hidden`);
  }
  return result;
}

async function writeResults(
  db: Db,
  api: ReviewApi,
  config: ReviewConfig,
  batchId: string,
  result: CollectResult,
  now: () => Date,
): Promise<void> {
  const rows = await db
    .select({
      id: llmReviews.id,
      stage: llmReviews.stage,
      model: llmReviews.model,
      customId: llmReviews.customId,
      qidLow: llmReviews.qidLow,
      qidHigh: llmReviews.qidHigh,
    })
    .from(llmReviews)
    .where(and(eq(llmReviews.batchId, batchId), eq(llmReviews.status, "pending")));
  const byCustomId = new Map(rows.map((r) => [r.customId, r]));

  // Results come in any order; each is matched to its row by custom_id, and
  // written WRITE_CHUNK at a time.
  type Row = (typeof rows)[number];
  let buffer: { row: Row; record: ReturnType<typeof toRecord> }[] = [];
  const flush = async () => {
    if (buffer.length === 0) return;
    const part = buffer;
    buffer = [];
    // Another collect running over the same batch may have written some of
    // these since; the rows still pending now are the ones this run writes
    // (and counts), and the status guard below keeps the rest as they are.
    const pending = new Set(
      (
        await db
          .select({ id: llmReviews.id })
          .from(llmReviews)
          .where(
            and(
              inArray(
                llmReviews.id,
                part.map((p) => p.row.id),
              ),
              eq(llmReviews.status, "pending"),
            ),
          )
      ).map((r) => r.id),
    );
    const mine = part.filter((p) => pending.has(p.row.id));
    if (mine.length === 0) return;
    // One UPDATE for the chunk: each column a CASE on the row's id.
    const byId = (value: (p: (typeof mine)[number]) => unknown) =>
      sql`case ${llmReviews.id} ${sql.join(
        mine.map((p) => sql`when ${p.row.id} then ${value(p)}`),
        sql` `,
      )} end`;
    await db
      .update(llmReviews)
      .set({
        status: byId((p) => (p.record.review ? "succeeded" : "failed")),
        verdict: byId((p) => p.record.review?.verdict ?? null),
        probability: byId((p) => p.record.review?.probability ?? null),
        rationale: byId((p) => p.record.review?.rationale ?? null),
        error: byId((p) => p.record.error?.slice(0, 255) ?? null),
        inputTokens: byId((p) => p.record.usage?.input_tokens ?? null),
        outputTokens: byId((p) => p.record.usage?.output_tokens ?? null),
        cacheCreationInputTokens: byId((p) => p.record.usage?.cache_creation_input_tokens ?? null),
        cacheReadInputTokens: byId((p) => p.record.usage?.cache_read_input_tokens ?? null),
        // Plus what earlier attempts this month cost (see claim).
        costUsd: sql`coalesce(${llmReviews.costUsd}, 0) + ${byId((p) => p.record.costUsd)}`,
        completedAt: toSqlDatetime(now()),
      })
      .where(
        and(
          inArray(
            llmReviews.id,
            mine.map((p) => p.row.id),
          ),
          eq(llmReviews.status, "pending"),
        ),
      );
    for (const { row, record } of mine) {
      const review = record.review;
      result.costUsd += record.costUsd;
      if (!review) {
        result.failed++;
        result.errors[record.error!] = (result.errors[record.error!] ?? 0) + 1;
        continue;
      }
      result.succeeded++;
      const stage = row.stage as ReviewStage;
      result.verdicts[stage][review.verdict] = (result.verdicts[stage][review.verdict] ?? 0) + 1;
      if (
        stage === "confirmation" &&
        review.verdict === "different" &&
        review.probability < config.confirmMaxP
      ) {
        result.hidden += await hideOpenCandidates(db, row.qidLow, row.qidHigh, row.id);
      }
    }
  };
  try {
    for await (const response of api.batchResults(batchId)) {
      const row = byCustomId.get(response.custom_id);
      if (!row) continue;
      byCustomId.delete(response.custom_id);
      buffer.push({ row, record: toRecord(row.model as ReviewModel, response) });
      if (buffer.length >= WRITE_CHUNK) await flush();
    }
  } catch (err) {
    // Keep the results already read when the stream breaks off.
    await flush();
    throw err;
  }
  await flush();

  // An ended batch has a result for every request; anything left never got one.
  const missing = [...byCustomId.values()].map((r) => r.id);
  for (const ids of chunk(missing, ID_CHUNK)) {
    const [res] = await db
      .update(llmReviews)
      .set({ status: "failed", error: "no result", completedAt: toSqlDatetime(now()) })
      .where(and(inArray(llmReviews.id, ids), eq(llmReviews.status, "pending")));
    result.failed += res.affectedRows;
    result.errors["no result"] = (result.errors["no result"] ?? 0) + res.affectedRows;
  }
}

/** Hide every candidate still open on the pair, whichever way it runs. */
async function hideOpenCandidates(
  db: Db,
  qidLow: string,
  qidHigh: string,
  reviewId: number,
): Promise<number> {
  const rows = await db
    .select({ id: mergeCandidates.id })
    .from(mergeCandidates)
    .where(
      and(
        eq(mergeCandidates.status, "open"),
        or(
          and(eq(mergeCandidates.fromQid, qidLow), eq(mergeCandidates.intoQid, qidHigh)),
          and(eq(mergeCandidates.fromQid, qidHigh), eq(mergeCandidates.intoQid, qidLow)),
        ),
      ),
    );
  let hidden = 0;
  for (const { id } of rows) if (await hidePair(db, id, reviewId)) hidden++;
  return hidden;
}

// ---------- the two runs ----------

export interface RunResult {
  submit: SubmitResult | null;
  /** The API refused for lack of credit or the spend limit; the run stopped there. */
  outOfCredit: boolean;
}

/**
 * One scheduled run of `stage`: collect whatever has ended, then submit the
 * pairs that need the stage. With `wait` (by hand, and in tests) it also
 * polls until its own batches end and collects them; scheduled, it returns
 * and leaves that to the collect job.
 */
export async function runStage(
  db: Db,
  api: ReviewApi,
  config: ReviewConfig,
  stage: ReviewStage,
  opts: {
    wait: boolean;
    log?: (line: string) => void;
    now?: () => Date;
    pollMs?: number;
    batchLimits?: typeof BATCH_LIMITS;
  },
): Promise<RunResult> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? (() => new Date());
  try {
    await collect(db, api, config, { ...opts, wait: false });
    if (stage === "confirmation") {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)` })
        .from(llmReviews)
        .where(and(eq(llmReviews.stage, "first_pass"), eq(llmReviews.status, "pending")));
      if (Number(n) > 0) log(`${n} first passes still running; their pairs wait for next month`);
    }
    const picks = stage === "first_pass" ? await firstPassPicks(db) : await confirmPicks(db);
    const submit = await submitStage(
      db,
      api,
      config,
      stage,
      picks,
      log,
      now,
      opts.batchLimits ?? BATCH_LIMITS,
    );
    if (opts.wait && submit.submitted > 0) await collect(db, api, config, opts);
    log(`month's spend so far $${(await monthSpend(db, now())).toFixed(2)}`);
    return { submit, outOfCredit: false };
  } catch (err) {
    if (!isOutOfCredit(err)) throw err;
    log(
      `Stopped: the API refused for lack of credit or the workspace spend limit ` +
        `(${(err as Error).message}). Pairs not yet sent wait for next month's run.`,
    );
    return { submit: null, outOfCredit: true };
  }
}
