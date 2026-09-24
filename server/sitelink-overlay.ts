// Read side of `sitelink_pages` (filled by server/sitelink-redirects.ts): which
// sitelinks two items clash on, and overlaying what the replicas said about
// those pages onto the items. Kept apart from the sync so the hunt can use it
// without importing the web server's connection pool.
import type { MySql2Database } from "drizzle-orm/mysql2";
import { and, eq, sql } from "drizzle-orm";
import type * as schema from "../db/schema.ts";
import { sitelinkPages } from "../db/schema.ts";
import type { Item } from "../src/lib/compare.ts";
import { chunk } from "../src/lib/chunk.ts";

/** (wiki, title) tuples per `IN` lookup. */
const LOOKUP_CHUNK = 500;

/**
 * The sitelinks two items clash on: same wiki, different page. Both titles of
 * each clash are returned, since either page may be the redirect.
 */
export function sitelinkClashes(a: Item, b: Item): { wiki: string; title: string }[] {
  const out: { wiki: string; title: string }[] = [];
  for (const [wiki, titleA] of Object.entries(a.sitelinks)) {
    const titleB = b.sitelinks[wiki];
    if (titleB === undefined || titleB === titleA) continue;
    out.push({ wiki, title: titleA }, { wiki, title: titleB });
  }
  return out;
}

/**
 * Overlay what `sitelink_pages` knows about the pairs' clashing sitelinks onto
 * the items (`Item.sitelinkRedirects`), so the comparison and the scorer can
 * tell a redirect to the partner's page from a second article. Mutates the
 * items in place; they are read-side copies and never written back. Takes the
 * handle so the hunt can pass its dedicated connection.
 */
export async function attachSitelinkRedirects(
  database: MySql2Database<typeof schema>,
  pairs: [Item, Item][],
): Promise<void> {
  const owners = new Map<string, Item[]>(); // "wiki\ttitle" → items linking that page
  for (const [a, b] of pairs) {
    for (const { wiki, title } of sitelinkClashes(a, b)) {
      const key = `${wiki}\t${title}`;
      const linked = [a, b].filter((it) => it.sitelinks[wiki] === title);
      owners.set(key, [...new Set([...(owners.get(key) ?? []), ...linked])]);
    }
  }
  for (const batch of chunk([...owners.keys()], LOOKUP_CHUNK)) {
    const tuples = batch.map((key) => {
      const [wiki, title] = key.split("\t");
      return sql`(${wiki}, ${title})`;
    });
    const rows = await database
      .select({
        wiki: sitelinkPages.wiki,
        title: sitelinkPages.title,
        target: sitelinkPages.redirectTarget,
      })
      .from(sitelinkPages)
      .where(
        and(
          eq(sitelinkPages.isRedirect, true),
          sql`(${sitelinkPages.wiki}, ${sitelinkPages.title}) IN (${sql.join(tuples, sql`, `)})`,
        ),
      );
    for (const row of rows) {
      for (const item of owners.get(`${row.wiki}\t${row.title}`) ?? []) {
        item.sitelinkRedirects = { ...item.sitelinkRedirects, [row.wiki]: row.target };
      }
    }
  }
}
