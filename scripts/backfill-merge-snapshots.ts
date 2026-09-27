// One-off: give pairs that resolve-merges settled before it kept snapshots a
// snapshot of both items, rebuilding each merged-away item from its last
// revision before the merge (see server/snapshot-backfill.ts). Safe to re-run:
// only pairs still without a snapshot are touched.
//
//   node scripts/backfill-merge-snapshots.ts --dry-run   # list what it would fill
//   node scripts/backfill-merge-snapshots.ts
import { pool } from "../server/db.ts";
import { runSnapshotBackfill } from "../server/snapshot-backfill.ts";

runSnapshotBackfill({ dryRun: process.argv.includes("--dry-run") })
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("snapshot backfill failed", err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
