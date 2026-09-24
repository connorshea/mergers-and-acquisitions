// Resolve the pages behind same-wiki sitelink clashes against the Wiki Replicas,
// recording whether each is a redirect and where it points (`sitelink_pages`).
// Run nightly by jobs/resolve-sitelinks.ts, after the hunt.
//
// Two open candidates' items linking different pages on one wiki is what makes
// Wikidata refuse the merge — but often one page is just a redirect to the
// other, which is duplicate evidence rather than a real conflict. The dump only
// says so through the "sitelink to redirect" badges, which carry no target and
// are missing on pages that became redirects after being linked. Each wiki's
// replica (`<wiki>_p`) has the real answer in its `page` and `redirect` tables.
//
// Every wiki lives on its own replica host (one of several section servers),
// and none can join against ToolsDB, so the work goes: collect the clashing
// titles from our DB, group them by wiki, look each wiki's batch up over its own
// connection (one wiki at a time — the replicas cap connections per tool), and
// upsert the answers back into ToolsDB.
import mysql from "mysql2/promise";
import type { Connection, ConnectionOptions, RowDataPacket } from "mysql2/promise";
import { and, asc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { items, mergeCandidates, sitelinkPages } from "../db/schema.ts";
import type { Item } from "../src/lib/compare.ts";
import { chunk } from "../src/lib/chunk.ts";
import { sitelinkClashes } from "./sitelink-overlay.ts";

/** Open candidates read per keyset page when collecting clashes. */
const READ_PAGE = 1000;
/** Titles per replica `IN (…)` lookup / rows per upsert. */
const LOOKUP_CHUNK = 500;
/** A page checked more recently than this is not looked up again. */
const REFRESH_DAYS = 7;
/** Rows not re-checked for this long no longer back an open clash; drop them. */
const PRUNE_DAYS = 30;

/** What the replica says about one sitelinked page. */
export interface PageInfo {
  /** The sitelink title as Wikidata stores it (spaces, not underscores). */
  title: string;
  missing: boolean;
  isRedirect: boolean;
  redirectTarget: string | null;
  redirectFragment: string | null;
}

/** Every clashing sitelink across the open candidates, grouped by wiki. */
async function collectClashTitles(): Promise<Map<string, Set<string>>> {
  const byWiki = new Map<string, Set<string>>();
  let after = 0;
  for (;;) {
    const pairs = await db
      .select({
        id: mergeCandidates.id,
        from: mergeCandidates.fromQid,
        into: mergeCandidates.intoQid,
      })
      .from(mergeCandidates)
      .where(and(eq(mergeCandidates.status, "open"), gt(mergeCandidates.id, after)))
      .orderBy(asc(mergeCandidates.id))
      .limit(READ_PAGE);
    if (pairs.length === 0) break;
    const qids = [...new Set(pairs.flatMap((p) => [p.from, p.into]))];
    const rows = await db
      .select({ qid: items.qid, data: items.data })
      .from(items)
      .where(inArray(items.qid, qids));
    const byQid = new Map(rows.map((r) => [r.qid, r.data as Item]));
    for (const p of pairs) {
      const a = byQid.get(p.from);
      const b = byQid.get(p.into);
      if (!a || !b) continue;
      for (const { wiki, title } of sitelinkClashes(a, b)) {
        let titles = byWiki.get(wiki);
        if (!titles) byWiki.set(wiki, (titles = new Set()));
        titles.add(title);
      }
    }
    after = pairs[pairs.length - 1].id;
    if (pairs.length < READ_PAGE) break;
  }
  return byWiki;
}

/** Site ids are replica db names; anything else never reaches a hostname. */
const WIKI_ID = /^[a-z0-9_]+$/;

/**
 * Connection settings for one wiki's replica. On Toolforge the defaults are
 * right: `<wiki>.analytics.db.svc.wikimedia.cloud`, database `<wiki>_p`, with
 * the tool's replica credentials from the environment. For an SSH tunnel from a
 * dev machine, REPLICA_HOST / REPLICA_PORT / REPLICA_DB override them (`{wiki}`
 * is substituted in each).
 */
export function replicaConnConfig(wiki: string): ConnectionOptions {
  if (!WIKI_ID.test(wiki)) throw new Error(`Not a replica wiki id: ${JSON.stringify(wiki)}`);
  const fill = (template: string) => template.replaceAll("{wiki}", wiki);
  return {
    host: fill(process.env.REPLICA_HOST ?? "{wiki}.analytics.db.svc.wikimedia.cloud"),
    port: Number(process.env.REPLICA_PORT ?? 3306),
    user: process.env.TOOL_REPLICA_USER,
    password: process.env.TOOL_REPLICA_PASSWORD,
    database: fill(process.env.REPLICA_DB ?? "{wiki}_p"),
    charset: "utf8mb4",
  };
}

const toDb = (title: string) => title.replaceAll(" ", "_");
const fromDb = (title: string) => title.replaceAll("_", " ");

/**
 * Look sitelink titles up in one wiki's `page` / `redirect` tables. Only
 * main-namespace pages are searched: the namespace prefix of a title like
 * "Category:Foo" is per-wiki config the replicas don't carry. So a title that
 * isn't found but contains a colon is left out of the result (unknown, not
 * missing) — most such titles are main-namespace pages ("Halo: Reach") and are
 * found normally.
 */
export async function lookUpPages(conn: Connection, titles: string[]): Promise<PageInfo[]> {
  const out: PageInfo[] = [];
  for (const batch of chunk(titles, LOOKUP_CHUNK)) {
    // page_title and the redirect columns are VARBINARY on the replicas.
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT CONVERT(p.page_title USING utf8mb4) AS title,
              p.page_is_redirect AS isRedirect,
              r.rd_namespace AS ns,
              CONVERT(r.rd_title USING utf8mb4) AS target,
              CONVERT(r.rd_fragment USING utf8mb4) AS fragment,
              CONVERT(r.rd_interwiki USING utf8mb4) AS interwiki
         FROM page p
         LEFT JOIN redirect r ON r.rd_from = p.page_id
        WHERE p.page_namespace = 0 AND p.page_title IN (?)`,
      [batch.map(toDb)],
    );
    const found = new Map(rows.map((r) => [fromDb(String(r.title)), r]));
    for (const title of batch) {
      const r = found.get(title);
      if (!r) {
        if (!title.includes(":"))
          out.push({
            title,
            missing: true,
            isRedirect: false,
            redirectTarget: null,
            redirectFragment: null,
          });
        continue;
      }
      const isRedirect = Number(r.isRedirect) === 1;
      // A target is only kept when it's a main-namespace page on this wiki —
      // the only kind that can equal another item's sitelink here.
      const local = isRedirect && r.target != null && Number(r.ns) === 0 && !r.interwiki;
      out.push({
        title,
        missing: false,
        isRedirect,
        redirectTarget: local ? fromDb(String(r.target)) : null,
        redirectFragment: local && r.fragment ? String(r.fragment) : null,
      });
    }
  }
  return out;
}

async function upsertPages(wiki: string, pages: PageInfo[]): Promise<void> {
  for (const batch of chunk(pages, LOOKUP_CHUNK)) {
    await db
      .insert(sitelinkPages)
      .values(batch.map((p) => ({ wiki, ...p })))
      .onDuplicateKeyUpdate({
        set: {
          missing: sql`values(${sitelinkPages.missing})`,
          isRedirect: sql`values(${sitelinkPages.isRedirect})`,
          redirectTarget: sql`values(${sitelinkPages.redirectTarget})`,
          redirectFragment: sql`values(${sitelinkPages.redirectFragment})`,
          checkedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  }
}

export interface SitelinkRedirectStats {
  /** Distinct clashing sitelinks across the open candidates. */
  titles: number;
  /** Looked up this run (the rest were checked recently enough). */
  checked: number;
  /** Of those, how many are redirects. */
  redirects: number;
  /** Wikis whose replica couldn't be reached or queried (retried next run). */
  failedWikis: string[];
  /** Stale rows dropped. */
  pruned: number;
}

export interface SitelinkRedirectOptions {
  /** Open a connection to a wiki's replica; tests substitute a fake one. */
  connect?: (wiki: string) => Promise<Connection>;
}

/**
 * Resolve every clashing sitelink not checked in the last REFRESH_DAYS, one
 * wiki at a time. A wiki that fails is logged and skipped so the rest still
 * land; throws only if every wiki with work failed, or on a ToolsDB error.
 */
export async function runSitelinkRedirectSync(
  opts: SitelinkRedirectOptions = {},
): Promise<SitelinkRedirectStats> {
  const connect = opts.connect ?? ((wiki) => mysql.createConnection(replicaConnConfig(wiki)));
  const started = Date.now();
  const byWiki = await collectClashTitles();
  const titles = [...byWiki.values()].reduce((n, s) => n + s.size, 0);

  const fresh = await db
    .select({ wiki: sitelinkPages.wiki, title: sitelinkPages.title })
    .from(sitelinkPages)
    // checked_at is stamped by the DB clock, so the cutoffs are computed there too.
    .where(gte(sitelinkPages.checkedAt, sql`CURRENT_TIMESTAMP - INTERVAL ${REFRESH_DAYS} DAY`));
  for (const { wiki, title } of fresh) byWiki.get(wiki)?.delete(title);

  const todo = [...byWiki].filter(([, t]) => t.size > 0).sort(([a], [b]) => a.localeCompare(b));
  console.log(
    `sitelink redirects: ${titles} clashing sitelinks on ${byWiki.size} wikis; ` +
      `${todo.reduce((n, [, t]) => n + t.size, 0)} to check on ${todo.length} wikis`,
  );

  let checked = 0;
  let redirects = 0;
  const failedWikis: string[] = [];
  for (const [wiki, set] of todo) {
    let conn: Connection | undefined;
    try {
      conn = await connect(wiki);
      const pages = await lookUpPages(conn, [...set]);
      await upsertPages(wiki, pages);
      checked += pages.length;
      redirects += pages.filter((p) => p.isRedirect).length;
    } catch (err) {
      console.warn(`sitelink redirects: ${wiki} failed`, err);
      failedWikis.push(wiki);
    } finally {
      await conn?.end().catch(() => {});
    }
  }
  if (todo.length > 0 && failedWikis.length === todo.length) {
    throw new Error(`Replica lookup failed on all ${todo.length} wikis`);
  }

  const [pruneResult] = await db
    .delete(sitelinkPages)
    .where(lt(sitelinkPages.checkedAt, sql`CURRENT_TIMESTAMP - INTERVAL ${PRUNE_DAYS} DAY`));
  const pruned = pruneResult.affectedRows;

  console.log(
    `sitelink redirects: done in ${Math.round((Date.now() - started) / 1000)}s: ` +
      `${checked} checked (${redirects} redirects), ${failedWikis.length} wikis failed, ${pruned} pruned`,
  );
  return { titles, checked, redirects, failedWikis, pruned };
}
