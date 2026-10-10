// Calibrate the Claude merge review (src/lib/llm-review.ts) against the
// labelled eval pairs (eval-data/), before it ranks real candidates: how often
// each model gets the pairs right, how often it says "unsure", what it costs,
// and how a cheap first pass that escalates some pairs to a stronger model would do. Uses the
// Message Batches API, as the review job will (half price, results within an
// hour or so, at most 24 h).
//
//   node scripts/eval-llm.ts labels                  # resolve labels once (QLever, no API key)
//   node scripts/eval-llm.ts show <pair-dir>         # print the prompt for one pair
//   node scripts/eval-llm.ts estimate                # count tokens and project the cost (free)
//   node scripts/eval-llm.ts submit [--models haiku,sonnet,opus] [--limit N] [--max-pair-cost USD]
//       [--effort-haiku low|medium|high] [--with <run-dir>] [--wait]
//   node scripts/eval-llm.ts collect [run-dir] [--wait]   # default: the latest run
//
// `submit` and `estimate` need ANTHROPIC_API_KEY (or an `ant auth login`
// profile). Each run is kept under tmp/llm-eval/<timestamp>/ (gitignored):
// run.json names its batches, results-<model>.jsonl holds what came back, so
// `collect` can be re-run any time to re-print the report.
//
// Each request's max_tokens is sized so its worst case stays under a per-pair
// cost cap (MAX_PAIR_COST_USD, or --max-pair-cost); a pair that can't fit under
// it on a model isn't sent to that model.
//
// Item and property labels come from eval-data/llm-labels.json, which `labels`
// fills from QLever. Like the other eval-data side files it's append-only, so
// a later rename on Wikidata doesn't shift the prompt.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  costUsd,
  type Effort,
  HAIKU_LONG_PROMPT_TOKENS,
  type LabelLookup,
  MAX_PAIR_COST_USD,
  MAX_PROMPT_TOKENS,
  outputTokenBudget,
  parseReview,
  PROMPT_VERSION,
  promptTokens,
  type Review,
  REVIEW_MODELS,
  type ReviewModel,
  referencedIds,
  renderPair,
  reviewRequest,
  SYSTEM_PROMPT,
  TRUST_DIFFERENT_P,
  TRUST_SAME_P,
  trustFirstPass,
  type TokenUsage,
} from "../src/lib/llm-review.ts";
import { orderByAge } from "../src/lib/compare.ts";
import { fetchAllProperties, fetchEntityLabels } from "../src/lib/sparql.ts";
import { EVAL_DIR, loadHeuristicScorer, loadPairs, type Pair } from "./eval-pairs.ts";

const LABELS_PATH = join(EVAL_DIR, "llm-labels.json");
const RUNS_DIR = join("tmp", "llm-eval");
const HEURISTIC_THRESHOLD = 0.4; // mirrors hunt.ts MIN_CONFIDENCE
const POLL_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- labels ----------

interface LabelsFile {
  checkedAt: string;
  properties: Record<string, string>;
  items: Record<string, string>;
}

async function readLabels(): Promise<LabelsFile> {
  try {
    return JSON.parse(await readFile(LABELS_PATH, "utf8")) as LabelsFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { checkedAt: "", properties: {}, items: {} };
    }
    throw err;
  }
}

async function labelLookup(): Promise<LabelLookup> {
  const file = await readLabels();
  if (Object.keys(file.properties).length === 0) {
    console.warn(`⚠ ${LABELS_PATH} is empty: run \`node scripts/eval-llm.ts labels\` first.`);
  }
  return (id) => (id.startsWith("P") ? file.properties[id] : file.items[id]);
}

/** Add the labels of every property and value item the pairs name and the file lacks. */
async function resolveLabels(pairs: Pair[]): Promise<void> {
  const file = await readLabels();
  const pids = new Set<string>();
  const qids = new Set<string>();
  for (const { a, b } of pairs) {
    for (const item of [a, b]) {
      const refs = referencedIds(item);
      for (const pid of refs.pids) if (!(pid in file.properties)) pids.add(pid);
      for (const qid of refs.qids) if (!(qid in file.items)) qids.add(qid);
    }
  }

  let addedProps = 0;
  if (pids.size > 0) {
    for (const row of await fetchAllProperties()) {
      if (pids.has(row.pid)) {
        file.properties[row.pid] = row.label;
        addedProps++;
      }
    }
  }
  let addedItems = 0;
  const { failedQids } = await fetchEntityLabels([...qids], async (rows) => {
    for (const row of rows) file.items[row.qid] = row.label;
    addedItems += rows.length;
  });

  const sorted = (rec: Record<string, string>) =>
    Object.fromEntries(Object.entries(rec).sort(([x], [y]) => x.localeCompare(y)));
  file.checkedAt = new Date().toISOString().slice(0, 10);
  file.properties = sorted(file.properties);
  file.items = sorted(file.items);
  await writeFile(LABELS_PATH, JSON.stringify(file, null, 2) + "\n");
  console.log(
    `${LABELS_PATH}: added ${addedProps} of ${pids.size} missing property labels and ` +
      `${addedItems} of ${qids.size} missing item labels` +
      (failedQids.length > 0 ? ` (${failedQids.length} lookups failed; re-run to retry)` : ""),
  );
}

/** A pair's user turn, in the order production sends it (oldest item second). */
function pairText(pair: Pair, labelOf: LabelLookup): string {
  const [from, into] = orderByAge(pair.a, pair.b);
  return renderPair(from, into, labelOf);
}

/** "v3", or "v2 + examples" for a run from the --prompt-examples experiment. */
const promptLabel = (run: Run): string =>
  `v${run.promptVersion}${run.promptExamples ? " + examples" : ""}`;

// ---------- runs ----------

interface RunBatch {
  model: ReviewModel;
  effort: Effort;
  batchId: string;
  pairs: string[];
}

interface Run {
  createdAt: string;
  promptVersion: number;
  maxPairCostUsd?: number;
  /**
   * Another run whose results stand in for models this run didn't send (from
   * `submit --with`), so a first-pass-only run still reports escalation to,
   * say, an earlier run's Opus.
   */
  withRun?: string;
  /** Runs from the since-removed --prompt-examples experiment: v2 plus the examples v3 adopted. */
  promptExamples?: boolean;
  batches: RunBatch[];
}

interface ResultRecord {
  pair: string;
  model: ReviewModel;
  review: Review | null;
  /** Why there's no review: an API error, a refusal, an unparseable answer. */
  error?: string;
  usage?: TokenUsage;
  costUsd: number;
}

function parseModels(arg: string | undefined): ReviewModel[] {
  const wanted = (arg ?? "haiku,sonnet,opus").split(",").map((s) => s.trim());
  return wanted.map((short) => {
    const model = (Object.keys(REVIEW_MODELS) as ReviewModel[]).find(
      (m) => REVIEW_MODELS[m].short === short || m === short,
    );
    if (!model) throw new Error(`unknown model "${short}" (haiku, sonnet, or opus)`);
    return model;
  });
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function selectPairs(argv: string[]): Promise<Pair[]> {
  let pairs = await loadPairs();
  const only = flag(argv, "--pairs");
  if (only) {
    const names = new Set(only.split(","));
    pairs = pairs.filter((p) => names.has(p.name));
  }
  const limit = flag(argv, "--limit");
  if (limit) {
    // Keep both labels represented in a small spot-check run.
    const n = Number(limit);
    const dups = pairs.filter((p) => p.label === "duplicate");
    const distinct = pairs.filter((p) => p.label === "distinct");
    pairs = [...dups.slice(0, Math.ceil(n / 2)), ...distinct.slice(0, Math.floor(n / 2))];
  }
  return pairs;
}

/** A pair's exact prompt tokens on `model`, from count_tokens (free). */
async function countPromptTokens(
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
function cachedPromptTokens(client: Anthropic): Promise<number> {
  return countPromptTokens(client, "claude-haiku-5-5", "-");
}

/**
 * The pairs whose prompt stays under MAX_PROMPT_TOKENS, with their prompt
 * tokens, counted exactly on Haiku so no request crosses into Haiku's
 * long-prompt rate. A pair over it is left out for every model, which keeps
 * the models comparable. (The 5.5 models count a prompt alike, so the count
 * also sizes the other models' max_tokens.)
 */
async function underPromptLimit(
  client: Anthropic,
  pairs: Pair[],
  texts: Map<string, string>,
): Promise<{ pairs: Pair[]; tokens: Map<string, number> }> {
  const kept: Pair[] = [];
  const tokens = new Map<string, number>();
  for (const p of pairs) {
    const n = await countPromptTokens(client, "claude-haiku-5-5", texts.get(p.name)!);
    tokens.set(p.name, n);
    if (n <= MAX_PROMPT_TOKENS) kept.push(p);
    else console.warn(`⚠ skipping ${p.name}: ${n} prompt tokens (limit ${MAX_PROMPT_TOKENS})`);
  }
  return { pairs: kept, tokens };
}

function maxPairCost(argv: string[]): number {
  const raw = flag(argv, "--max-pair-cost");
  if (raw === undefined) return MAX_PAIR_COST_USD;
  const dollars = Number(raw);
  if (!Number.isFinite(dollars) || dollars <= 0)
    throw new Error(`--max-pair-cost must be a positive number of dollars, got "${raw}"`);
  return dollars;
}

async function submit(argv: string[]): Promise<void> {
  const client = new Anthropic();
  const models = parseModels(flag(argv, "--models"));
  const selected = await selectPairs(argv);
  const labelOf = await labelLookup();
  const texts = new Map(selected.map((p) => [p.name, pairText(p, labelOf)]));
  const maxCost = maxPairCost(argv);
  const { pairs, tokens } = await underPromptLimit(client, selected, texts);
  if (pairs.length === 0) throw new Error("no pairs left to submit");
  const cached = await cachedPromptTokens(client);

  const run: Run = {
    createdAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    maxPairCostUsd: maxCost,
    withRun: flag(argv, "--with"),
    batches: [],
  };
  const dir = join(RUNS_DIR, run.createdAt.replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });
  // Rewritten after every batch is created, so a failure partway through
  // still leaves a record of the batches already running (and billing).
  const saveRun = () => writeFile(join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");
  await saveRun();

  for (const model of models) {
    const effort = (flag(argv, `--effort-${REVIEW_MODELS[model].short}`) ??
      REVIEW_MODELS[model].defaultEffort) as Effort;
    const requests = [];
    for (const p of pairs) {
      const maxTokens = outputTokenBudget(model, tokens.get(p.name)!, cached, maxCost);
      if (maxTokens === null) {
        console.warn(
          `⚠ skipping ${p.name} on ${model}: its prompt alone nearly reaches the ${usd(maxCost)} cap`,
        );
        continue;
      }
      requests.push({
        custom_id: p.name,
        params: reviewRequest(model, effort, texts.get(p.name)!, maxTokens),
      });
    }
    if (requests.length === 0) {
      console.warn(`⚠ no pairs fit under the ${usd(maxCost)} cap on ${model}; not submitting it`);
      continue;
    }
    const batch = await client.messages.batches.create({ requests });
    run.batches.push({ model, effort, batchId: batch.id, pairs: requests.map((r) => r.custom_id) });
    await saveRun();
    console.log(`${model} (effort ${effort}): batch ${batch.id}, ${requests.length} requests`);
  }
  console.log(`\nRun saved to ${dir}. Collect with: node scripts/eval-llm.ts collect ${dir}`);
  if (argv.includes("--wait")) await collect(dir, true);
}

async function latestRunDir(): Promise<string> {
  const dirs = (await readdir(RUNS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (dirs.length === 0) throw new Error(`no runs under ${RUNS_DIR}; submit one first`);
  return join(RUNS_DIR, dirs[dirs.length - 1]);
}

const resultsPath = (dir: string, model: ReviewModel) =>
  join(dir, `results-${REVIEW_MODELS[model].short}.jsonl`);

async function readResults(dir: string, model: ReviewModel): Promise<ResultRecord[] | null> {
  try {
    const raw = await readFile(resultsPath(dir, model), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ResultRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** One batch result as a record: the review, or why there isn't one. */
function toRecord(
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

/** Fetch an ended batch's results and save them as the model's results file. */
async function saveResults(client: Anthropic, dir: string, b: RunBatch): Promise<void> {
  const records: ResultRecord[] = [];
  for await (const result of await client.messages.batches.results(b.batchId)) {
    records.push(toRecord(b.model, result));
  }
  await writeFile(
    resultsPath(dir, b.model),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  console.log(`${b.model}: ${records.length} results saved`);
}

/** How long after submit a batch may still 404 while the API catches up. */
const NEW_BATCH_GRACE_MS = 10 * 60_000;

/**
 * A batch's status, or null when the API doesn't know the batch yet: a batch
 * can 404 for a short while after it's created, so `submit --wait` polling
 * straight away would otherwise crash on a batch that's running fine.
 */
async function retrieveBatch(client: Anthropic, run: Run, b: RunBatch) {
  try {
    return await client.messages.batches.retrieve(b.batchId);
  } catch (err) {
    const fresh = Date.now() - Date.parse(run.createdAt) < NEW_BATCH_GRACE_MS;
    if (err instanceof Anthropic.NotFoundError && fresh) return null;
    throw err;
  }
}

/**
 * Check every batch of the run at once each round, saving each one's results
 * as soon as it ends, and print the report once all have. Without `wait`, one
 * round: whatever has ended is saved, and a re-run picks up the rest.
 */
async function collect(dir: string, wait: boolean): Promise<void> {
  const client = new Anthropic();
  const run = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as Run;
  if (run.batches.length === 0) {
    throw new Error(`${dir} has no batches: its submit failed before creating any`);
  }

  let pending: RunBatch[] = [];
  for (const b of run.batches) if (!(await readResults(dir, b.model))) pending.push(b);

  while (pending.length > 0) {
    const batches = await Promise.all(pending.map((b) => retrieveBatch(client, run, b)));
    const stillRunning: RunBatch[] = [];
    for (const [i, b] of pending.entries()) {
      const batch = batches[i];
      if (!batch) {
        console.log(`${b.model}: just created, not visible to the API yet`);
        stillRunning.push(b);
        continue;
      }
      if (batch.processing_status === "ended") {
        await saveResults(client, dir, b);
        continue;
      }
      const c = batch.request_counts;
      console.log(
        `${b.model}: ${batch.processing_status} (${c.processing} processing, ${c.succeeded} succeeded, ${c.errored} errored)`,
      );
      stillRunning.push(b);
    }
    pending = stillRunning;
    if (pending.length === 0) break;
    if (!wait) {
      console.log("Not finished yet; re-run collect later (or pass --wait).");
      return;
    }
    await sleep(POLL_MS);
  }
  await report(dir, run);
}

// ---------- report ----------

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const usd = (n: number): string => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

interface Tally {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

function f1(t: Tally): { precision: number; recall: number; f1: number; accuracy: number } {
  const precision = t.tp + t.fp === 0 ? 0 : t.tp / (t.tp + t.fp);
  const recall = t.tp + t.fn === 0 ? 0 : t.tp / (t.tp + t.fn);
  const total = t.tp + t.fp + t.tn + t.fn;
  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    accuracy: total === 0 ? 0 : (t.tp + t.tn) / total,
  };
}

function tallyLine(name: string, t: Tally, extra = ""): string {
  const m = f1(t);
  return (
    `  ${name.padEnd(34)} precision ${pct(t.tp, t.tp + t.fp).padStart(6)}  ` +
    `recall ${pct(t.tp, t.tp + t.fn).padStart(6)}  F1 ${m.f1.toFixed(3)}  ` +
    `accuracy ${(m.accuracy * 100).toFixed(1).padStart(5)}%${extra}`
  );
}

function add(t: Tally, label: Pair["label"], saysDuplicate: boolean): void {
  if (label === "duplicate") {
    if (saysDuplicate) t.tp++;
    else t.fn++;
  } else if (saysDuplicate) t.fp++;
  else t.tn++;
}

const emptyTally = (): Tally => ({ tp: 0, fp: 0, tn: 0, fn: 0 });

async function report(dir: string, run: Run): Promise<void> {
  const pairs = new Map((await loadPairs()).map((p) => [p.name, p]));
  const score = await loadHeuristicScorer();
  const byModel = new Map<ReviewModel, Map<string, ResultRecord>>();
  for (const b of run.batches) {
    const records = await readResults(dir, b.model);
    if (records) byModel.set(b.model, new Map(records.map((r) => [r.pair, r])));
  }
  if (run.withRun) {
    const other = JSON.parse(await readFile(join(run.withRun, "run.json"), "utf8")) as Run;
    for (const b of other.batches) {
      if (byModel.has(b.model)) continue;
      const records = await readResults(run.withRun, b.model);
      if (!records) continue;
      byModel.set(b.model, new Map(records.map((r) => [r.pair, r])));
      console.log(
        `${REVIEW_MODELS[b.model].short}: results from ${run.withRun} (prompt ${promptLabel(other)})`,
      );
    }
  }
  const names = run.batches[0]?.pairs.filter((n) => pairs.has(n)) ?? [];
  const dupCount = names.filter((n) => pairs.get(n)!.label === "duplicate").length;

  console.log(
    `\nLLM review calibration — prompt ${promptLabel(run)}, ${names.length} pairs ` +
      `(${dupCount} duplicate, ${names.length - dupCount} distinct), run ${dir}\n`,
  );

  // The heuristic scorer on the same pairs, for reference.
  const heuristic = emptyTally();
  for (const n of names) {
    const p = pairs.get(n)!;
    add(heuristic, p.label, score(p).confidence >= HEURISTIC_THRESHOLD);
  }
  console.log("Classification (positive = duplicate):");
  console.log(tallyLine(`heuristic (≥ ${HEURISTIC_THRESHOLD})`, heuristic));

  for (const [model, results] of byModel) {
    const decided = emptyTally();
    const forced = emptyTally();
    let unsure = 0;
    let failed = 0;
    for (const n of names) {
      const r = results.get(n);
      const label = pairs.get(n)!.label;
      if (!r?.review) {
        failed++;
        continue;
      }
      add(forced, label, r.review.probability >= 0.5);
      if (r.review.verdict === "unsure") unsure++;
      else add(decided, label, r.review.verdict === "same");
    }
    const short = REVIEW_MODELS[model].short;
    console.log(
      tallyLine(
        `${short}, decided only`,
        decided,
        `  (${unsure} unsure = ${pct(unsure, names.length)}${failed ? `, ${failed} failed` : ""})`,
      ),
    );
    console.log(tallyLine(`${short}, probability ≥ 0.5`, forced));
  }

  // Escalation: a cheaper model's first pass, with some pairs handed to a
  // stronger one. Its errors are mostly confident "different" calls on real
  // duplicates, so "unsure" alone escalates too little; the rules widen it.
  // Read "disagreement" with care: most eval negatives score under the
  // heuristic's threshold, but every real candidate clears it (the hunt drops
  // the rest), so in production the rule escalates every "different" verdict,
  // as "not same" does. "low confidence" trusts only the first pass's
  // confident calls (trustFirstPass), the rule the review job would use.
  const avgCost = (model: ReviewModel): number => {
    const records = [...(byModel.get(model)?.values() ?? [])];
    return records.reduce((s, r) => s + r.costUsd, 0) / Math.max(1, records.length);
  };
  const heuristicSays = new Map(
    names.map((n) => [n, score(pairs.get(n)!).confidence >= HEURISTIC_THRESHOLD]),
  );
  const rules: [string, (review: Review | null, name: string) => boolean][] = [
    ["unsure", (r) => !r || r.verdict === "unsure"],
    ["not same", (r) => !r || r.verdict !== "same"],
    [
      "disagreement",
      (r, n) => !r || r.verdict === "unsure" || (r.verdict === "same") !== heuristicSays.get(n),
    ],
    ["low confidence", (r) => !trustFirstPass(r)],
  ];
  const order = (Object.keys(REVIEW_MODELS) as ReviewModel[]).filter((m) => byModel.has(m));
  for (const [i, first] of order.entries()) {
    for (const second of order.slice(i + 1)) {
      for (const [rule, escalate] of rules) {
        const t = emptyTally();
        let stillUnsure = 0;
        let escalated = 0;
        for (const n of names) {
          let review = byModel.get(first)!.get(n)?.review ?? null;
          if (escalate(review, n)) {
            escalated++;
            review = byModel.get(second)!.get(n)?.review ?? null;
          }
          if (!review || review.verdict === "unsure") stillUnsure++;
          else add(t, pairs.get(n)!.label, review.verdict === "same");
        }
        const blended = avgCost(first) + (escalated / Math.max(1, names.length)) * avgCost(second);
        console.log(
          tallyLine(
            `${REVIEW_MODELS[first].short} → ${REVIEW_MODELS[second].short} on ${rule}`,
            t,
            `  (${pct(escalated, names.length)} escalated, ${stillUnsure} still unsure, ` +
              `${usd(blended * 10_000)} per 10k)`,
          ),
        );
      }
    }
  }

  console.log(
    `  (low confidence: escalate unless "same" with p ≥ ${TRUST_SAME_P} ` +
      `or "different" with p < ${TRUST_DIFFERENT_P})`,
  );

  // Cost: what this run cost, and the same per-pair rate at production scale.
  const longPrompts = (byModel.get("claude-haiku-5-5")?.values() ?? []).filter(
    (r) => r.usage && promptTokens(r.usage) > HAIKU_LONG_PROMPT_TOKENS,
  );
  for (const r of longPrompts) {
    console.warn(
      `⚠ ${r.pair}: ${promptTokens(r.usage!)} prompt tokens, billed at Haiku's long-prompt rate`,
    );
  }

  console.log("\nCost (Batch API prices):");
  const perPair = new Map<ReviewModel, number>();
  for (const [model, results] of byModel) {
    const records = [...results.values()];
    const total = records.reduce((s, r) => s + r.costUsd, 0);
    const sum = (k: keyof TokenUsage) => records.reduce((s, r) => s + (r.usage?.[k] ?? 0), 0);
    const each = records.length === 0 ? 0 : total / records.length;
    perPair.set(model, each);
    console.log(
      `  ${REVIEW_MODELS[model].short.padEnd(7)} ${usd(total).padStart(7)} this run · ` +
        `avg ${Math.round(sum("input_tokens") / records.length)} in + ` +
        `${Math.round(sum("cache_read_input_tokens") / records.length)} cached + ` +
        `${Math.round(sum("output_tokens") / records.length)} out tokens/pair · ` +
        `${usd(each * 10_000)} per 10k pairs, ${usd(each * 50_000)} per 50k`,
    );
    const priciest = records.reduce((x, y) => (y.costUsd > x.costUsd ? y : x), records[0]);
    if (priciest) {
      const maxOut = Math.max(...records.map((r) => r.usage?.output_tokens ?? 0));
      console.log(
        `          priciest pair ${usd(priciest.costUsd)} (${priciest.pair}), most output ${maxOut} tokens` +
          (run.maxPairCostUsd === undefined ? "" : ` · cap ${usd(run.maxPairCostUsd)} per pair`),
      );
    }
  }

  // Every wrong or undecided answer, with the model's own reasoning.
  for (const [model, results] of byModel) {
    const misses = names.filter((n) => {
      const r = results.get(n);
      if (!r?.review) return true;
      if (r.review.verdict === "unsure") return true;
      return (r.review.verdict === "same") !== (pairs.get(n)!.label === "duplicate");
    });
    if (misses.length === 0) continue;
    console.log(`\n${REVIEW_MODELS[model].short}: ${misses.length} wrong, unsure, or failed:`);
    for (const n of misses) {
      const r = results.get(n);
      const label = pairs.get(n)!.label;
      if (!r?.review) {
        console.log(`  [FAILED] ${n} (${label}): ${r?.error ?? "no result"}`);
        continue;
      }
      const kind =
        r.review.verdict === "unsure"
          ? "UNSURE"
          : label === "duplicate"
            ? "FALSE NEGATIVE"
            : "FALSE POSITIVE";
      console.log(`  [${kind}] ${n} p=${r.review.probability.toFixed(2)}`);
      console.log(`      ${r.review.rationale}`);
    }
  }
}

// ---------- estimate ----------

/**
 * Count the real input tokens for every pair (count_tokens is free) and
 * project the cost of a run, with an assumed output size per model since that
 * depends on how much the model thinks.
 */
async function estimate(argv: string[]): Promise<void> {
  const client = new Anthropic();
  const models = parseModels(flag(argv, "--models"));
  const pairs = await selectPairs(argv);
  const labelOf = await labelLookup();
  const assumedOutput: Record<string, number> = { haiku: 400, sonnet: 800, opus: 800 };
  const maxCost = maxPairCost(argv);
  const cached = await cachedPromptTokens(client);

  for (const model of models) {
    let total = 0;
    let max = 0;
    let over = 0;
    let unaffordable = 0;
    let minMaxTokens = Infinity;
    for (const p of pairs) {
      const tokens = await countPromptTokens(client, model, pairText(p, labelOf));
      total += tokens;
      max = Math.max(max, tokens);
      if (tokens > MAX_PROMPT_TOKENS) over++;
      const budget = outputTokenBudget(model, tokens, cached, maxCost);
      if (budget === null) unaffordable++;
      else minMaxTokens = Math.min(minMaxTokens, budget);
    }
    const avgIn = total / pairs.length;
    const out = assumedOutput[REVIEW_MODELS[model].short];
    const each = costUsd(model, { input_tokens: avgIn, output_tokens: out }, true);
    console.log(
      `${model}: avg ${Math.round(avgIn)} input tokens/pair, max ${max}` +
        (over > 0 ? ` (${over} over the ${MAX_PROMPT_TOKENS} limit; submit skips them)` : "") +
        ` (~${out} output assumed) → ` +
        `${usd(each * pairs.length)} for these ${pairs.length} pairs, ` +
        `${usd(each * 10_000)} per 10k, ${usd(each * 50_000)} per 50k`,
    );
    console.log(
      `  ${usd(maxCost)} cap per pair: max_tokens ${minMaxTokens === Infinity ? "n/a" : minMaxTokens}` +
        ` at the lowest` +
        (unaffordable > 0 ? `, ${unaffordable} pair(s) too big to send` : ""),
    );
  }
}

// ---------- main ----------

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  switch (command) {
    case "labels":
      await resolveLabels(await loadPairs());
      break;
    case "show": {
      const pair = (await loadPairs()).find((p) => p.name === argv[0]);
      if (!pair) throw new Error(`no eval pair named "${argv[0]}"`);
      console.log(`--- system ---\n${SYSTEM_PROMPT}\n\n--- user ---`);
      console.log(pairText(pair, await labelLookup()));
      break;
    }
    case "estimate":
      await estimate(argv);
      break;
    case "submit":
      await submit(argv);
      break;
    case "collect": {
      const dir = argv[0] && !argv[0].startsWith("--") ? argv[0] : await latestRunDir();
      await collect(dir, argv.includes("--wait"));
      break;
    }
    default:
      console.log(
        "usage: node scripts/eval-llm.ts labels | show <pair-dir> | estimate | submit | collect [run-dir]",
      );
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(2);
});
