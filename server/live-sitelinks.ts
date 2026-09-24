// Live redirect check for the pages behind a pair's same-wiki sitelink clashes,
// asked of each linked wiki's own Action API right before a merge. The nightly
// `sitelink_pages` answer (server/sitelink-redirects.ts) is good enough to show
// and score, but removing a sitelink from Wikidata is an edit, so the merge flow
// only acts on what the wiki says now.
import { type Item, withFragment } from "../src/lib/compare.ts";
import { sitelinkHost } from "../src/lib/wiki.ts";
import { sitelinkClashes } from "./sitelink-overlay.ts";
import { userAgent } from "./auth/user-agent.ts";

/** Give up on a wiki that hasn't answered in this long. */
const TIMEOUT_MS = 10_000;

interface QueryResponse {
  query?: {
    redirects?: { from: string; to: string; tofragment?: string; tointerwiki?: string }[];
  };
}

/**
 * Resolve the clashing sitelinks of `a` and `b` against their wikis and set
 * each item's `sitelinkRedirects` to what the wikis said (replacing whatever
 * was there): wiki → target for every page that is a redirect, null when it
 * points off-wiki ("Title#Section" for a section). Throws when a wiki can't be reached or read; the caller
 * treats that as "not known to be fixable".
 */
export async function attachLiveSitelinkRedirects(
  a: Item,
  b: Item,
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<void> {
  const byWiki = new Map<string, string[]>();
  for (const { wiki, title } of sitelinkClashes(a, b)) {
    byWiki.set(wiki, [...(byWiki.get(wiki) ?? []), title]);
  }
  const found: [Item, Record<string, string | null>][] = [
    [a, {}],
    [b, {}],
  ];
  for (const [wiki, titles] of byWiki) {
    const host = sitelinkHost(wiki);
    if (!host) throw new Error(`No known host for sitelink site ${wiki}`);
    const query = new URLSearchParams({
      action: "query",
      titles: titles.join("|"),
      redirects: "1",
      format: "json",
      formatversion: "2",
    });
    const res = await fetchImpl(`https://${host}/w/api.php?${query}`, {
      headers: { "User-Agent": userAgent() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${host} answered HTTP ${res.status}`);
    const body = (await res.json()) as QueryResponse;
    for (const r of body.query?.redirects ?? []) {
      const target = r.tointerwiki ? null : withFragment(r.to, r.tofragment);
      for (const [item, redirects] of found) {
        if (item.sitelinks[wiki] === r.from) redirects[wiki] = target;
      }
    }
  }
  for (const [item, redirects] of found) item.sitelinkRedirects = redirects;
}
