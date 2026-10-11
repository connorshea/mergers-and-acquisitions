// Unit tests for the Claude review job's config and its Message Batches
// client, with a fake Anthropic client and no database.
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { anthropicApi, configFromEnv, createdUnknown, ResultsGone } from "./llm-review-job.ts";

/** An SDK error of the class the API would raise for `status`. */
const apiError = (status: number) =>
  Anthropic.APIError.generate(
    status,
    { type: "error", error: { type: "api_error", message: `HTTP ${status}` } },
    `HTTP ${status}`,
    new Headers(),
  );

type Batches = Anthropic["messages"]["batches"];
type Create = (body: unknown, options: unknown) => Promise<{ id: string }>;
type Retrieve = (id: string) => Promise<{ processing_status: string }>;
type Results = (id: string) => Promise<AsyncIterable<unknown>>;
function fakeClient(batches: Partial<Record<keyof Batches, unknown>>): Anthropic {
  return { messages: { batches } } as unknown as Anthropic;
}

describe("configFromEnv", () => {
  it("uses the defaults when a variable is unset or empty", () => {
    expect(configFromEnv({ LLM_MAX_PAIRS_PER_RUN: "" })).toEqual({
      budgetUsd: 200,
      maxPairs: 60_000,
      confirmMaxP: 0.1,
    });
  });

  it("reads each variable as a number", () => {
    expect(
      configFromEnv({
        LLM_MONTHLY_BUDGET_USD: "12.5",
        LLM_MAX_PAIRS_PER_RUN: "0",
        LLM_CONFIRM_MAX_P: "0.05",
      }),
    ).toEqual({ budgetUsd: 12.5, maxPairs: 0, confirmMaxP: 0.05 });
  });

  it("rejects a negative or non-numeric value", () => {
    expect(() => configFromEnv({ LLM_MONTHLY_BUDGET_USD: "-1" })).toThrow(
      "LLM_MONTHLY_BUDGET_USD must be a non-negative number",
    );
    expect(() => configFromEnv({ LLM_MAX_PAIRS_PER_RUN: "lots" })).toThrow(
      "LLM_MAX_PAIRS_PER_RUN must be a non-negative number",
    );
    expect(() => configFromEnv({ LLM_CONFIRM_MAX_P: "Infinity" })).toThrow(
      "LLM_CONFIRM_MAX_P must be a non-negative number",
    );
  });
});

describe("createdUnknown", () => {
  it("is true only when the API may have taken the request", () => {
    expect(createdUnknown(new Anthropic.APIConnectionError({ message: "reset" }))).toBe(true);
    expect(createdUnknown(new Anthropic.APIConnectionTimeoutError())).toBe(true);
    expect(createdUnknown(apiError(500))).toBe(true);
    expect(createdUnknown(apiError(503))).toBe(true);
    expect(createdUnknown(apiError(529))).toBe(false);
    expect(createdUnknown(apiError(429))).toBe(false);
    expect(createdUnknown(apiError(400))).toBe(false);
    expect(createdUnknown(new Error("bug"))).toBe(false);
  });
});

describe("anthropicApi", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createBatch", () => {
    it("retries a refusal (429, 529) with backoff, never with the SDK's own retries", async () => {
      vi.useFakeTimers();
      const create = vi
        .fn<Create>()
        .mockRejectedValueOnce(apiError(429))
        .mockRejectedValueOnce(apiError(529))
        .mockResolvedValueOnce({ id: "batch_1" });
      const api = anthropicApi(fakeClient({ create }));
      const created = api.createBatch([]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(create).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await created).toBe("batch_1");
      expect(create).toHaveBeenCalledTimes(3);
      for (const [, options] of create.mock.calls) expect(options).toEqual({ maxRetries: 0 });
    });

    it("never retries an error after which the batch may exist", async () => {
      const err = apiError(500);
      const create = vi.fn<Create>().mockRejectedValue(err);
      await expect(anthropicApi(fakeClient({ create })).createBatch([])).rejects.toBe(err);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("gives up after five refusals", async () => {
      vi.useFakeTimers();
      const err = apiError(529);
      const create = vi.fn<Create>().mockRejectedValue(err);
      const created = anthropicApi(fakeClient({ create })).createBatch([]);
      const failed = created.catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      expect(await failed).toBe(err);
      expect(create).toHaveBeenCalledTimes(5);
    });
  });

  describe("batchEnded", () => {
    it("reports whether the batch has ended, and null for one the API doesn't know", async () => {
      const retrieve = vi
        .fn<Retrieve>()
        .mockResolvedValueOnce({ processing_status: "ended" })
        .mockResolvedValueOnce({ processing_status: "in_progress" })
        .mockRejectedValueOnce(apiError(404));
      const api = anthropicApi(fakeClient({ retrieve }));
      expect(await api.batchEnded("b")).toBe(true);
      expect(await api.batchEnded("b")).toBe(false);
      expect(await api.batchEnded("b")).toBeNull();
    });

    it("passes any other error on", async () => {
      const err = apiError(500);
      const api = anthropicApi(fakeClient({ retrieve: vi.fn<Retrieve>().mockRejectedValue(err) }));
      await expect(api.batchEnded("b")).rejects.toBe(err);
    });
  });

  describe("batchResults", () => {
    const drain = async (results: AsyncIterable<unknown>) => {
      const out: unknown[] = [];
      for await (const r of results) out.push(r);
      return out;
    };

    it("yields each result", async () => {
      async function* rows() {
        yield { custom_id: "a" };
        yield { custom_id: "b" };
      }
      const api = anthropicApi(fakeClient({ results: vi.fn<Results>().mockResolvedValue(rows()) }));
      expect(await drain(api.batchResults("b"))).toEqual([{ custom_id: "a" }, { custom_id: "b" }]);
    });

    it("throws ResultsGone when the API no longer has the results", async () => {
      const api = anthropicApi(
        fakeClient({ results: vi.fn<Results>().mockRejectedValue(apiError(404)) }),
      );
      await expect(drain(api.batchResults("b"))).rejects.toBeInstanceOf(ResultsGone);
    });

    it("passes any other error on", async () => {
      const err = apiError(500);
      const api = anthropicApi(fakeClient({ results: vi.fn<Results>().mockRejectedValue(err) }));
      await expect(drain(api.batchResults("b"))).rejects.toBe(err);
    });
  });
});
