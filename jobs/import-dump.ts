// One-off / weekly job: (re)build the item mirror from the Wikidata entity JSON
// dump on Toolforge's NFS mount (see server/dump-import.ts). Needs `mount: all`
// in jobs.yaml so /public/dumps is visible, and ~1 CPU / 4Gi for a few hours.
//
//   node jobs/import-dump.ts                     # full pass + prune
//   DUMP_LIMIT=2000 node jobs/import-dump.ts     # stop after 2000 games (timing check)
//   WIKIDATA_JSON_DUMP=/path/to/dump.json.gz …   # another dump (plain .json works too)
//   DUMP_PRUNE=0 …                               # keep items missing from the dump
//   DUMP_PRUNE_FORCE=1 …                         # prune past the 20% safety cap
//   node jobs/import-dump.ts --shard 3/8         # read the third of eight slices
//
// `--shard i/N` splits the pass across N jobs (one per slice, all with the same
// dump): each reads an N-th of the .gz, and whichever finishes the set prunes.
// Every slice job must use the same N. Without the flag the job reads the
// whole file, which is `--shard 1/1`.
import { realpathSync } from "node:fs";
import { pool } from "../server/db.ts";
import { DEFAULT_DUMP_PATH, type DumpShard, runDumpImport } from "../server/dump-import.ts";

function parseShard(argv: string[]): DumpShard {
  const at = argv.indexOf("--shard");
  if (at === -1) return { index: 0, count: 1 };
  const spec = argv[at + 1] ?? "";
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  const index = m ? Number(m[1]) : 0;
  const count = m ? Number(m[2]) : 0;
  if (!m || count < 1 || index < 1 || index > count) {
    console.error(`import-dump: --shard wants i/N with 1 <= i <= N, got "${spec}"`);
    process.exit(2);
  }
  return { index: index - 1, count };
}

const shard = parseShard(process.argv.slice(2));
const configured = process.env.WIKIDATA_JSON_DUMP ?? DEFAULT_DUMP_PATH;
// `latest-all.json.gz` is a symlink to a dated file (e.g. `20260914/wikidata-20260914-all.json.gz`).
// Resolve it up front so the log says which dump this run read, and open the
// dated file itself so a pointer swap mid-run can't make the two differ.
// A missing file is left for runDumpImport to report (ENOENT on open).
let path = configured;
try {
  path = realpathSync(configured);
} catch {
  // fall through with the configured path
}
const limit = process.env.DUMP_LIMIT ? Number(process.env.DUMP_LIMIT) : undefined;
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
  console.error(
    `import-dump: DUMP_LIMIT must be a positive integer, got "${process.env.DUMP_LIMIT}"`,
  );
  process.exit(2);
}

console.log(
  `import-dump: reading ${configured}${path !== configured ? ` -> ${path}` : ""}` +
    (shard.count > 1 ? ` (shard ${shard.index + 1}/${shard.count})` : "") +
    (limit ? ` (limit ${limit})` : ""),
);

runDumpImport({
  path,
  shard,
  limit,
  prune: process.env.DUMP_PRUNE === "0" ? false : undefined,
  forcePrune: process.env.DUMP_PRUNE_FORCE === "1",
})
  .then(async (stats) => {
    console.log(
      `import-dump: ${shard.count > 1 ? `shard ${shard.index + 1}/${shard.count} ` : ""}` +
        `done in ${(stats.seconds / 60).toFixed(1)} min — ` +
        `${(stats.bytes / 1e9).toFixed(1)} GB inflated, ${stats.lines} lines, ${stats.parsed} parsed, ` +
        `${stats.matched} matched, ${stats.upserted} items upserted, ${stats.externalIds} external ids, ` +
        (stats.skipped + stats.failed > 0
          ? `${stats.skipped} bad lines + ${stats.failed} failed items skipped, `
          : "") +
        `${stats.propertyRows} properties, ${stats.pruned} pruned, ${stats.settled} candidates settled` +
        (stats.stopped ? " (stopped at limit)" : ""),
    );
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("import-dump: failed", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
