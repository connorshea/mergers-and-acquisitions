// Integration tests for item creations (server/item-creations.ts) against a
// real MariaDB. The "replica" is a set of wikidatawiki-shaped tables created in
// the test database with the replicas' VARBINARY columns; the Action API
// fallback gets a fake fetch. Opt-in via DB_TEST=1 — see test/global-setup.ts.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";
import { app } from "./app.ts";
import { db, pool } from "./db.ts";
import { connConfig } from "./db-config.ts";
import { itemCreations, mergeCandidates } from "../db/schema.ts";
import { loadCreations, runItemCreationSync } from "./item-creations.ts";
import type { CandidateCreationsResponse } from "../src/lib/api-types.ts";
import { DB_TEST, truncateAll } from "../test/db-helpers.ts";

const connect = () => mysql.createConnection(connConfig());
const REPLICA_TABLES =
  "page, revision, actor_revision, comment_revision, change_tag, change_tag_def, user, user_groups";

async function candidate(fromQid: string, intoQid: string, status = "open"): Promise<number> {
  const [res] = await db
    .insert(mergeCandidates)
    .values({ fromQid, intoQid, confidence: 0.9, reasons: [], status });
  return res.insertId;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

/** A fake Action API answering revisions for `revs` and users for `users`. */
function fakeApi(
  revs: Record<string, object>,
  users: object[] = [],
): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url.search);
    if (url.searchParams.get("list") === "users") return jsonResponse({ query: { users } });
    const title = url.searchParams.get("titles")!;
    const rev = revs[title];
    return jsonResponse({
      query: { pages: [rev ? { title, revisions: [rev] } : { title, missing: true }] },
    });
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

describe.skipIf(!DB_TEST)("item creations", () => {
  beforeAll(async () => {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${REPLICA_TABLES}`));
    await db.execute(sql`CREATE TABLE page (
      page_id INT PRIMARY KEY, page_namespace INT NOT NULL, page_title VARBINARY(255) NOT NULL)`);
    await db.execute(sql`CREATE TABLE revision (
      rev_id BIGINT PRIMARY KEY, rev_page INT NOT NULL, rev_parent_id BIGINT NOT NULL,
      rev_timestamp VARBINARY(14) NOT NULL, rev_actor BIGINT, rev_comment_id BIGINT)`);
    await db.execute(sql`CREATE TABLE actor_revision (
      actor_id BIGINT PRIMARY KEY, actor_user INT, actor_name VARBINARY(255) NOT NULL)`);
    await db.execute(sql`CREATE TABLE comment_revision (
      comment_id BIGINT PRIMARY KEY, comment_text BLOB NOT NULL)`);
    await db.execute(sql`CREATE TABLE change_tag (ct_rev_id BIGINT, ct_tag_id INT)`);
    await db.execute(sql`CREATE TABLE change_tag_def (
      ctd_id INT PRIMARY KEY, ctd_name VARBINARY(255) NOT NULL)`);
    await db.execute(sql`CREATE TABLE user (user_id INT PRIMARY KEY, user_editcount INT)`);
    await db.execute(sql`CREATE TABLE user_groups (ug_user INT, ug_group VARBINARY(255))`);

    await db.execute(sql`INSERT INTO page VALUES (1, 0, 'Q1'), (2, 0, 'Q2'), (3, 0, 'Q3')`);
    await db.execute(sql`INSERT INTO revision VALUES
      (100, 1, 0, '20200102030405', 10, 1000),
      (101, 1, 100, '20200103000000', 11, 1001),
      (200, 2, 0, '20240319224842', 11, 1001),
      (300, 3, 0, '20210101000000', 12, NULL)`);
    await db.execute(sql`INSERT INTO actor_revision VALUES
      (10, 5, 'Human Editor'), (11, 6, 'ImportBot'), (12, NULL, '192.0.2.1')`);
    await db.execute(sql`INSERT INTO comment_revision VALUES
      (1000, '/* wbeditentity-create-item:0| */ Foo, a video game'),
      (1001, '[[:toollabs:quickstatements/#/batch/42|batch #42]]')`);
    await db.execute(
      sql`INSERT INTO change_tag_def VALUES (1, 'wikidata-ui'), (2, 'OAuth CID: 1776')`,
    );
    await db.execute(sql`INSERT INTO change_tag VALUES (100, 1), (200, 2), (101, 1)`);
    await db.execute(sql`INSERT INTO user VALUES (5, 1234), (6, 999999)`);
    await db.execute(sql`INSERT INTO user_groups VALUES (6, 'bot'), (5, 'autoconfirmed')`);
  });
  beforeEach(truncateAll);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${REPLICA_TABLES}`));
    await pool.end();
  });

  it("records each open candidate item's first revision from the replica", async () => {
    await candidate("Q2", "Q1");
    await candidate("Q3", "Q4"); // Q4 has no page on the replica
    await candidate("Q9", "Q8", "dismissed"); // not open: skipped

    expect(await runItemCreationSync({ connect })).toEqual({ items: 4, checked: 4, found: 3 });
    const rows = await db.select().from(itemCreations).orderBy(itemCreations.qid);
    expect(rows).toMatchObject([
      {
        qid: "Q1",
        revId: 100,
        createdAt: "2020-01-02 03:04:05",
        userName: "Human Editor",
        userId: 5,
        userEditCount: 1234,
        userIsBot: false,
        comment: "/* wbeditentity-create-item:0| */ Foo, a video game",
        tags: ["wikidata-ui"],
      },
      {
        qid: "Q2",
        revId: 200,
        createdAt: "2024-03-19 22:48:42",
        userName: "ImportBot",
        userId: 6,
        userEditCount: 999999,
        userIsBot: true,
        comment: "[[:toollabs:quickstatements/#/batch/42|batch #42]]",
        tags: ["OAuth CID: 1776"],
      },
      {
        qid: "Q3",
        revId: 300,
        createdAt: "2021-01-01 00:00:00",
        userName: "192.0.2.1",
        userId: null,
        userEditCount: null,
        userIsBot: false,
        comment: null,
        tags: [],
      },
    ]);
  });

  it("skips recently checked items and refreshes old ones", async () => {
    await candidate("Q2", "Q1");
    await runItemCreationSync({ connect });
    expect(await runItemCreationSync({ connect })).toMatchObject({ checked: 0 });

    await db.update(itemCreations).set({ checkedAt: sql`CURRENT_TIMESTAMP - INTERVAL 31 DAY` });
    await db.execute(sql`UPDATE user SET user_editcount = 2000 WHERE user_id = 5`);
    expect(await runItemCreationSync({ connect })).toMatchObject({ checked: 2, found: 2 });
    const [q1] = await db
      .select()
      .from(itemCreations)
      .where(sql`qid = 'Q1'`);
    expect(q1.userEditCount).toBe(2000);
    await db.execute(sql`UPDATE user SET user_editcount = 1234 WHERE user_id = 5`);
  });

  it("fetches missing items from the Action API and caches them", async () => {
    await db.insert(itemCreations).values({
      qid: "Q1",
      revId: 100,
      createdAt: "2020-01-02 03:04:05",
      userName: "Human Editor",
      userId: 5,
      userEditCount: 1234,
      comment: null,
      tags: [],
    });
    const api = fakeApi(
      {
        Q2: {
          revid: 200,
          timestamp: "2024-03-19T22:48:42Z",
          user: "Someone",
          userid: 7,
          comment: "#quickstatements; #temporary_batch_1",
          tags: ["OAuth CID: 1776"],
        },
        Q3: {
          revid: 300,
          timestamp: "2021-01-01T00:00:00Z",
          user: "192.0.2.1",
          userid: 0,
          anon: true,
        },
      },
      [{ userid: 7, editcount: 12, groups: ["*", "user"] }],
    );

    const out = await loadCreations(["Q1", "Q2", "Q3", "Q4"], api);
    expect(Object.keys(out).sort()).toEqual(["Q1", "Q2", "Q3"]);
    expect(out.Q2).toMatchObject({
      userName: "Someone",
      userId: 7,
      userEditCount: 12,
      userIsBot: false,
    });
    expect(out.Q3).toMatchObject({
      userId: null,
      userEditCount: null,
      createdAt: "2021-01-01 00:00:00",
    });
    // Q1 came from the cache: revisions for Q2, Q3, Q4, then one users call.
    expect(api.calls).toHaveLength(4);

    const again = fakeApi({});
    await loadCreations(["Q1", "Q2", "Q3"], again);
    expect(again.calls).toHaveLength(0);
  });

  it("serves a candidate's creations, leaving out what the API couldn't answer", async () => {
    const id = await candidate("Q2", "Q1");
    await db.insert(itemCreations).values({
      qid: "Q1",
      revId: 100,
      createdAt: "2020-01-02 03:04:05",
      userName: "Human Editor",
      userId: 5,
      userEditCount: 1234,
      comment: null,
      tags: [],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await app.request(`/api/candidates/${id}/creations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CandidateCreationsResponse;
    expect(Object.keys(body.creations)).toEqual(["Q1"]);

    expect((await app.request("/api/candidates/999999/creations")).status).toBe(404);
  });
});
