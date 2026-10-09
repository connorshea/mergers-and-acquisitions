// Calibrate the Claude merge review (src/lib/llm-review.ts) against the
// labelled eval pairs (eval-data/), before it ranks real candidates: how often
// each model gets the pairs right, how often it says "unsure", what it costs,
// and how a cheap first pass with an escalation on "unsure" would do. Uses the
// Message Batches API, as the review job will (half price, results within an
// hour or so, at most 24 h).
//
//   node scripts/eval-llm.ts labels                  # resolve labels once (QLever, no API key)
//   node scripts/eval-llm.ts show <pair-dir>         # print the prompt for one pair
//   node scripts/eval-llm.ts estimate                # count tokens and project the cost (free)
//   node scripts/eval-llm.ts submit [--models haiku,sonnet,opus] [--limit N] [--wait]
//   node scripts/eval-llm.ts collect [run-dir] [--wait]   # default: the latest run
//
// `submit` and `estimate` need ANTHROPIC_API_KEY (or an `ant auth login`
// profile). Each run is kept under tmp/llm-eval/<timestamp>/ (gitignored):
// run.json names its batches, results-<model>.jsonl holds what came back, so
// `collect` can be re-run any time to re-print the report.
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
  type LabelLookup,
  parseReview,
  PROMPT_VERSION,
  type Review,
  REVIEW_MODELS,
  type ReviewModel,
  referencedIds,
  renderPair,
  reviewRequest,
  SYSTEM_PROMPT,
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

async function submit(argv: string[]): Promise<void> {
  const client = new Anthropic();
  const models = parseModels(flag(argv, "--models"));
  const pairs = await selectPairs(argv);
  const labelOf = await labelLookup();
  const texts = new Map(pairs.map((p) => [p.name, pairText(p, labelOf)]));

  const run: Run = {
    createdAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    batches: [],
  };
  const dir = join(RUNS_DIR, run.createdAt.replace(/[:.]/g, "-"));
  await mkdir(dir, { recursive: true });

  for (const model of models) {
    const effort = (flag(argv, `--effort-${REVIEW_MODELS[model].short}`) ??
      REVIEW_MODELS[model].defaultEffort) as Effort;
    const batch = await client.messages.batches.create({
      requests: pairs.map((p) => ({
        custom_id: p.name,
        params: reviewRequest(model, effort, texts.get(p.name)!),
      })),
    });
    run.batches.push({ model, effort, batchId: batch.id, pairs: pairs.map((p) => p.name) });
    console.log(`${model} (effort ${effort}): batch ${batch.id}, ${pairs.length} requests`);
  }
  await writeFile(join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");
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

async function collect(dir: string, wait: boolean): Promise<void> {
  const client = new Anthropic();
  const run = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as Run;

  for (const b of run.batches) {
    if (await readResults(dir, b.model)) continue;
    for (;;) {
      const batch = await client.messages.batches.retrieve(b.batchId);
      if (batch.processing_status === "ended") break;
      const c = batch.request_counts;
      console.log(
        `${b.model}: ${batch.processing_status} (${c.processing} processing, ${c.succeeded} succeeded, ${c.errored} errored)`,
      );
      if (!wait) {
        console.log("Not finished yet; re-run collect later (or pass --wait).");
        return;
      }
      await sleep(POLL_MS);
    }
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
    `  ${name.padEnd(30)} precision ${pct(t.tp, t.tp + t.fp).padStart(6)}  ` +
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
  const names = run.batches[0]?.pairs.filter((n) => pairs.has(n)) ?? [];
  const dupCount = names.filter((n) => pairs.get(n)!.label === "duplicate").length;

  console.log(
    `\nLLM review calibration — prompt v${run.promptVersion}, ${names.length} pairs ` +
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

  // Escalation: the cheapest model's verdict, with its "unsure" pairs handed
  // to a stronger model.
  const haiku = byModel.get("claude-haiku-5-5");
  if (haiku) {
    for (const [model, results] of byModel) {
      if (model === "claude-haiku-5-5") continue;
      const t = emptyTally();
      let stillUnsure = 0;
      let escalated = 0;
      for (const n of names) {
        const label = pairs.get(n)!.label;
        let review = haiku.get(n)?.review ?? null;
        if (!review || review.verdict === "unsure") {
          escalated++;
          review = results.get(n)?.review ?? null;
        }
        if (!review || review.verdict === "unsure") stillUnsure++;
        else add(t, label, review.verdict === "same");
      }
      console.log(
        tallyLine(
          `haiku → ${REVIEW_MODELS[model].short} on unsure`,
          t,
          `  (${escalated} escalated, ${stillUnsure} still unsure)`,
        ),
      );
    }
  }

  // Cost: what this run cost, and the same per-pair rate at production scale.
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
  }
  if (haiku) {
    const unsureRate =
      names.filter((n) => {
        const r = haiku.get(n)?.review;
        return !r || r.verdict === "unsure";
      }).length / Math.max(1, names.length);
    for (const [model, each] of perPair) {
      if (model === "claude-haiku-5-5") continue;
      const blended = perPair.get("claude-haiku-5-5")! + unsureRate * each;
      console.log(
        `  haiku → ${REVIEW_MODELS[model].short} on unsure (${pct(unsureRate * names.length, names.length)} escalated): ` +
          `${usd(blended * 10_000)} per 10k pairs, ${usd(blended * 50_000)} per 50k`,
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

  for (const model of models) {
    let total = 0;
    for (const p of pairs) {
      const req = reviewRequest(model, REVIEW_MODELS[model].defaultEffort, pairText(p, labelOf));
      const { input_tokens } = await client.messages.countTokens({
        model,
        system: req.system,
        messages: req.messages,
        output_config: req.output_config,
      });
      total += input_tokens;
    }
    const avgIn = total / pairs.length;
    const out = assumedOutput[REVIEW_MODELS[model].short];
    const each = costUsd(model, { input_tokens: avgIn, output_tokens: out }, true);
    console.log(
      `${model}: avg ${Math.round(avgIn)} input tokens/pair (~${out} output assumed) → ` +
        `${usd(each * pairs.length)} for these ${pairs.length} pairs, ` +
        `${usd(each * 10_000)} per 10k, ${usd(each * 50_000)} per 50k`,
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
