// Scheduled job: the monthly Claude review of open candidates (issue #292,
// server/llm-review-job.ts). Three jobs, declared in jobs.yaml:
//
//   node jobs/llm-review.ts first-pass   # 1st: send Haiku every unreviewed open pair
//   node jobs/llm-review.ts confirm      # 2nd: send Opus Haiku's "different" pairs
//   node jobs/llm-review.ts collect      # hourly, 1st-3rd: write back ended batches, hide
//
// Every run returns as soon as it has submitted or collected; `--wait` keeps
// it polling until its batches end (for a run by hand). `--max-pairs N`
// overrides LLM_MAX_PAIRS_PER_RUN.
// Needs ANTHROPIC_API_KEY; never touches Wikidata.
import { db, pool } from "../server/db.ts";
import { anthropicApi, collect, configFromEnv, runStage } from "../server/llm-review-job.ts";

/** Run one stage; resolves to the exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    return await dispatch(argv, env);
  } catch (err) {
    console.error("llm-review: failed", err);
    return 1;
  } finally {
    await pool.end();
  }
}

async function dispatch(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const [command, ...argv] = args;
  const config = configFromEnv(env);
  const i = argv.indexOf("--max-pairs");
  if (i >= 0) {
    config.maxPairs = Number(argv[i + 1]);
    if (!Number.isInteger(config.maxPairs) || config.maxPairs < 0) {
      throw new Error("--max-pairs must be a count");
    }
  }
  const wait = argv.includes("--wait");
  switch (command) {
    case "first-pass":
    case "confirm": {
      const stage = command === "first-pass" ? "first_pass" : "confirmation";
      await runStage(db, anthropicApi(), config, stage, { wait });
      return 0;
    }
    case "collect":
      await collect(db, anthropicApi(), config, { wait });
      return 0;
    default:
      console.log(
        "usage: node jobs/llm-review.ts first-pass | confirm | collect [--wait] [--max-pairs N]",
      );
      return command ? 1 : 0;
  }
}

// Sets exitCode rather than exiting, so the process ends once the pool has closed.
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
