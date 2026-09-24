// Backfill / refresh `sitelink-redirects.json` for eval pairs (see
// scripts/eval-redirects.ts). The fetchers record it for new pairs; run this
// for pairs added before that. A re-run only adds redirects not yet recorded:
// recorded entries are kept even after the wiki changes (see eval-redirects.ts).
//
//   node scripts/resolve-eval-redirects.ts              # every pair
//   node scripts/resolve-eval-redirects.ts Q4700160_vs_Q137330193 …   # named pairs

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type Entity, entityToItem } from "../src/lib/wikibase.ts";
import { recordRedirects } from "./eval-redirects.ts";

const EVAL_DIR = "eval-data";
const PAUSE_MS = 1000; // be polite to the wikis

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readItem = async (path: string) =>
  entityToItem(JSON.parse(await readFile(path, "utf8")) as Entity);

/** Each pair directory with the paths of its two blobs. */
async function pairDirs(): Promise<{ name: string; dir: string; files: [string, string] }[]> {
  const out: { name: string; dir: string; files: [string, string] }[] = [];
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
      out.push({ name: d.name, dir, files: [join(dir, fa), join(dir, fb)] });
    }
  }
  return out;
}

/** Retry a wiki's HTTP 429 a few times, waiting longer each time. */
async function withBackoff<T>(fn: () => Promise<T>): Promise<T> {
  for (const wait of [5_000, 15_000, 45_000]) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof Error && err.message.endsWith(" 429"))) throw err;
      await sleep(wait);
    }
  }
  return fn();
}

async function main() {
  const only = new Set(process.argv.slice(2));
  const pairs = (await pairDirs()).filter((p) => only.size === 0 || only.has(p.name));
  if (only.size > 0 && pairs.length < only.size) {
    const found = new Set(pairs.map((p) => p.name));
    throw new Error(`no such pair: ${[...only].filter((n) => !found.has(n)).join(", ")}`);
  }
  let written = 0;
  let failed = 0;
  for (const { name, dir, files } of pairs) {
    const [a, b] = await Promise.all(files.map(readItem));
    try {
      const { file, added } = await withBackoff(() => recordRedirects(dir, a, b));
      if (!file) continue;
      if (added > 0) written++;
      const found = Object.entries(file.redirects).flatMap(([qid, r]) =>
        Object.entries(r).map(([wiki, t]) => `${qid} ${wiki} → ${t ?? "(off-wiki)"}`),
      );
      console.log(`${name}: ${found.join("; ")}${added > 0 ? ` (${added} new)` : ""}`);
    } catch (err) {
      failed++;
      console.warn(`${name}: skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(PAUSE_MS);
  }
  console.log(
    `\nAdded redirects to ${written} pair(s); recorded entries are kept as they were` +
      (failed > 0 ? `; ${failed} skipped` : ""),
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
