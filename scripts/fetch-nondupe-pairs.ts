// Build negative examples for the merge-detection eval dataset (see PLAN.md /
// eval-data/README.md): hand-curated pairs of items that are confirmed NOT
// duplicates. Unlike positives, negatives have no merge trail — they're two
// live, distinct items — so we just fetch each at its current revision.
//
// The valuable negatives are *hard* ones: pairs that look mergeable (shared
// label/type, a common blocking bucket) but are genuinely different subjects.
// Those are exactly the pairs a maintainer notices and supplies here.
//
// Usage — QIDs are taken pairwise (Q1 Q2  Q3 Q4  → two pairs):
//   tsx scripts/fetch-nondupe-pairs.ts Q4047343 Q1535818 Q140140365 Q213911
//   tsx scripts/fetch-nondupe-pairs.ts --out eval-data/non-dupe-pairs Q1 Q2

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

const ENTITYDATA = "https://www.wikidata.org/wiki/Special:EntityData";
const UA =
  "mergers-and-acquisitions/0.1 (https://github.com/connorshea; Wikidata merge-eval dataset builder)";
const PAUSE_MS = 1000; // be polite to the API

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const qidNum = (id: string): number => parseInt(id.replace(/^Q/, ""), 10);

/** Current full entity JSON blob (labels/aliases/claims/sitelinks). */
async function fetchEntity(qid: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${ENTITYDATA}/${qid}.json`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${qid} -> ${res.status}`);
  const data = (await res.json()) as { entities: Record<string, Record<string, unknown>> };
  const entity = data.entities[qid];
  // A redirected/merged item resolves to a different id — reject it: a negative
  // pair must be two genuinely live, distinct items.
  if (!entity) throw new Error(`${qid}: not in response (redirected or missing?)`);
  return entity;
}

const enLabel = (entity: Record<string, unknown>): string | null => {
  const labels = entity.labels as Record<string, { value: string }> | undefined;
  return labels?.en?.value ?? labels?.mul?.value ?? null;
};

async function main() {
  const args = process.argv.slice(2);
  let outDir = "eval-data/non-dupe-pairs";
  const qids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") outDir = args[++i];
    else if (/^Q\d+$/.test(args[i])) qids.push(args[i]);
    else throw new Error(`unexpected arg: ${args[i]} (want Qxxx or --out DIR)`);
  }
  if (qids.length === 0 || qids.length % 2 !== 0)
    throw new Error(
      "usage: tsx scripts/fetch-nondupe-pairs.ts [--out DIR] Qa Qb [Qc Qd …] (pairs)",
    );

  await mkdir(outDir, { recursive: true });
  const indexPath = join(outDir, "index.jsonl");

  for (let i = 0; i < qids.length; i += 2) {
    // Canonicalize each pair (lower QID number first) so directory names are
    // stable regardless of the order the two ids were given.
    const [a, b] =
      qidNum(qids[i]) <= qidNum(qids[i + 1]) ? [qids[i], qids[i + 1]] : [qids[i + 1], qids[i]];
    const [ea, eb] = await Promise.all([fetchEntity(a), fetchEntity(b)]);

    const dir = join(outDir, `${a}_vs_${b}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${a}.json`), JSON.stringify(ea, null, 2));
    await writeFile(join(dir, `${b}.json`), JSON.stringify(eb, null, 2));

    const record = {
      label: "distinct", // negative example: these two are NOT the same subject
      a,
      b,
      aLabel: enLabel(ea),
      bLabel: enLabel(eb),
      aRevid: ea.lastrevid ?? null,
      bRevid: eb.lastrevid ?? null,
      provenance: "hand-curated",
    };
    await writeFile(join(dir, "meta.json"), JSON.stringify(record, null, 2));
    await appendFile(indexPath, JSON.stringify(record) + "\n");

    console.log(
      `${a} (${record.aLabel})  vs  ${b} (${record.bLabel})  [revs ${record.aRevid}/${record.bRevid}]`,
    );
    await sleep(PAUSE_MS);
  }
  console.log(`\nWrote ${qids.length / 2} pair(s) to ${outDir} (index: ${indexPath})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
