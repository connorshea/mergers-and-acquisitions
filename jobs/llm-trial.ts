// One-off, read-only trial of the Claude review on production candidates
// (issue #292): before any job hides pairs, see what Haiku and Opus make of
// real open candidates. Samples open pairs evenly across the heuristic's
// confidence bands, sends every one to both models through the Message
// Batches API, and writes the reviews to files. It never writes to the
// database and never touches Wikidata.
//
//   node jobs/llm-trial.ts submit [--per-band 100] [--dry-run] [--wait]   # needs the DB and ANTHROPIC_API_KEY
//   node jobs/llm-trial.ts collect [run-dir] [--wait]         # needs ANTHROPIC_API_KEY
//   node jobs/llm-trial.ts report [run-dir]                   # offline: reads the run's files
//
// `--dry-run` draws the sample and writes pairs.jsonl and prompts.jsonl, but
// calls no API (and so needs no key): for checking the sample and the prompts.
//
// Runs live under $TOOL_DATA_DIR/llm-trial/<timestamp>/ (tmp/llm-trial/ off
// Toolforge), so on Toolforge the job needs `--mount all`:
//
//   toolforge jobs run llm-trial --image tool-mna/tool-mna:latest --mount all \
//     --command "node jobs/llm-trial.ts submit --wait"
//
// A run holds run.json (its batches and the open queue's size per band),
// pairs.jsonl (each sampled candidate, with its band), prompts.jsonl (exactly
// what the models saw), results-<model>.jsonl, and, once both models are in,
// review.md: the pairs the proposed rule would hide, for a human to check.
// `report` re-reads those files, so a run copied off Toolforge can be
// reported locally.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { entityLabels, items, mergeCandidates, properties } from "../db/schema.ts";
import type { Item } from "../src/lib/compare.ts";
import { chunk } from "../src/lib/chunk.ts";
import {
  type Effort,
  type LabelLookup,
  MAX_PROMPT_TOKENS,
  outputTokenBudget,
  PROMPT_VERSION,
  REVIEW_MODELS,
  type Review,
  type ReviewModel,
  referencedIds,
  renderPair,
  reviewRequest,
  TRUST_DIFFERENT_P,
} from "../src/lib/llm-review.ts";
import {
  cachedPromptTokens,
  countPromptTokens,
  type ResultRecord,
  toRecord,
} from "../server/llm-batch.ts";

const RUNS_DIR = join(process.env.TOOL_DATA_DIR ?? "tmp", "llm-trial");
const SITE = "https://mna.toolforge.org";
const MODELS: ReviewModel[] = ["claude-haiku-5-5", "claude-opus-5-5"];
const POLL_MS = 60_000;
const ID_CHUNK = 1000;

/** The heuristic's confidence bands; the last is open-ended. The hunt's floor is 0.4. */
const BANDS: [lo: number, hi: number | null][] = [
  [0.4, 0.5],
  [0.5, 0.6],
  [0.6, 0.7],
  [0.7, 0.8],
  [0.8, null],
];
const bandName = ([lo, hi]: (typeof BANDS)[number]): string =>
  hi === null ? `≥ ${lo}` : `${lo}–${hi}`;

/**
 * The rule under trial: hide a pair only when Haiku and Opus both call it
 * "different" with a probability under this.
 */
const HIDE_MAX_P = TRUST_DIFFERENT_P;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Run {
  createdAt: string;
  promptVersion: number;
  /** Open candidates per band when the sample was drawn, to weight the projection. */
  openPerBand: Record<string, number>;
  batches: { model: ReviewModel; effort: Effort; batchId: string; requests: number }[];
}

interface SampledPair {
  /** `custom_id`: the candidate id as a string. */
  pair: string;
  candidateId: number;
  fromQid: string;
  intoQid: string;
  fromLabel: string | null;
  intoLabel: string | null;
  confidence: number;
  band: string;
  promptTokens: number;
}

const writeJsonl = (path: string, rows: unknown[]) =>
  writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

async function readJsonl<T>(path: string): Promise<T[] | null> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const resultsPath = (dir: string, model: ReviewModel) =>
  join(dir, `results-${REVIEW_MODELS[model].short}.jsonl`);

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ---------- submit ----------

/**
 * Labels for every property and value item the items name: inline labels
 * first (the dump import keeps some on the values), then the synced
 * `properties` and `entity_labels` tables.
 */
async function loadLabelLookup(
  db: typeof import("../server/db.ts").db,
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

async function submit(argv: string[]): Promise<void> {
  const perBand = Number(flag(argv, "--per-band") ?? 100);
  if (!Number.isInteger(perBand) || perBand <= 0) throw new Error("--per-band must be a count");
  const { db, pool } = await import("../server/db.ts");
  const { attachSitelinkRedirects } = await import("../server/sitelink-overlay.ts");
  const dryRun = argv.includes("--dry-run");
  const client = dryRun ? null : new Anthropic();

  try {
    // Draw the sample: `perBand` random open candidates from each band. A
    // band with fewer open pairs gives all it has; no band makes up another's
    // shortfall, so each band's numbers stand on their own.
    const openPerBand: Record<string, number> = {};
    const sampled: {
      id: number;
      fromQid: string;
      intoQid: string;
      confidence: number;
      band: string;
    }[] = [];
    for (const band of BANDS) {
      const [lo, hi] = band;
      const where = and(
        eq(mergeCandidates.status, "open"),
        gte(mergeCandidates.confidence, lo),
        hi === null ? undefined : lt(mergeCandidates.confidence, hi),
      );
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)` })
        .from(mergeCandidates)
        .where(where);
      openPerBand[bandName(band)] = Number(n);
      const rows = await db
        .select({
          id: mergeCandidates.id,
          fromQid: mergeCandidates.fromQid,
          intoQid: mergeCandidates.intoQid,
          confidence: mergeCandidates.confidence,
        })
        .from(mergeCandidates)
        .where(where)
        .orderBy(sql`rand()`)
        .limit(perBand);
      for (const r of rows) sampled.push({ ...r, band: bandName(band) });
      console.log(`band ${bandName(band)}: ${rows.length} of ${n} open pairs sampled`);
    }

    // Both items of every pair, as the detail page shows them: from the
    // mirror, with the sitelink-redirect overlay.
    const qids = [...new Set(sampled.flatMap((s) => [s.fromQid, s.intoQid]))];
    const byQid = new Map<string, Item>();
    for (const ids of chunk(qids, ID_CHUNK)) {
      const rows = await db
        .select({ qid: items.qid, data: items.data })
        .from(items)
        .where(inArray(items.qid, ids));
      for (const r of rows) byQid.set(r.qid, r.data as Item);
    }
    const complete = sampled.filter((s) => byQid.has(s.fromQid) && byQid.has(s.intoQid));
    if (complete.length < sampled.length) {
      console.warn(`⚠ ${sampled.length - complete.length} sampled pairs lack an item row; skipped`);
    }
    // Each pair gets its own copies, since the overlay mutates them.
    const itemPairs = complete.map((s): [Item, Item] => [
      structuredClone(byQid.get(s.fromQid)!),
      structuredClone(byQid.get(s.intoQid)!),
    ]);
    await attachSitelinkRedirects(db, itemPairs);
    const labelOf = await loadLabelLookup(db, itemPairs.flat());

    // The candidate row is ordered by age (from = newer, into = older), the
    // order the calibration renders pairs in.
    const prompts = itemPairs.map(([from, into]) => renderPair(from, into, labelOf));
    const cached = client ? await cachedPromptTokens(client) : 0;
    const pairs: SampledPair[] = [];
    const texts = new Map<string, string>();
    for (const [i, s] of complete.entries()) {
      const tokens = client ? await countPromptTokens(client, "claude-haiku-5-5", prompts[i]) : 0;
      if (tokens > MAX_PROMPT_TOKENS) {
        console.warn(`⚠ skipping candidate ${s.id}: ${tokens} prompt tokens`);
        continue;
      }
      const [from, into] = itemPairs[i];
      const label = (item: Item) =>
        item.labels.en ?? item.labels.mul ?? Object.values(item.labels)[0] ?? null;
      pairs.push({
        pair: String(s.id),
        candidateId: s.id,
        fromQid: s.fromQid,
        intoQid: s.intoQid,
        fromLabel: label(from),
        intoLabel: label(into),
        confidence: s.confidence,
        band: s.band,
        promptTokens: tokens,
      });
      texts.set(String(s.id), prompts[i]);
    }

    const run: Run = {
      createdAt: new Date().toISOString(),
      promptVersion: PROMPT_VERSION,
      openPerBand,
      batches: [],
    };
    const dir = join(RUNS_DIR, run.createdAt.replace(/[:.]/g, "-"));
    await mkdir(dir, { recursive: true });
    await writeJsonl(join(dir, "pairs.jsonl"), pairs);
    await writeJsonl(
      join(dir, "prompts.jsonl"),
      pairs.map((p) => ({ pair: p.pair, prompt: texts.get(p.pair) })),
    );
    // Rewritten after every batch is created, so a failure partway through
    // still leaves a record of the batches already running (and billing).
    const saveRun = () => writeFile(join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");
    await saveRun();
    if (!client) {
      console.log(
        `\nDry run: ${pairs.length} pairs and their prompts written to ${dir}; nothing sent.`,
      );
      return;
    }

    for (const model of MODELS) {
      const effort = REVIEW_MODELS[model].defaultEffort;
      const requests = [];
      for (const p of pairs) {
        const maxTokens = outputTokenBudget(model, p.promptTokens, cached);
        if (maxTokens === null) {
          console.warn(`⚠ skipping candidate ${p.pair} on ${model}: over the per-pair cap`);
          continue;
        }
        requests.push({
          custom_id: p.pair,
          params: reviewRequest(model, effort, texts.get(p.pair)!, maxTokens),
        });
      }
      const batch = await client.messages.batches.create({ requests });
      run.batches.push({ model, effort, batchId: batch.id, requests: requests.length });
      await saveRun();
      console.log(`${model} (effort ${effort}): batch ${batch.id}, ${requests.length} requests`);
    }
    console.log(`\nRun saved to ${dir}. Collect with: node jobs/llm-trial.ts collect ${dir}`);
    if (argv.includes("--wait")) await collect(dir, true);
  } finally {
    await pool.end();
  }
}

// ---------- collect ----------

/** How long after submit a batch may still 404 while the API catches up. */
const NEW_BATCH_GRACE_MS = 10 * 60_000;

async function collect(dir: string, wait: boolean): Promise<void> {
  const client = new Anthropic();
  const run = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as Run;
  let pending = [];
  for (const b of run.batches) if (!(await readJsonl(resultsPath(dir, b.model)))) pending.push(b);

  while (pending.length > 0) {
    const stillRunning = [];
    for (const b of pending) {
      let batch;
      try {
        batch = await client.messages.batches.retrieve(b.batchId);
      } catch (err) {
        const fresh = Date.now() - Date.parse(run.createdAt) < NEW_BATCH_GRACE_MS;
        if (!(err instanceof Anthropic.NotFoundError && fresh)) throw err;
        console.log(`${b.model}: just created, not visible to the API yet`);
        stillRunning.push(b);
        continue;
      }
      if (batch.processing_status === "ended") {
        const records: ResultRecord[] = [];
        for await (const result of await client.messages.batches.results(b.batchId)) {
          records.push(toRecord(b.model, result));
        }
        await writeJsonl(resultsPath(dir, b.model), records);
        console.log(`${b.model}: ${records.length} results saved`);
        continue;
      }
      const c = batch.request_counts;
      console.log(
        `${b.model}: ${batch.processing_status} (${c.processing} processing, ${c.succeeded} succeeded)`,
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
  await report(dir);
}

// ---------- report ----------

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`);
const usd = (n: number): string => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

const confidentlyDifferent = (r: Review | null | undefined): boolean =>
  r?.verdict === "different" && r.probability < HIDE_MAX_P;

function verdictCounts(reviews: (Review | null | undefined)[]): string {
  const n = (v: string) => reviews.filter((r) => r?.verdict === v).length;
  const failed = reviews.filter((r) => !r).length;
  return `${n("same")} same / ${n("different")} diff / ${n("unsure")} unsure${failed ? ` / ${failed} failed` : ""}`;
}

async function report(dir: string): Promise<void> {
  const run = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as Run;
  const pairs = (await readJsonl<SampledPair>(join(dir, "pairs.jsonl"))) ?? [];
  const results = new Map<ReviewModel, Map<string, ResultRecord>>();
  for (const model of MODELS) {
    const records = await readJsonl<ResultRecord>(resultsPath(dir, model));
    if (!records) throw new Error(`${dir} has no ${model} results yet: run collect first`);
    results.set(model, new Map(records.map((r) => [r.pair, r])));
  }
  const haiku = (p: SampledPair) => results.get("claude-haiku-5-5")!.get(p.pair);
  const opus = (p: SampledPair) => results.get("claude-opus-5-5")!.get(p.pair);
  const hide = (p: SampledPair) =>
    confidentlyDifferent(haiku(p)?.review) && confidentlyDifferent(opus(p)?.review);
  const disagree = (p: SampledPair) => {
    const [h, o] = [haiku(p)?.review?.verdict, opus(p)?.review?.verdict];
    return (h === "same" && o === "different") || (h === "different" && o === "same");
  };

  console.log(
    `\nClaude review trial — prompt v${run.promptVersion}, ${pairs.length} open candidates, run ${dir}`,
  );
  console.log(
    `Rule under trial: hide when Haiku and Opus both say "different" with p < ${HIDE_MAX_P}\n`,
  );

  // Per band: what each model said, how often Haiku would call in Opus, and
  // what the rule would hide.
  const avgCost = (model: ReviewModel, subset: SampledPair[]) =>
    subset.reduce((s, p) => s + (results.get(model)!.get(p.pair)?.costUsd ?? 0), 0) /
    Math.max(1, subset.length);
  let weightedRoute = 0;
  let weightedOpus = 0;
  let openTotal = 0;
  for (const band of BANDS.map(bandName)) {
    const inBand = pairs.filter((p) => p.band === band);
    if (inBand.length === 0) continue;
    const escalated = inBand.filter((p) => confidentlyDifferent(haiku(p)?.review));
    const hidden = inBand.filter(hide);
    console.log(`Band ${band} (${inBand.length} sampled of ${run.openPerBand[band]} open):`);
    console.log(`  haiku  ${verdictCounts(inBand.map((p) => haiku(p)?.review))}`);
    console.log(`  opus   ${verdictCounts(inBand.map((p) => opus(p)?.review))}`);
    console.log(
      `  haiku confidently "different": ${escalated.length} (${pct(escalated.length, inBand.length)}) → ` +
        `opus confirms ${hidden.length}; would hide ${pct(hidden.length, inBand.length)} of the band; ` +
        `${inBand.filter(disagree).length} same/different disagreements`,
    );
    // This band's cost per pair under the routing, weighted by its open queue.
    const route =
      avgCost("claude-haiku-5-5", inBand) +
      (escalated.length / inBand.length) * avgCost("claude-opus-5-5", inBand);
    const open = run.openPerBand[band] ?? 0;
    weightedRoute += route * open;
    weightedOpus += avgCost("claude-opus-5-5", inBand) * open;
    openTotal += open;
  }

  console.log("\nCost (Batch API prices):");
  for (const model of MODELS) {
    const total = [...results.get(model)!.values()].reduce((s, r) => s + r.costUsd, 0);
    console.log(`  ${REVIEW_MODELS[model].short.padEnd(6)} ${usd(total)} this run`);
  }
  if (openTotal > 0) {
    console.log(
      `  Projected per 10k open pairs, bands weighted by the open queue: ` +
        `Haiku → Opus on confident "different" ${usd((weightedRoute / openTotal) * 10_000)}, ` +
        `Opus alone ${usd((weightedOpus / openTotal) * 10_000)}`,
    );
    console.log(
      `  The whole open queue (${openTotal} pairs): ${usd(weightedRoute)} with the routing`,
    );
  }

  // review.md: every pair worth a human look, grouped by why.
  const entry = (p: SampledPair): string => {
    const line = (model: ReviewModel, r: ResultRecord | undefined) =>
      r?.review
        ? `  - **${REVIEW_MODELS[model].short}** ${r.review.verdict} (p=${r.review.probability.toFixed(2)}): ${r.review.rationale}`
        : `  - **${REVIEW_MODELS[model].short}** failed: ${r?.error ?? "no result"}`;
    return [
      `- [${p.fromLabel ?? p.fromQid} (${p.fromQid}) → ${p.intoLabel ?? p.intoQid} (${p.intoQid})](${SITE}/candidates/${p.candidateId}) · heuristic ${p.confidence.toFixed(2)}`,
      line("claude-haiku-5-5", haiku(p)),
      line("claude-opus-5-5", opus(p)),
    ].join("\n");
  };
  const sections: [string, string, SampledPair[]][] = [
    [
      "Would hide",
      `Both models say "different" with p < ${HIDE_MAX_P}. Each of these should really be distinct; any real duplicate here is a pair the rule would have buried.`,
      pairs.filter(hide),
    ],
    [
      "Haiku would escalate, Opus doesn't confirm",
      `Haiku says "different" with p < ${HIDE_MAX_P}, Opus doesn't. The confirmation step keeps these open; real duplicates here are what it saves.`,
      pairs.filter((p) => confidentlyDifferent(haiku(p)?.review) && !hide(p)),
    ],
    [
      "Opus is confident, Haiku isn't",
      `Opus says "different" with p < ${HIDE_MAX_P}, Haiku doesn't, so the routing never asks Opus. Distinct pairs here are what the routing leaves in the queue.`,
      pairs.filter(
        (p) => confidentlyDifferent(opus(p)?.review) && !confidentlyDifferent(haiku(p)?.review),
      ),
    ],
    ["Same vs different", 'One model says "same", the other "different".', pairs.filter(disagree)],
  ];
  const md = [
    `# Claude review trial, ${run.createdAt.slice(0, 10)}`,
    "",
    `Prompt v${run.promptVersion}, ${pairs.length} open candidates sampled across heuristic confidence bands. Nothing here was acted on.`,
  ];
  for (const [title, blurb, list] of sections) {
    md.push("", `## ${title} (${list.length})`, "", blurb);
    for (const band of BANDS.map(bandName)) {
      const inBand = list.filter((p) => p.band === band);
      if (inBand.length === 0) continue;
      md.push("", `### Heuristic ${band} (${inBand.length})`, "", ...inBand.map(entry));
    }
  }
  await writeFile(join(dir, "review.md"), md.join("\n") + "\n");
  console.log(
    `\nreview.md: ${sections.map(([title, , list]) => `${list.length} ${title.toLowerCase()}`).join(", ")}`,
  );
  console.log(`  ${join(dir, "review.md")}`);
}

// ---------- main ----------

async function latestRunDir(): Promise<string> {
  const dirs = (await readdir(RUNS_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (dirs.length === 0) throw new Error(`no runs under ${RUNS_DIR}; submit one first`);
  return join(RUNS_DIR, dirs[dirs.length - 1]);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const dirArg = argv[0] && !argv[0].startsWith("--") ? argv[0] : undefined;
  switch (command) {
    case "submit":
      await submit(argv);
      break;
    case "collect":
      await collect(dirArg ?? (await latestRunDir()), argv.includes("--wait"));
      break;
    case "report":
      await report(dirArg ?? (await latestRunDir()));
      break;
    default:
      console.log(
        "usage: node jobs/llm-trial.ts submit [--per-band N] [--wait] | collect [run-dir] [--wait] | report [run-dir]",
      );
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(2);
});
