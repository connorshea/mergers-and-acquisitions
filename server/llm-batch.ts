// The Anthropic SDK side of the Claude review (src/lib/llm-review.ts stays
// SDK-free): counting a request's prompt tokens and turning a batch result
// into a stored record. Shared by the calibration (scripts/eval-llm.ts) and
// the production trial (jobs/llm-trial.ts), so both count and parse alike.
import Anthropic from "@anthropic-ai/sdk";
import {
  costUsd,
  parseReview,
  REVIEW_MODELS,
  type Review,
  type ReviewModel,
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
