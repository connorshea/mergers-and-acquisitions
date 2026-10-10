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

async function main(): Promise<void> {
  const [command, ...argv] = process.argv.slice(2);
  const config = configFromEnv();
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
      break;
    }
    case "collect":
      await collect(db, anthropicApi(), config, { wait });
      break;
    default:
      console.log(
        "usage: node jobs/llm-review.ts first-pass | confirm | collect [--wait] [--max-pairs N]",
      );
      process.exitCode = command ? 1 : 0;
  }
}

main()
  .catch((err) => {
    console.error("llm-review: failed", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
