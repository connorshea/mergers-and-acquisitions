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
// them. Resolved sitelink redirects
// (Item.sitelinkRedirects) come from each pair's sitelink-redirects.json, when
// recorded (scripts/eval-redirects.ts). Subject type constraints and class
// ancestors (`isInapplicableId`), and which shared ids mirror Wikidata
// (`isMirroredIdProp`, production's synced `properties.mirrors_wikidata`), come
// from eval-data/subject-types.json (scripts/eval-subject-types.ts). The threshold mirrors the hunt's
// MIN_CONFIDENCE (0.4).

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EVAL_DIR,
  type HeuristicScorer,
  loadHeuristicScorer,
  loadPairs,
  type Pair,
} from "./eval-pairs.ts";

const BASELINE_PATH = join(EVAL_DIR, "score-baseline.json");
const DEFAULT_THRESHOLD = 0.4; // mirrors hunt.ts MIN_CONFIDENCE

// ---------- scoring + reporting ----------

interface Scored extends Pair {
  confidence: number;
  predicted: "duplicate" | "distinct";
  correct: boolean;
  reasons: string[];
}

function scorePair(pair: Pair, threshold: number, score: HeuristicScorer): Scored {
  const { confidence, reasons } = score(pair);
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

  const pairs = await loadPairs();
  const score = await loadHeuristicScorer();
  const scored = pairs.map((p) => scorePair(p, threshold, score));
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
