// Build positive examples for the merge-detection eval dataset (see PLAN.md,
// "Evaluation datasets"): for each already-merged item, fetch the two items as
// independent entities *right before* the merge — the exact pair the hunt would
// have had to catch.
//
// How a Wikidata merge is recoverable: merging SOURCE into TARGET leaves an
// audit trail in SOURCE's edit history — a `wbmergeitems-to:0||TARGET` revision
// (the merge) followed by a redirect. SOURCE keeps its full page history, so the
// revision *before* the merge edit is its complete pre-merge blob. TARGET gets a
// matching `wbmergeitems-from:0||SOURCE` revision; the revision before *that* is
// TARGET's last independent state. Fetch both at those pinned revisions.
//
// Pinning the revision is mandatory: Special:EntityData on a now-redirected item
// without ?revision= silently follows the redirect and returns TARGET instead.
//
// Usage (QIDs may be either side of a merge — the source is auto-detected):
//   tsx scripts/fetch-merge-pairs.ts Q135453621 Q131619393
//   tsx scripts/fetch-merge-pairs.ts --out eval-data/merged-pairs Q135453621 …

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const API = "https://www.wikidata.org/w/api.php";
const ENTITYDATA = "https://www.wikidata.org/wiki/Special:EntityData";
const UA =
  "mergers-and-acquisitions/0.1 (https://github.com/connorshea; Wikidata merge-eval dataset builder)";
const PAUSE_MS = 1000; // be polite to the API

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rev {
  revid: number;
  parentid: number;
  timestamp: string;
  user: string;
  comment: string;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/** Newest-first revision list for an item, with comments + parent ids. */
async function fetchRevisions(qid: string): Promise<Rev[]> {
  const url =
    `${API}?action=query&format=json&formatversion=2&prop=revisions&titles=${qid}` +
    `&rvlimit=50&rvprop=ids%7Ctimestamp%7Ccomment%7Cuser&rvslots=main`;
  const data = (await getJson(url)) as {
    query: { pages: { title: string; missing?: boolean; revisions?: Rev[] }[] };
  };
  const page = data.query.pages[0];
  if (!page || page.missing) throw new Error(`${qid}: no such page`);
  return page.revisions ?? [];
}

/** Full entity JSON blob at a specific revision (labels/aliases/claims/sitelinks). */
async function fetchEntityAt(qid: string, revid: number): Promise<Record<string, unknown>> {
  const data = (await getJson(`${ENTITYDATA}/${qid}.json?revision=${revid}`)) as {
    entities: Record<string, Record<string, unknown>>;
  };
  const entity = data.entities[qid];
  if (!entity) throw new Error(`${qid}@${revid}: entity missing from EntityData response`);
  return entity;
}

const enLabel = (entity: Record<string, unknown>): string | null => {
  const labels = entity.labels as Record<string, { value: string }> | undefined;
  return labels?.en?.value ?? labels?.mul?.value ?? null;
};

const MERGE_TO = /wbmergeitems-to:0\|\|(Q\d+)/;
const MERGE_FROM = /wbmergeitems-from:0\|\|(Q\d+)/;

interface Pair {
  source: string;
  target: string;
  sourcePreRevid: number;
  targetPreRevid: number;
  targetPostRevid: number;
  mergedAt: string;
}

/**
 * Given any QID touched by a merge, resolve the (source, target) pair and the
 * pinned revisions. Accepts either side: if given the target, it reads the
 * `wbmergeitems-from` comment to find the source, then works from the source.
 */
async function resolvePair(qid: string): Promise<Pair> {
  let revs = await fetchRevisions(qid);
  let source = qid;

  let toRev = revs.find((r) => MERGE_TO.test(r.comment));
  if (!toRev) {
    // Maybe we were handed the target — find the source via wbmergeitems-from.
    const fromRev = revs.find((r) => MERGE_FROM.test(r.comment));
    if (!fromRev)
      throw new Error(`${qid}: no merge revision (wbmergeitems-to/from) in last 50 edits`);
    source = MERGE_FROM.exec(fromRev.comment)![1];
    await sleep(PAUSE_MS);
    revs = await fetchRevisions(source);
    toRev = revs.find((r) => MERGE_TO.test(r.comment));
    if (!toRev) throw new Error(`${source}: expected a wbmergeitems-to revision but found none`);
  }

  const target = MERGE_TO.exec(toRev.comment)![1];
  if (toRev.parentid === 0)
    throw new Error(`${source}: merge revision has no parent (nothing before merge?)`);

  await sleep(PAUSE_MS);
  const targetRevs = await fetchRevisions(target);
  const fromRev = targetRevs.find(
    (r) => MERGE_FROM.test(r.comment) && MERGE_FROM.exec(r.comment)![1] === source,
  );
  if (!fromRev) throw new Error(`${target}: no wbmergeitems-from:${source} revision found`);

  return {
    source,
    target,
    sourcePreRevid: toRev.parentid,
    targetPreRevid: fromRev.parentid,
    targetPostRevid: fromRev.revid,
    mergedAt: toRev.timestamp,
  };
}

const pairKey = (source: string, target: string): string => `${source}_into_${target}`;

/**
 * Rewrite index.jsonl, keyed by `source_into_target`, so a pair present in both
 * the existing file and this run (or twice in one run) collapses to a single
 * line instead of duplicating. Existing lines keep their order; new pairs are
 * appended; a re-fetched pair updates its line in place. Also self-heals any
 * pre-existing duplicate lines.
 */
async function upsertIndex(indexPath: string, records: { source: string; target: string }[]) {
  const byKey = new Map<string, string>();
  try {
    const existing = await readFile(indexPath, "utf8");
    for (const line of existing.split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { source: string; target: string };
      byKey.set(pairKey(r.source, r.target), line);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const r of records) byKey.set(pairKey(r.source, r.target), JSON.stringify(r));
  await writeFile(indexPath, Array.from(byKey.values()).join("\n") + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  let outDir = "eval-data/merged-pairs";
  const qids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") outDir = args[++i];
    else if (/^Q\d+$/.test(args[i])) qids.push(args[i]);
    else throw new Error(`unexpected arg: ${args[i]} (want Qxxx or --out DIR)`);
  }
  if (qids.length === 0)
    throw new Error("usage: tsx scripts/fetch-merge-pairs.ts [--out DIR] Qxxx [Qxxx …]");

  await mkdir(outDir, { recursive: true });
  const indexPath = join(outDir, "index.jsonl");

  const records: { source: string; target: string }[] = [];
  const seen = new Set<string>();
  for (const qid of qids) {
    const pair = await resolvePair(qid);
    const key = pairKey(pair.source, pair.target);
    // Both sides of one merge resolve to the same pair — fetch it only once.
    if (seen.has(key)) {
      console.log(`${key}: already fetched this run (both sides given?), skipping`);
      continue;
    }
    seen.add(key);

    await sleep(PAUSE_MS);
    const [sourcePre, targetPre] = await Promise.all([
      fetchEntityAt(pair.source, pair.sourcePreRevid),
      fetchEntityAt(pair.target, pair.targetPreRevid),
    ]);

    const dir = join(outDir, key);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${pair.source}.pre.json`), JSON.stringify(sourcePre, null, 2));
    await writeFile(join(dir, `${pair.target}.pre.json`), JSON.stringify(targetPre, null, 2));

    const record = {
      label: "duplicate", // positive example: these two ARE the same subject
      source: pair.source,
      target: pair.target,
      sourceLabel: enLabel(sourcePre),
      targetLabel: enLabel(targetPre),
      sourcePreRevid: pair.sourcePreRevid,
      targetPreRevid: pair.targetPreRevid,
      targetPostRevid: pair.targetPostRevid,
      mergedAt: pair.mergedAt,
      provenance: "wikidata-merge-redirect",
    };
    await writeFile(join(dir, "meta.json"), JSON.stringify(record, null, 2));
    records.push(record);

    console.log(
      `${pair.source} (${record.sourceLabel}) -> ${pair.target} (${record.targetLabel})  ` +
        `pre-revs ${pair.sourcePreRevid}/${pair.targetPreRevid}  merged ${pair.mergedAt}`,
    );
    await sleep(PAUSE_MS);
  }
  await upsertIndex(indexPath, records);
  console.log(`\nWrote ${records.length} pair(s) to ${outDir} (index: ${indexPath})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
