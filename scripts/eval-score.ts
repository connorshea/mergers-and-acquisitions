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
//
// Scoring parity with production: the full entity JSON carries real property
// datatypes, so external identifiers are classified exactly (not by value-shape
// as the dump path must), and `isIdentifierProp` is reproduced faithfully from
// them. `isMirroredIdProp` (from the synced properties table) is NOT available
// offline, so only compare.ts's hardcoded MIRRORED_ID_PROPS floor applies here —
// pairs whose only mirror-Wikidata ids are sync-detected (untagged in the floor)
// could score marginally differently in production. The threshold mirrors the
// hunt's MIN_CONFIDENCE (0.4).

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Item, Value, ValueType, ScoreOptions } from "../src/lib/compare.ts";
import { orderByAge, scoreCandidate } from "../src/lib/compare.ts";

const EVAL_DIR = "eval-data";
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

async function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  const ti = argv.indexOf("--threshold");
  const threshold = ti >= 0 ? Number(argv[ti + 1]) : DEFAULT_THRESHOLD;
  if (Number.isNaN(threshold)) throw new Error("--threshold expects a number");

  const pairs = [...(await loadPositives()), ...(await loadNegatives())];
  const scored = pairs.map((p) => scorePair(p, threshold));

  // Confusion matrix — positive class is "duplicate".
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

  console.log(`Eval harness — threshold ${threshold} (duplicate if confidence ≥ threshold)\n`);
  console.log(`Pairs: ${pairs.length}  (${tp + fn} duplicate, ${fp + tn} distinct)\n`);
  console.log("Confusion matrix (positive = duplicate):");
  console.log(`                 predicted dup   predicted distinct`);
  console.log(
    `  actual dup          ${String(tp).padStart(3)}              ${String(fn).padStart(3)}   (FN)`,
  );
  console.log(
    `  actual distinct     ${String(fp).padStart(3)} (FP)          ${String(tn).padStart(3)}\n`,
  );
  console.log(`Accuracy : ${pct(tp + tn, pairs.length)}`);
  console.log(`Precision: ${pct(tp, tp + fp)}   (of predicted dups, how many are real)`);
  console.log(`Recall   : ${pct(tp, tp + fn)}   (of real dups, how many we catch)`);
  console.log(`F1       : ${f1.toFixed(3)}`);

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

  // Non-zero exit if the scorer misclassifies anything — usable as a CI gate.
  process.exit(wrong.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(2);
});
