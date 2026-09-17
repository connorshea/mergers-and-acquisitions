// Offline eval harness for the duplicate scorer (src/lib/compare.ts).
//
// Loads every labelled pair under eval-data/ (positives from merged-pairs/,
// negatives from non-dupe-pairs/), adapts each item's full Wikibase entity JSON
// into the `Item` shape scoreCandidate consumes, scores the pair, and reports a
// confusion matrix, precision/recall/F1, and every pair the scorer gets wrong.
//
// This is the regression signal for scoring changes: a heuristic tweak can be
// judged against a fixed benchmark instead of by eye. It is DOM-free, needs no
// DB and no network (it reads the checked-in blobs), so it runs in-sandbox:
//
//   node scripts/eval-score.ts            # or: pnpm eval:score
//   node scripts/eval-score.ts --threshold 0.5   # sweep the decision boundary
//   node scripts/eval-score.ts --verbose         # print every pair's score
//   node scripts/eval-score.ts --update-baseline # re-record the baseline
//
// Pass/fail is a BASELINE-REGRESSION gate, not a demand for a perfect score: the
// dataset deliberately includes hard positives the scorer can't yet catch (e.g.
// merges whose two names genuinely differ). The checked-in baseline
// (eval-data/score-baseline.json) records each pair's current correct/incorrect
// verdict; a run exits non-zero only if a pair the baseline got RIGHT is now
// wrong (a true regression), or the baseline is missing. Newly-added pairs and
// newly-fixed pairs are reported as warnings — fold them in with
// --update-baseline (and commit the baseline) once you've eyeballed the change.
//
// Scoring parity with production: the full entity JSON carries real property
// datatypes, so external identifiers are classified exactly (not by value-shape
// as the dump path must), and `isIdentifierProp` is reproduced faithfully from
// them. `isMirroredIdProp` (from the synced properties table) is NOT available
// offline, so only compare.ts's hardcoded MIRRORED_ID_PROPS floor applies here —
// pairs whose only mirror-Wikidata ids are sync-detected (untagged in the floor)
// could score marginally differently in production. The threshold mirrors the
// hunt's MIN_CONFIDENCE (0.4).

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Item, Value, ValueType, ScoreOptions } from "../src/lib/compare.ts";
import { orderByAge, scoreCandidate } from "../src/lib/compare.ts";

const EVAL_DIR = "eval-data";
const BASELINE_PATH = join(EVAL_DIR, "score-baseline.json");
const DEFAULT_THRESHOLD = 0.4; // mirrors hunt.ts MIN_CONFIDENCE

// ---------- Wikibase entity JSON -> Item ----------

interface Snak {
  snaktype: "value" | "novalue" | "somevalue";
  property: string;
  datatype?: string;
  datavalue?: { type: string; value: unknown };
}
interface Statement {
  mainsnak: Snak;
  rank: "preferred" | "normal" | "deprecated";
}
interface Entity {
  id: string;
  labels?: Record<string, { value: string }>;
  descriptions?: Record<string, { value: string }>;
  aliases?: Record<string, { value: string }[]>;
  sitelinks?: Record<string, { title: string }>;
  claims?: Record<string, Statement[]>;
}

const termMap = (o?: Record<string, { value: string }>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o ?? {})) out[k] = v.value;
  return out;
};

/** Convert one mainsnak into a scorer Value, or null for no-value/unknown snaks. */
function snakValue(snak: Snak): Value | null {
  if (snak.snaktype !== "value" || !snak.datavalue) return null;
  const { type, value } = snak.datavalue;
  switch (type) {
    case "wikibase-entityid":
      return { type: "item", value: (value as { id: string }).id };
    case "time":
      return { type: "time", value: (value as { time: string }).time };
    case "quantity":
      return { type: "quantity", value: (value as { amount: string }).amount };
    case "monolingualtext":
      return { type: "string", value: (value as { text: string }).text };
    case "globecoordinate": {
      const c = value as { latitude: number; longitude: number };
      return { type: "string", value: `${c.latitude},${c.longitude}` };
    }
    case "string": {
      // The one case where the property datatype disambiguates the literal.
      const t: ValueType =
        snak.datatype === "external-id"
          ? "external-id"
          : snak.datatype === "url"
            ? "url"
            : "string";
      return { type: t, value: value as string };
    }
    default:
      return { type: "string", value: String(value) };
  }
}

/**
 * Keep only best-rank statements per property, matching the `wdt:` truthy
 * semantics the production dump path sees: deprecated ranks are dropped, and if
 * any preferred-rank statement exists only those are kept, else the normals.
 */
function bestRank(statements: Statement[]): Statement[] {
  const live = statements.filter((s) => s.rank !== "deprecated");
  const preferred = live.filter((s) => s.rank === "preferred");
  return preferred.length > 0 ? preferred : live;
}

function entityToItem(entity: Entity): Item {
  const statements: Record<string, Value[]> = {};
  for (const [pid, sts] of Object.entries(entity.claims ?? {})) {
    const values = bestRank(sts)
      .map((s) => snakValue(s.mainsnak))
      .filter((v): v is Value => v !== null);
    if (values.length > 0) statements[pid] = values;
  }

  const aliases: Record<string, string[]> = {};
  for (const [lang, list] of Object.entries(entity.aliases ?? {})) {
    aliases[lang] = list.map((a) => a.value);
  }

  const sitelinks: Record<string, string> = {};
  for (const [site, link] of Object.entries(entity.sitelinks ?? {})) {
    sitelinks[site] = link.title;
  }

  return {
    id: entity.id,
    labels: termMap(entity.labels),
    descriptions: termMap(entity.descriptions),
    aliases,
    sitelinks,
    statements,
  };
}

/** Property ids classified as genuine external identifiers across both items. */
function identifierProps(...items: Item[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    for (const [pid, values] of Object.entries(item.statements)) {
      if (values.some((v) => v.type === "external-id")) ids.add(pid);
    }
  }
  return ids;
}

// ---------- eval dataset loading ----------

interface Pair {
  name: string; // directory name, for reporting
  label: "duplicate" | "distinct";
  a: Item;
  b: Item;
}

async function readEntity(path: string): Promise<Entity> {
  return JSON.parse(await readFile(path, "utf8")) as Entity;
}

/** Positives: merged-pairs/<SOURCE>_into_<TARGET>/{SOURCE,TARGET}.pre.json */
async function loadPositives(): Promise<Pair[]> {
  const root = join(EVAL_DIR, "merged-pairs");
  const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  const pairs: Pair[] = [];
  for (const d of dirs) {
    const meta = JSON.parse(await readFile(join(root, d.name, "meta.json"), "utf8")) as {
      source: string;
      target: string;
    };
    const a = await readEntity(join(root, d.name, `${meta.source}.pre.json`));
    const b = await readEntity(join(root, d.name, `${meta.target}.pre.json`));
    pairs.push({ name: d.name, label: "duplicate", a: entityToItem(a), b: entityToItem(b) });
  }
  return pairs;
}

/** Negatives: non-dupe-pairs/<A>_vs_<B>/{A,B}.json */
async function loadNegatives(): Promise<Pair[]> {
  const root = join(EVAL_DIR, "non-dupe-pairs");
  const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  const pairs: Pair[] = [];
  for (const d of dirs) {
    const meta = JSON.parse(await readFile(join(root, d.name, "meta.json"), "utf8")) as {
      a: string;
      b: string;
    };
    const a = await readEntity(join(root, d.name, `${meta.a}.json`));
    const b = await readEntity(join(root, d.name, `${meta.b}.json`));
    pairs.push({ name: d.name, label: "distinct", a: entityToItem(a), b: entityToItem(b) });
  }
  return pairs;
}

// ---------- scoring + reporting ----------

interface Scored extends Pair {
  confidence: number;
  predicted: "duplicate" | "distinct";
  correct: boolean;
  reasons: string[];
}

function scorePair(pair: Pair, threshold: number): Scored {
  const idProps = identifierProps(pair.a, pair.b);
  const opts: ScoreOptions = {};
  if (idProps.size > 0) opts.isIdentifierProp = (pid) => idProps.has(pid);
  const [from, into] = orderByAge(pair.a, pair.b);
  const { confidence, reasons } = scoreCandidate(from, into, opts);
  const predicted = confidence >= threshold ? "duplicate" : "distinct";
  return { ...pair, confidence, predicted, correct: predicted === pair.label, reasons };
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`;
}

interface Metrics {
  pairs: number;
  duplicate: number;
  distinct: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
}

/** Confusion matrix + derived metrics over the scored pairs (positive = duplicate). */
function computeMetrics(scored: Scored[]): Metrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const s of scored) {
    const hit = s.predicted === "duplicate";
    if (s.label === "duplicate") {
      if (hit) tp++;
      else fn++;
    } else {
      if (hit) fp++;
      else tn++;
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const pairs = scored.length;
  const accuracy = pairs === 0 ? 0 : (tp + tn) / pairs;
  return {
    pairs,
    duplicate: tp + fn,
    distinct: fp + tn,
    tp,
    fp,
    tn,
    fn,
    accuracy,
    precision,
    recall,
    f1,
  };
}

interface Baseline {
  threshold: number;
  generatedAt: string;
  summary: {
    pairs: number;
    duplicate: number;
    distinct: number;
    accuracy: number;
    precision: number;
    recall: number;
    f1: number;
  };
  // Per pair, keyed by its directory name: the ground-truth label, whether the
  // scorer currently gets it right, and its confidence (for human diffing).
  pairs: Record<string, { label: "duplicate" | "distinct"; correct: boolean; confidence: number }>;
}

const round4 = (n: number): number => Number(n.toFixed(4));

function buildBaseline(scored: Scored[], m: Metrics, threshold: number): Baseline {
  const pairs: Baseline["pairs"] = {};
  for (const s of [...scored].sort((a, b) => a.name.localeCompare(b.name))) {
    pairs[s.name] = { label: s.label, correct: s.correct, confidence: round4(s.confidence) };
  }
  return {
    threshold,
    generatedAt: new Date().toISOString(),
    summary: {
      pairs: m.pairs,
      duplicate: m.duplicate,
      distinct: m.distinct,
      accuracy: round4(m.accuracy),
      precision: round4(m.precision),
      recall: round4(m.recall),
      f1: round4(m.f1),
    },
    pairs,
  };
}

async function loadBaseline(): Promise<Baseline | null> {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, "utf8")) as Baseline;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Compare the current run against the checked-in baseline. Returns a process
 * exit code: non-zero ONLY on a true regression (a pair the baseline classified
 * correctly is now wrong). New pairs, removed pairs, and newly-fixed pairs are
 * reported as warnings but never fail the gate — fold them in with
 * --update-baseline.
 */
function gate(scored: Scored[], baseline: Baseline): number {
  const current = new Map(scored.map((s) => [s.name, s]));
  const regressions: string[] = [];
  const fixed: string[] = [];
  const removed: string[] = [];
  for (const [name, base] of Object.entries(baseline.pairs)) {
    const cur = current.get(name);
    if (!cur) {
      removed.push(name);
      continue;
    }
    if (base.correct && !cur.correct) regressions.push(name);
    else if (!base.correct && cur.correct) fixed.push(name);
  }
  const added = scored.filter((s) => !(s.name in baseline.pairs));
  const newMisses = added.filter((s) => !s.correct).length;

  console.log(
    `\nBaseline gate — baseline F1 ${baseline.summary.f1.toFixed(3)}, ` +
      `${Object.keys(baseline.pairs).length} pairs @ threshold ${baseline.threshold} ` +
      `(recorded ${baseline.generatedAt}):`,
  );
  if (removed.length > 0)
    console.log(
      `  ⚠ ${removed.length} baseline pair(s) no longer present (stale baseline): ${removed.join(", ")}`,
    );
  if (added.length > 0)
    console.log(
      `  ⚠ ${added.length} new pair(s) not in baseline (${newMisses} currently missed). ` +
        `Run --update-baseline to record them.`,
    );
  if (fixed.length > 0)
    console.log(
      `  ✓ ${fixed.length} pair(s) the baseline missed are now caught — tighten the baseline: ${fixed.join(", ")}`,
    );
  if (regressions.length > 0) {
    console.log(
      `  ✗ REGRESSION — ${regressions.length} pair(s) the baseline got right are now wrong:`,
    );
    for (const n of regressions) console.log(`      ${n}`);
    return 1;
  }
  console.log("  No regressions against the baseline. ✅");
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  const updateBaseline = argv.includes("--update-baseline");
  const ti = argv.indexOf("--threshold");
  const threshold = ti >= 0 ? Number(argv[ti + 1]) : DEFAULT_THRESHOLD;
  if (Number.isNaN(threshold)) throw new Error("--threshold expects a number");

  const pairs = [...(await loadPositives()), ...(await loadNegatives())];
  const scored = pairs.map((p) => scorePair(p, threshold));
  const m = computeMetrics(scored);

  console.log(`Eval harness — threshold ${threshold} (duplicate if confidence ≥ threshold)\n`);
  console.log(`Pairs: ${m.pairs}  (${m.duplicate} duplicate, ${m.distinct} distinct)\n`);
  console.log("Confusion matrix (positive = duplicate):");
  console.log(`                 predicted dup   predicted distinct`);
  console.log(
    `  actual dup          ${String(m.tp).padStart(3)}              ${String(m.fn).padStart(3)}   (FN)`,
  );
  console.log(
    `  actual distinct     ${String(m.fp).padStart(3)} (FP)          ${String(m.tn).padStart(3)}\n`,
  );
  console.log(`Accuracy : ${pct(m.tp + m.tn, m.pairs)}`);
  console.log(`Precision: ${pct(m.tp, m.tp + m.fp)}   (of predicted dups, how many are real)`);
  console.log(`Recall   : ${pct(m.tp, m.tp + m.fn)}   (of real dups, how many we catch)`);
  console.log(`F1       : ${m.f1.toFixed(3)}`);

  const wrong = scored.filter((s) => !s.correct);
  if (wrong.length > 0) {
    console.log(`\nMisclassified (${wrong.length}):`);
    for (const s of wrong) {
      const kind = s.label === "duplicate" ? "FALSE NEGATIVE" : "FALSE POSITIVE";
      console.log(`  [${kind}] ${s.name}  conf=${s.confidence.toFixed(3)}`);
      for (const r of s.reasons) console.log(`      · ${r}`);
    }
  } else {
    console.log("\nAll pairs classified correctly. ✅");
  }

  if (verbose) {
    console.log("\nAll pairs (by confidence):");
    for (const s of [...scored].sort((x, y) => y.confidence - x.confidence)) {
      const mark = s.correct ? " " : "✗";
      console.log(
        `  ${mark} ${s.confidence.toFixed(3)}  ${s.label.padEnd(9)} ${s.predicted.padEnd(9)} ${s.name}`,
      );
    }
  }

  if (updateBaseline) {
    await writeFile(
      BASELINE_PATH,
      JSON.stringify(buildBaseline(scored, m, threshold), null, 2) + "\n",
    );
    console.log(`\nWrote baseline (${m.pairs} pairs, F1 ${m.f1.toFixed(3)}) to ${BASELINE_PATH}.`);
    process.exit(0);
  }

  const baseline = await loadBaseline();
  if (!baseline) {
    console.log(
      `\nNo baseline at ${BASELINE_PATH} — run \`node scripts/eval-score.ts --update-baseline\` ` +
        `to record one. (Not gating this run.)`,
    );
    process.exit(0);
  }
  if (threshold !== baseline.threshold) {
    console.log(
      `\nThreshold ${threshold} ≠ baseline threshold ${baseline.threshold} — reporting only, not gating.`,
    );
    process.exit(0);
  }
  process.exit(gate(scored, baseline));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(2);
});
