// The Anthropic SDK and database side of the Claude review
// (src/lib/llm-review.ts stays SDK-free): counting a request's prompt tokens,
// turning a batch result into a stored record, and naming the properties and
// items a prompt mentions. Shared by the calibration (scripts/eval-llm.ts),
// the production trial (jobs/llm-trial.ts) and the review job
// (server/llm-review-job.ts), so all of them count and parse alike.
import Anthropic from "@anthropic-ai/sdk";
import { inArray } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import type * as schema from "../db/schema.ts";
import { entityLabels, properties } from "../db/schema.ts";
import type { Item } from "../src/lib/compare.ts";
import { chunk } from "../src/lib/chunk.ts";
import {
  costUsd,
  type LabelLookup,
  parseReview,
  REVIEW_MODELS,
  type Review,
  type ReviewModel,
  referencedIds,
  reviewRequest,
  type TokenUsage,
} from "../src/lib/llm-review.ts";

export interface ResultRecord {
  pair: string;
  model: ReviewModel;
  review: Review | null;
  /** Why there's no review: an API error, a refusal, an unparseable answer. */
  error?: string;
  usage?: TokenUsage;
  costUsd: number;
}

/** A pair's exact prompt tokens on `model`, from count_tokens (free). */
export async function countPromptTokens(
  client: Anthropic,
  model: ReviewModel,
  text: string,
): Promise<number> {
  const req = reviewRequest(model, REVIEW_MODELS[model].defaultEffort, text);
  const { input_tokens } = await client.messages.countTokens({
    model,
    system: req.system,
    messages: req.messages,
    output_config: req.output_config,
  });
  return input_tokens;
}

/**
 * The tokens up to the cache breakpoint: the system prompt, counted with a
 * one-character pair so it slightly overstates (the safe side for the cap).
 */
export function cachedPromptTokens(client: Anthropic): Promise<number> {
  return countPromptTokens(client, "claude-haiku-5-5", "-");
}

/** One batch result as a record: the review, or why there isn't one. */
export function toRecord(
  model: ReviewModel,
  result: Anthropic.Messages.MessageBatchIndividualResponse,
): ResultRecord {
  const base = { pair: result.custom_id, model };
  if (result.result.type !== "succeeded") {
    const error =
      result.result.type === "errored"
        ? `errored: ${result.result.error.error.type}`
        : result.result.type;
    return { ...base, review: null, error, costUsd: 0 };
  }
  const message = result.result.message;
  const usage: TokenUsage = {
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
    cache_read_input_tokens: message.usage.cache_read_input_tokens,
  };
  const cost = costUsd(model, usage, true);
  if (message.stop_reason !== "end_turn") {
    return {
      ...base,
      review: null,
      error: `stop_reason ${message.stop_reason}`,
      usage,
      costUsd: cost,
    };
  }
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const review = parseReview(text);
  return review
    ? { ...base, review, usage, costUsd: cost }
    : { ...base, review: null, error: "unparseable answer", usage, costUsd: cost };
}

/**
 * Whether an API error means the account can't pay for more requests: out of
 * prepaid credit, or over the workspace's spend limit in the Console. The
 * review job stops cleanly on these rather than failing; the next month's run
 * picks up where it left off.
 */
export function isOutOfCredit(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  if (err.status === 402 || err.type === "billing_error") return true;
  return /credit balance|usage limit|spend limit/i.test(err.message);
}

const ID_CHUNK = 1000;

/**
 * Labels for every property and value item the items name: inline labels
 * first (the dump import keeps some on the values), then the synced
 * `properties` and `entity_labels` tables.
 */
export async function loadLabelLookup(
  db: MySql2Database<typeof schema>,
  all: Item[],
): Promise<LabelLookup> {
  const labels = new Map<string, string>();
  const pids = new Set<string>();
  const qids = new Set<string>();
  for (const item of all) {
    const refs = referencedIds(item);
    for (const pid of refs.pids) pids.add(pid);
    for (const qid of refs.qids) qids.add(qid);
    for (const values of Object.values(item.statements)) {
      for (const v of values) {
        if (v.type === "item" && v.label) labels.set(v.value, v.label);
        if (v.unit && v.unitLabel) labels.set(v.unit, v.unitLabel);
      }
    }
  }
  for (const ids of chunk([...pids], ID_CHUNK)) {
    const rows = await db
      .select({ pid: properties.pid, label: properties.label })
      .from(properties)
      .where(inArray(properties.pid, ids));
    for (const r of rows) labels.set(r.pid, r.label);
  }
  const missing = [...qids].filter((q) => !labels.has(q));
  for (const ids of chunk(missing, ID_CHUNK)) {
    const rows = await db
      .select({ qid: entityLabels.qid, label: entityLabels.label })
      .from(entityLabels)
      .where(inArray(entityLabels.qid, ids));
    for (const r of rows) labels.set(r.qid, r.label);
  }
  return (id) => labels.get(id);
}
