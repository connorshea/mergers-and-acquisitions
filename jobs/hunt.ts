// Scheduled job: run the duplicate-candidate hunt. Replaces the Void
// crons/hunt-candidates.ts + queues/hunt-candidates.ts pair — the whole
// scan→score→upsert now runs in one process (see server/hunt.ts).
import { runHunt } from "../server/hunt.ts";

export async function main(): Promise<number> {
  try {
    const stats = await runHunt();
    console.log(
      `hunt: ${stats.pairs} pairs, ${stats.scored} scored, ${stats.upserted} upserted, ` +
        `${stats.deleted} deleted, ${stats.pruned} pruned, ${stats.failed} failed`,
    );
    return 0;
  } catch (err) {
    console.error("hunt: failed", err);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
