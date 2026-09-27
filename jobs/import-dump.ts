// One-off / weekly job: (re)build the item mirror from the Wikidata entity JSON
// dump on Toolforge's NFS mount (see server/dump-import.ts). Needs `mount: all`
// in jobs.yaml so /public/dumps is visible, and ~1 CPU / 4Gi for a few hours.
//
//   node jobs/import-dump.ts                     # full pass + prune
//   DUMP_LIMIT=2000 node jobs/import-dump.ts     # stop after 2000 games (timing check)
//   WIKIDATA_JSON_DUMP=/path/to/dump.json.gz …   # another dump (plain .json works too)
//   DUMP_PRUNE=0 …                               # keep items missing from the dump
//   DUMP_PRUNE_FORCE=1 …                         # prune past the 20% safety cap
//   DUMP_FULL=1 …                                # parse unedited items too (see CONVERTER_VERSION)
//   node jobs/import-dump.ts --worker import-dump-3   # a queue worker (the weekly jobs)
//   DUMP_SEGMENTS=128 … --worker …               # segments per pass (every worker must agree)
//   DUMP_REDO=2026-09-28 … --worker …            # import an already-imported dump again, once per token
//   node jobs/import-dump.ts --shard 3/8         # read the third of eight slices
//
// `--worker <name>` makes the job one of several identical workers: they claim
// segments of the file from a shared queue (`dump_import_segments`) until none
// is left, and whichever finishes the last one prunes. Add or remove workers
// freely; each needs a unique name, which a retry of the same job keeps (so it
// takes back the segment its dead predecessor held). The name defaults to the
// host name and process id.
//
// `--shard i/N` reads one fixed N-th of the file instead (local and one-off
// use); every slice job must use the same N. Without either flag the job reads
// the whole file, which is `--shard 1/1`.
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { pool } from "../server/db.ts";
import {
  DEFAULT_DUMP_PATH,
  DEFAULT_SEGMENTS,
  type DumpShard,
  runDumpImport,
} from "../server/dump-import.ts";

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

/** The worker name after `--worker`, the default one when it has none, or undefined without the flag. */
function parseWorker(argv: string[]): string | undefined {
  const at = argv.indexOf("--worker");
  if (at === -1) return undefined;
  const name = argv[at + 1];
  if (name === undefined || name.startsWith("--")) return `${hostname()}-${process.pid}`;
  if (name.length > 64) {
    console.error(`import-dump: --worker name must be at most 64 characters, got "${name}"`);
    process.exit(2);
  }
  return name;
}

const argv = process.argv.slice(2);
const worker = parseWorker(argv);
if (worker !== undefined && argv.includes("--shard")) {
  console.error("import-dump: --worker and --shard don't mix");
  process.exit(2);
}
const shard = parseShard(argv);
const segments = process.env.DUMP_SEGMENTS ? Number(process.env.DUMP_SEGMENTS) : DEFAULT_SEGMENTS;
if (!(Number.isInteger(segments) && segments > 0)) {
  console.error(
    `import-dump: DUMP_SEGMENTS must be a positive integer, got "${process.env.DUMP_SEGMENTS}"`,
  );
  process.exit(2);
}
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
const redo = process.env.DUMP_REDO || undefined;
if (redo !== undefined && !(redo.length <= 32 && worker !== undefined)) {
  console.error("import-dump: DUMP_REDO is a token of at most 32 characters, for --worker runs");
  process.exit(2);
}
if (limit !== undefined && worker !== undefined) {
  console.error("import-dump: DUMP_LIMIT is for a single run; use it without --worker");
  process.exit(2);
}

console.log(
  `import-dump: reading ${configured}${path !== configured ? ` -> ${path}` : ""}` +
    (worker !== undefined ? ` (worker ${worker}, ${segments} segments)` : "") +
    (shard.count > 1 ? ` (shard ${shard.index + 1}/${shard.count})` : "") +
    (limit ? ` (limit ${limit})` : ""),
);

runDumpImport({
  path,
  ...(worker !== undefined ? { worker, segments, redo } : { shard }),
  limit,
  prune: process.env.DUMP_PRUNE === "0" ? false : undefined,
  forcePrune: process.env.DUMP_PRUNE_FORCE === "1",
  full: process.env.DUMP_FULL === "1",
})
  .then(async (stats) => {
    console.log(
      `import-dump: ${
        worker !== undefined
          ? `worker ${worker} (${stats.segmentsScanned} segments) `
          : shard.count > 1
            ? `shard ${shard.index + 1}/${shard.count} `
            : ""
      }` +
        `done in ${(stats.seconds / 60).toFixed(1)} min ` +
        `(${(stats.writeWaitSeconds / 60).toFixed(1)} min waiting on writes` +
        (stats.lockRetries > 0 ? `, ${stats.lockRetries} lock retries` : "") +
        ") — " +
        `${(stats.bytes / 1e9).toFixed(1)} GB inflated, ${stats.lines} lines, ${stats.parsed} parsed, ` +
        `${stats.matched} matched (${stats.unedited} unedited), ${stats.upserted} items upserted (${stats.unchanged} unchanged), ${stats.externalIds} external ids, ` +
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
