// Backfill / extend `eval-data/subject-types.json` (see
// scripts/eval-subject-types.ts) with the subject type constraints and class
// ancestors every eval pair needs, and which of the pairs' shared id properties
// mirror Wikidata. Run it after adding pairs. Recorded entries
// are kept as they are; delete the file to re-record from scratch.
//
//   node scripts/resolve-eval-subject-types.ts

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Item } from "../src/lib/compare.ts";
import { type Entity, entityToItem } from "../src/lib/wikibase.ts";
import { recordSubjectTypes, SUBJECT_TYPES_PATH } from "./eval-subject-types.ts";

const EVAL_DIR = "eval-data";

const readItem = async (path: string) =>
  entityToItem(JSON.parse(await readFile(path, "utf8")) as Entity);

/** Every eval pair's two items. */
async function pairs(): Promise<[Item, Item][]> {
  const out: [Item, Item][] = [];
  for (const [kind, blob] of [
    [
      "merged-pairs",
      (m: Record<string, string>) => [`${m.source}.pre.json`, `${m.target}.pre.json`],
    ],
    ["non-dupe-pairs", (m: Record<string, string>) => [`${m.a}.json`, `${m.b}.json`]],
  ] as const) {
    const root = join(EVAL_DIR, kind);
    for (const d of await readdir(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = join(root, d.name);
      const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as Record<
        string,
        string
      >;
      const [fa, fb] = blob(meta);
      out.push([await readItem(join(dir, fa)), await readItem(join(dir, fb))]);
    }
  }
  return out;
}

async function main() {
  const { constraints, classes, mirrors } = await recordSubjectTypes(await pairs());
  console.log(
    `${SUBJECT_TYPES_PATH}: added constraints for ${constraints} properties, ` +
      `ancestors for ${classes} classes and mirror flags for ${mirrors} properties; ` +
      `recorded entries are kept as they were`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
