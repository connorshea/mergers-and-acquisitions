// The labelled pairs under eval-data/ (positives from merged-pairs/, negatives
// from non-dupe-pairs/), adapted into the `Item` shape the scorer consumes, and
// the heuristic scorer run over them as production runs it. Shared by the
// heuristic eval (scripts/eval-score.ts) and the LLM calibration
// (scripts/eval-llm.ts), so both judge exactly the same pairs.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Item, ScoreOptions } from "../src/lib/compare.ts";
import { orderByAge, scoreCandidate } from "../src/lib/compare.ts";
import { type Entity, entityToItem } from "../src/lib/wikibase.ts";
import { applyRedirects } from "./eval-redirects.ts";
import { loadInapplicableIdCheck, loadMirroredIdCheck } from "./eval-subject-types.ts";

export const EVAL_DIR = "eval-data";

export interface Pair {
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
    const a = entityToItem(await readEntity(join(root, d.name, `${meta.source}.pre.json`)));
    const b = entityToItem(await readEntity(join(root, d.name, `${meta.target}.pre.json`)));
    await applyRedirects(join(root, d.name), a, b);
    pairs.push({ name: d.name, label: "duplicate", a, b });
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
    const a = entityToItem(await readEntity(join(root, d.name, `${meta.a}.json`)));
    const b = entityToItem(await readEntity(join(root, d.name, `${meta.b}.json`)));
    await applyRedirects(join(root, d.name), a, b);
    pairs.push({ name: d.name, label: "distinct", a, b });
  }
  return pairs;
}

/** Every labelled pair: the positives, then the negatives. */
export async function loadPairs(): Promise<Pair[]> {
  return [...(await loadPositives()), ...(await loadNegatives())];
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

export type HeuristicScorer = (pair: Pair) => { confidence: number; reasons: string[] };

/**
 * The heuristic scorer (src/lib/compare.ts) as production runs it: the pair
 * ordered by age, external ids classified by their real datatypes, and the
 * subject type and mirror checks read from eval-data/subject-types.json.
 */
export async function loadHeuristicScorer(): Promise<HeuristicScorer> {
  const isInapplicableId = await loadInapplicableIdCheck();
  const isMirroredIdProp = await loadMirroredIdCheck();
  return (pair) => {
    const idProps = identifierProps(pair.a, pair.b);
    const opts: ScoreOptions = { isInapplicableId, isMirroredIdProp };
    if (idProps.size > 0) opts.isIdentifierProp = (pid) => idProps.has(pid);
    const [from, into] = orderByAge(pair.a, pair.b);
    return scoreCandidate(from, into, opts);
  };
}
