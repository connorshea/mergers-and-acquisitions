// Who created each candidate item, when, and how (`item_creations`): the
// item's first revision and its creator's edit count and bot flag. Reviewers
// use this as a heuristic: a dupe from a drive-by account or a bulk import is
// likelier to be an accident than one made by an editor they know.
//
// Two ways in, both writing the same rows:
// - runItemCreationSync (jobs/resolve-creations.ts, nightly after the hunt)
//   reads the wikidatawiki replica for every open candidate's items that have
//   no row yet, or whose row is old enough that the creator's stats may have
//   drifted.
// - loadCreations (GET /api/candidates/:id/creations) serves the cached rows
//   and asks the Action API for any item the job hasn't reached yet.
import mysql from "mysql2/promise";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { db } from "./db.ts";
import { itemCreations, mergeCandidates } from "../db/schema.ts";
import { chunk } from "../src/lib/chunk.ts";
import type { ItemCreation } from "../src/lib/api-types.ts";
import { replicaConnConfig } from "./sitelink-redirects.ts";
import { DEFAULT_WIKIDATA_API_URL } from "./auth/config.ts";
import { userAgent } from "./auth/user-agent.ts";

/** Open candidates read per keyset page when collecting qids. */
const READ_PAGE = 1000;
/** Qids per replica `IN (…)` lookup / rows per upsert. */
const LOOKUP_CHUNK = 500;
/** A row checked more recently than this isn't looked up again by the job. */
const REFRESH_DAYS = 30;
/** Give up on the Action API after this long. */
const TIMEOUT_MS = 10_000;

// Items live on Wikidata proper even when edits go to test.wikidata.org, so
// the creation history is always read from there.
const WIKIDATA_API = DEFAULT_WIKIDATA_API_URL;

/** "20240319224842" (MediaWiki binary timestamp) → "2024-03-19 22:48:42". */
export function fromMwTimestamp(ts: string): string {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`;
}

/** "2024-03-19T22:48:42Z" (API ISO timestamp) → "2024-03-19 22:48:42". */
function fromIsoTimestamp(ts: string): string {
  return ts.replace("T", " ").replace(/Z$/, "");
}

// Replica columns arrive CONVERTed to utf8mb4 strings (or as numbers).
const str = (v: unknown): string | null => (v == null ? null : String(v as string | number));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Look qids' first revisions up in the wikidatawiki replica. The revision
 * joins go through `actor_revision` / `comment_revision`, the views the
 * replicas provide for joining from `revision` (the plain `actor` / `comment`
 * views are slow). Revision-deleted fields come back null. A qid with no page
 * (deleted, or not replicated yet) is left out.
 */
export async function lookUpCreations(conn: Connection, qids: string[]): Promise<ItemCreation[]> {
  const out: ItemCreation[] = [];
  for (const batch of chunk(qids, LOOKUP_CHUNK)) {
    // page_title, rev_timestamp, actor_name, comment_text are VARBINARY there.
    const [revs] = await conn.query<RowDataPacket[]>(
      `SELECT CONVERT(p.page_title USING utf8mb4) AS qid,
              r.rev_id AS revId,
              CONVERT(r.rev_timestamp USING utf8mb4) AS ts,
              CONVERT(a.actor_name USING utf8mb4) AS userName,
              a.actor_user AS userId,
              CONVERT(c.comment_text USING utf8mb4) AS comment
         FROM page p
         JOIN revision r ON r.rev_page = p.page_id AND r.rev_parent_id = 0
         LEFT JOIN actor_revision a ON a.actor_id = r.rev_actor
         LEFT JOIN comment_revision c ON c.comment_id = r.rev_comment_id
        WHERE p.page_namespace = 0 AND p.page_title IN (?)`,
      [batch],
    );
    // An import or undeletion can leave a page with more than one parentless
    // revision; the earliest is the creation.
    const first = new Map<string, RowDataPacket>();
    for (const r of revs) {
      const seen = first.get(String(r.qid));
      if (!seen || Number(r.revId) < Number(seen.revId)) first.set(String(r.qid), r);
    }
    if (first.size === 0) continue;

    const revIds = [...first.values()].map((r) => Number(r.revId));
    const [tagRows] = await conn.query<RowDataPacket[]>(
      `SELECT ct.ct_rev_id AS revId, CONVERT(d.ctd_name USING utf8mb4) AS tag
         FROM change_tag ct
         JOIN change_tag_def d ON d.ctd_id = ct.ct_tag_id
        WHERE ct.ct_rev_id IN (?)`,
      [revIds],
    );
    const tagsByRev = new Map<number, string[]>();
    for (const t of tagRows) {
      const id = Number(t.revId);
      tagsByRev.set(id, [...(tagsByRev.get(id) ?? []), String(t.tag)].sort());
    }

    const userIds = [
      ...new Set([...first.values()].map((r) => num(r.userId)).filter((id) => id)),
    ] as number[];
    const users = new Map<number, { editCount: number | null; isBot: boolean }>();
    if (userIds.length > 0) {
      const [userRows] = await conn.query<RowDataPacket[]>(
        `SELECT u.user_id AS id, u.user_editcount AS editCount,
                EXISTS (SELECT 1 FROM user_groups g
                         WHERE g.ug_user = u.user_id AND g.ug_group = 'bot') AS isBot
           FROM user u
          WHERE u.user_id IN (?)`,
        [userIds],
      );
      for (const u of userRows)
        users.set(Number(u.id), { editCount: num(u.editCount), isBot: Number(u.isBot) === 1 });
    }

    for (const [qid, r] of first) {
      // actor_user is null for an IP; 0 shouldn't happen, but treat it the same.
      const userId = num(r.userId) || null;
      const user = userId ? users.get(userId) : undefined;
      out.push({
        qid,
        revId: Number(r.revId),
        createdAt: fromMwTimestamp(String(r.ts)),
        userName: str(r.userName),
        userId,
        userEditCount: user?.editCount ?? null,
        userIsBot: user?.isBot ?? false,
        comment: str(r.comment),
        tags: tagsByRev.get(Number(r.revId)) ?? [],
      });
    }
  }
  return out;
}

interface RevisionsResponse {
  query?: {
    pages?: {
      title: string;
      missing?: boolean;
      revisions?: {
        revid: number;
        timestamp: string;
        user?: string;
        userid?: number;
        anon?: boolean;
        comment?: string;
        tags?: string[];
      }[];
    }[];
  };
}

interface UsersResponse {
  query?: {
    users?: { userid?: number; editcount?: number; groups?: string[]; missing?: boolean }[];
  };
}

async function getJson<T>(params: Record<string, string>, fetchImpl: typeof fetch): Promise<T> {
  const query = new URLSearchParams({ ...params, format: "json", formatversion: "2" });
  const res = await fetchImpl(`${WIKIDATA_API}?${query}`, {
    headers: { "User-Agent": userAgent() },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wikidata API answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * The same lookup as lookUpCreations, from the Action API. One revisions
 * request per qid (`rvlimit` can't be combined with several titles), then one
 * users request for all the creators. Throws when the API can't be reached.
 */
export async function fetchCreationsLive(
  qids: string[],
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<ItemCreation[]> {
  const out: ItemCreation[] = [];
  for (const qid of qids) {
    const body = await getJson<RevisionsResponse>(
      {
        action: "query",
        prop: "revisions",
        titles: qid,
        rvdir: "newer",
        rvlimit: "1",
        rvprop: "ids|timestamp|user|userid|comment|tags",
      },
      fetchImpl,
    );
    const rev = body.query?.pages?.[0]?.revisions?.[0];
    if (!rev) continue;
    out.push({
      qid,
      revId: rev.revid,
      createdAt: fromIsoTimestamp(rev.timestamp),
      userName: rev.user ?? null,
      userId: rev.userid && !rev.anon ? rev.userid : null,
      userEditCount: null,
      userIsBot: false,
      comment: rev.comment ?? null,
      tags: [...(rev.tags ?? [])].sort(),
    });
  }

  const userIds = [...new Set(out.map((c) => c.userId).filter((id) => id))] as number[];
  if (userIds.length > 0) {
    const body = await getJson<UsersResponse>(
      { action: "query", list: "users", ususerids: userIds.join("|"), usprop: "groups|editcount" },
      fetchImpl,
    );
    const byId = new Map((body.query?.users ?? []).map((u) => [u.userid, u]));
    for (const c of out) {
      const u = c.userId ? byId.get(c.userId) : undefined;
      if (!u || u.missing) continue;
      c.userEditCount = u.editcount ?? null;
      c.userIsBot = u.groups?.includes("bot") ?? false;
    }
  }
  return out;
}

async function upsertCreations(rows: ItemCreation[]): Promise<void> {
  for (const batch of chunk(rows, LOOKUP_CHUNK)) {
    await db
      .insert(itemCreations)
      .values(batch)
      .onDuplicateKeyUpdate({
        set: {
          revId: sql`values(${itemCreations.revId})`,
          createdAt: sql`values(${itemCreations.createdAt})`,
          userName: sql`values(${itemCreations.userName})`,
          userId: sql`values(${itemCreations.userId})`,
          userEditCount: sql`values(${itemCreations.userEditCount})`,
          userIsBot: sql`values(${itemCreations.userIsBot})`,
          comment: sql`values(${itemCreations.comment})`,
          tags: sql`values(${itemCreations.tags})`,
          checkedAt: sql`CURRENT_TIMESTAMP`,
        },
      });
  }
}

const creationColumns = {
  qid: itemCreations.qid,
  revId: itemCreations.revId,
  createdAt: itemCreations.createdAt,
  userName: itemCreations.userName,
  userId: itemCreations.userId,
  userEditCount: itemCreations.userEditCount,
  userIsBot: itemCreations.userIsBot,
  comment: itemCreations.comment,
  tags: itemCreations.tags,
};

/**
 * Creation info for `qids`, keyed by qid: cached rows as they are (however
 * old), and the rest fetched from the Action API and cached. A qid is left
 * out if Wikidata has no such page or the API fails (logged, not thrown, so
 * the page still renders without it).
 */
export async function loadCreations(
  qids: string[],
  fetchImpl?: typeof fetch,
): Promise<Record<string, ItemCreation>> {
  const cached = await db
    .select(creationColumns)
    .from(itemCreations)
    .where(inArray(itemCreations.qid, qids));
  const out: Record<string, ItemCreation> = {};
  for (const row of cached) out[row.qid] = row;

  const missing = qids.filter((q) => !out[q]);
  if (missing.length > 0) {
    try {
      const fetched = await fetchCreationsLive(missing, fetchImpl);
      await upsertCreations(fetched);
      for (const c of fetched) out[c.qid] = c;
    } catch (err) {
      console.warn(`item creations: live lookup of ${missing.join(", ")} failed`, err);
    }
  }
  return out;
}

/** Every item on an open candidate. */
async function collectOpenQids(): Promise<Set<string>> {
  const qids = new Set<string>();
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
    for (const p of pairs) qids.add(p.from).add(p.into);
    if (pairs.length < READ_PAGE) break;
    after = pairs[pairs.length - 1].id;
  }
  return qids;
}

export interface ItemCreationStats {
  /** Distinct items across the open candidates. */
  items: number;
  /** Looked up this run (the rest were checked recently enough). */
  checked: number;
  /** Of those, how many the replica had (the rest have no page there). */
  found: number;
}

export interface ItemCreationOptions {
  /** Open a connection to the wikidatawiki replica; tests substitute their own. */
  connect?: () => Promise<Connection>;
}

/**
 * Record the creation of every open candidate's item that has no row, or one
 * older than REFRESH_DAYS, from the wikidatawiki replica. Throws on a replica
 * or ToolsDB error (the next run starts over; rows already written stay).
 */
export async function runItemCreationSync(
  opts: ItemCreationOptions = {},
): Promise<ItemCreationStats> {
  const connect = opts.connect ?? (() => mysql.createConnection(replicaConnConfig("wikidatawiki")));
  const started = Date.now();
  const qids = await collectOpenQids();
  const total = qids.size;

  const fresh = await db
    .select({ qid: itemCreations.qid })
    .from(itemCreations)
    // checked_at is stamped by the DB clock, so the cutoff is computed there too.
    .where(gte(itemCreations.checkedAt, sql`CURRENT_TIMESTAMP - INTERVAL ${REFRESH_DAYS} DAY`));
  for (const { qid } of fresh) qids.delete(qid);
  console.log(`item creations: ${total} items on open candidates; ${qids.size} to check`);

  let found = 0;
  if (qids.size > 0) {
    const conn = await connect();
    try {
      for (const batch of chunk([...qids], LOOKUP_CHUNK)) {
        const rows = await lookUpCreations(conn, batch);
        await upsertCreations(rows);
        found += rows.length;
      }
    } finally {
      await conn.end().catch(() => {});
    }
  }

  console.log(
    `item creations: done in ${Math.round((Date.now() - started) / 1000)}s: ` +
      `${qids.size} checked, ${found} found`,
  );
  return { items: total, checked: qids.size, found };
}
