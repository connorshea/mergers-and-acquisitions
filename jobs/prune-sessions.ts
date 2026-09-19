// Toolforge scheduled job: delete sessions past their absolute expiry, and the
// OAuth tokens of anyone left with no session. The session middleware already
// ignores (and drops) an expired session when its cookie shows up, but
// abandoned ones would otherwise accumulate forever, tokens included.
import { pruneExpiredSessions } from "../server/auth/session.ts";
import { pool } from "../server/db.ts";

async function main() {
  const { sessions, tokens } = await pruneExpiredSessions();
  console.log(
    `prune-sessions: deleted ${sessions} expired session(s) and ${tokens} orphaned token row(s)`,
  );
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("prune-sessions: failed", err);
    process.exit(1);
  });
