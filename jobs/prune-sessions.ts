// Toolforge scheduled job: delete sessions past their absolute expiry. The
// session middleware already ignores (and drops) an expired session when its
// cookie shows up, but abandoned ones would otherwise accumulate forever.
import { pruneExpiredSessions } from "../server/auth/session.ts";
import { pool } from "../server/db.ts";

async function main() {
  const deleted = await pruneExpiredSessions();
  console.log(`prune-sessions: deleted ${deleted} expired session(s)`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("prune-sessions: failed", err);
    process.exit(1);
  });
