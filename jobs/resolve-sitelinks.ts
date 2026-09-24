// Scheduled job: check the pages behind same-wiki sitelink clashes on open
// candidates against the Wiki Replicas — is each a redirect, and to what — so
// a clash that's really one page redirecting to the other can be told apart
// from two distinct articles. Runs nightly after the hunt, which is what
// creates and retires the candidates it looks at.
import { runSitelinkRedirectSync } from "../server/sitelink-redirects.ts";

runSitelinkRedirectSync()
  .then(({ failedWikis }) => {
    // A partial run still exits 0: the wikis that failed keep their previous
    // rows (or none), and tomorrow's run retries them.
    if (failedWikis.length > 0)
      console.warn(`resolve-sitelinks: skipped ${failedWikis.join(", ")} after errors`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("resolve-sitelinks: failed", err);
    process.exit(1);
  });
