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
//   node scripts/fetch-nondupe-pairs.ts Q4047343 Q1535818 Q140140365 Q213911
//   node scripts/fetch-nondupe-pairs.ts --out eval-data/non-dupe-pairs Q1 Q2

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Entity, entityToItem } from "../src/lib/wikibase.ts";
import { recordRedirects } from "./eval-redirects.ts";

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

/** The entity's current revision id, when the API supplied one. */
const revid = (entity: Record<string, unknown>): number | null =>
  typeof entity.lastrevid === "number" ? entity.lastrevid : null;

const enLabel = (entity: Record<string, unknown>): string | null => {
  const labels = entity.labels as Record<string, { value: string }> | undefined;
  return labels?.en?.value ?? labels?.mul?.value ?? null;
};

const pairKey = (a: string, b: string): string => `${a}_vs_${b}`;

/**
 * Rewrite index.jsonl keyed by `<a>_vs_<b>`, so a pair present in both the file
 * and this run (or twice in one run) collapses to a single line instead of
 * duplicating. Existing lines keep order; new pairs append; a re-fetched pair
 * updates in place. Also self-heals any pre-existing duplicate lines.
 */
async function upsertIndex(indexPath: string, records: { a: string; b: string }[]) {
  const byKey = new Map<string, string>();
  try {
    const existing = await readFile(indexPath, "utf8");
    for (const line of existing.split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { a: string; b: string };
      byKey.set(pairKey(r.a, r.b), line);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const r of records) byKey.set(pairKey(r.a, r.b), JSON.stringify(r));
  await writeFile(indexPath, Array.from(byKey.values()).join("\n") + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  let outDir = "eval-data/non-dupe-pairs";
  let provenance = "hand-curated";
  const qids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") outDir = args[++i];
    else if (args[i] === "--provenance") provenance = args[++i];
    else if (/^Q\d+$/.test(args[i])) qids.push(args[i]);
    else throw new Error(`unexpected arg: ${args[i]} (want Qxxx, --out DIR, or --provenance STR)`);
  }
  if (qids.length === 0 || qids.length % 2 !== 0)
    throw new Error(
      "usage: node scripts/fetch-nondupe-pairs.ts [--out DIR] Qa Qb [Qc Qd …] (pairs)",
    );

  await mkdir(outDir, { recursive: true });
  const indexPath = join(outDir, "index.jsonl");

  const records: { a: string; b: string }[] = [];
  const seen = new Set<string>();
  let failed = 0;
  for (let i = 0; i < qids.length; i += 2) {
    // Canonicalize each pair (lower QID number first) so directory names are
    // stable regardless of the order the two ids were given.
    const [a, b] =
      qidNum(qids[i]) <= qidNum(qids[i + 1]) ? [qids[i], qids[i + 1]] : [qids[i + 1], qids[i]];
    if (a === b) {
      // Guard against a fat-fingered arg list (Qx Qx) producing a degenerate
      // "item vs itself" pair, which is not a valid negative example.
      console.warn(`${a}: skipped — a pair needs two distinct QIDs`);
      failed++;
      continue;
    }
    const key = pairKey(a, b);
    if (seen.has(key)) {
      console.log(`${key}: already fetched this run, skipping`);
      continue;
    }
    seen.add(key);
    // One un-fetchable item (since merged/deleted, or an API hiccup) must not
    // abort a whole batch — log it and move on. Useful for bulk candidate lists.
    let ea: Record<string, unknown>;
    let eb: Record<string, unknown>;
    try {
      [ea, eb] = await Promise.all([fetchEntity(a), fetchEntity(b)]);
    } catch (err) {
      failed++;
      console.warn(`${key}: skipped — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const dir = join(outDir, key);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${a}.json`), JSON.stringify(ea, null, 2));
    await writeFile(join(dir, `${b}.json`), JSON.stringify(eb, null, 2));

    // Where clashing sitelinks redirect, so the scorer sees what production's
    // replica overlay would. A wiki that can't be read doesn't sink the pair.
    try {
      await recordRedirects(
        dir,
        entityToItem(ea as unknown as Entity),
        entityToItem(eb as unknown as Entity),
      );
    } catch (err) {
      console.warn(
        `${key}: sitelink redirects not recorded — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const record = {
      label: "distinct", // negative example: these two are NOT the same subject
      a,
      b,
      aLabel: enLabel(ea),
      bLabel: enLabel(eb),
      aRevid: revid(ea),
      bRevid: revid(eb),
      provenance,
    };
    await writeFile(join(dir, "meta.json"), JSON.stringify(record, null, 2));
    records.push(record);

    console.log(
      `${a} (${record.aLabel})  vs  ${b} (${record.bLabel})  [revs ${record.aRevid}/${record.bRevid}]`,
    );
    await sleep(PAUSE_MS);
  }
  await upsertIndex(indexPath, records);
  console.log(
    `\nWrote ${records.length} pair(s) to ${outDir} (index: ${indexPath})` +
      (failed > 0 ? `; ${failed} pair(s) skipped` : ""),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
