// Integration tests for settling candidates whose items were merged or deleted
// on Wikidata (server/outside-merges.ts) against a real MariaDB. The "replica"
// is a wikidatawiki-shaped `page` / `redirect` pair created in the test
// database with the replicas' VARBINARY columns. Opt-in via DB_TEST=1 — see
// test/global-setup.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import mysql from "mysql2/promise";
import { asc, sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { connConfig } from "./db-config.ts";
import { externalIds, items, mergeCandidates } from "../db/schema.ts";
import { runOutsideMergeSync, settlement } from "./outside-merges.ts";
import { DB_TEST, insertItem, makeItem, truncateAll } from "../test/db-helpers.ts";

const connect = () => mysql.createConnection(connConfig());

async function candidate(fromQid: string, intoQid: string, status = "open"): Promise<number> {
  const [res] = await db
    .insert(mergeCandidates)
    .values({ fromQid, intoQid, confidence: 0.9, reasons: [], status });
  return res.insertId;
}

async function candidates() {
  return db
    .select({
      from: mergeCandidates.fromQid,
      into: mergeCandidates.intoQid,
      status: mergeCandidates.status,
      resolution: mergeCandidates.resolution,
    })
    .from(mergeCandidates)
    .orderBy(asc(mergeCandidates.id));
}

/** Pages Q1…Qn exist; `redirects` maps a qid to where it points. */
async function replica(qids: string[], redirects: Record<string, string> = {}): Promise<void> {
  await db.execute(sql`DELETE FROM page`);
  await db.execute(sql`DELETE FROM redirect`);
  for (const [i, qid] of qids.entries()) {
    const target = redirects[qid];
    await db.execute(sql`INSERT INTO page VALUES (${i + 1}, 0, ${qid}, ${target ? 1 : 0})`);
    if (target) {
      await db.execute(sql`INSERT INTO redirect VALUES (${i + 1}, 0, ${target}, '', '')`);
    }
  }
}

describe("settlement", () => {
  const fates = new Map([
    ["Q2", { qid: "Q2", redirectTo: "Q1" }],
    ["Q3", { qid: "Q3", redirectTo: "Q9" }],
    ["Q4", { qid: "Q4", redirectTo: null }],
    ["Q6", { qid: "Q6", deleted: true as const }],
  ]);

  it("prefers the side that redirects to the other", () => {
    expect(
      settlement("Q3", "Q2", new Map([...fates, ["Q3", { qid: "Q3", redirectTo: "Q2" }]])),
    ).toEqual({ status: "merged", resolution: "Q3 merged into Q2 on Wikidata outside the app" });
    expect(settlement("Q1", "Q2", fates)).toEqual({
      status: "merged",
      resolution: "Q2 merged into Q1 on Wikidata outside the app",
    });
  });

  it("names a third item, or just the redirect when its target is unknown", () => {
    expect(settlement("Q3", "Q5", fates)).toEqual({
      status: "merged",
      resolution: "Q3 merged into Q9 elsewhere",
    });
    expect(settlement("Q5", "Q4", fates)).toEqual({
      status: "merged",
      resolution: "Q4 became a redirect on Wikidata",
    });
  });

  it("dismisses a pair with a deleted side, preferring a redirect when both apply", () => {
    expect(settlement("Q6", "Q5", fates)).toEqual({
      status: "dismissed",
      resolution: "Q6 was deleted on Wikidata",
    });
    expect(settlement("Q6", "Q3", fates)).toMatchObject({ status: "merged" });
    expect(settlement("Q5", "Q7", fates)).toBeNull();
  });
});

describe.skipIf(!DB_TEST)("outside merges", () => {
  beforeAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS page, redirect`);
    await db.execute(sql`CREATE TABLE page (
      page_id INT PRIMARY KEY, page_namespace INT NOT NULL,
      page_title VARBINARY(255) NOT NULL, page_is_redirect TINYINT NOT NULL)`);
    await db.execute(sql`CREATE TABLE redirect (
      rd_from INT PRIMARY KEY, rd_namespace INT NOT NULL, rd_title VARBINARY(255) NOT NULL,
      rd_interwiki VARBINARY(32), rd_fragment VARBINARY(255))`);
  });
  beforeEach(truncateAll);
  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS page, redirect`);
    await pool.end();
  });

  it("settles pairs whose items became redirects or were deleted, and drops them", async () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await insertItem(
        makeItem(`Q${n}`, `Game ${n}`, { P1733: [{ type: "external-id", value: `${n}` }] }),
      );
    }
    // Q5 has no page: deleted. Q2 → Q1 (its pair), Q3 → Q9 (a third item).
    await replica(["Q1", "Q2", "Q3", "Q4", "Q6", "Q7", "Q8"], { Q2: "Q1", Q3: "Q9" });
    await candidate("Q2", "Q1");
    await candidate("Q7", "Q2");
    await candidate("Q3", "Q4");
    await candidate("Q6", "Q5");
    await candidate("Q7", "Q8"); // both still items: stays open
    await candidate("Q8", "Q2", "dismissed"); // already resolved: untouched

    expect(await runOutsideMergeSync({ connect })).toEqual({
      items: 8,
      redirects: 2,
      deleted: 1,
      deletionsSkipped: false,
      settled: 4,
    });
    expect(await candidates()).toEqual([
      {
        from: "Q2",
        into: "Q1",
        status: "merged",
        resolution: "Q2 merged into Q1 on Wikidata outside the app",
      },
      { from: "Q7", into: "Q2", status: "merged", resolution: "Q2 merged into Q1 elsewhere" },
      { from: "Q3", into: "Q4", status: "merged", resolution: "Q3 merged into Q9 elsewhere" },
      { from: "Q6", into: "Q5", status: "dismissed", resolution: "Q5 was deleted on Wikidata" },
      { from: "Q7", into: "Q8", status: "open", resolution: null },
      { from: "Q8", into: "Q2", status: "dismissed", resolution: null },
    ]);
    const qids = (rows: { qid: string }[]) => rows.map((r) => r.qid).sort();
    expect(qids(await db.select({ qid: items.qid }).from(items))).toEqual([
      "Q1",
      "Q4",
      "Q6",
      "Q7",
      "Q8",
    ]);
    expect(qids(await db.select({ qid: externalIds.qid }).from(externalIds))).toEqual([
      "Q1",
      "Q4",
      "Q6",
      "Q7",
      "Q8",
    ]);

    // Nothing left to do on a second run.
    expect(await runOutsideMergeSync({ connect })).toMatchObject({ items: 2, settled: 0 });
  });

  it("leaves missing pages alone when too many are missing to be real deletions", async () => {
    await replica(["Q1", "Q2"], { Q2: "Q1" });
    await candidate("Q2", "Q1");
    for (let n = 100; n < 160; n += 2) await candidate(`Q${n}`, `Q${n + 1}`);

    expect(await runOutsideMergeSync({ connect })).toMatchObject({
      redirects: 1,
      deleted: 60,
      deletionsSkipped: true,
      settled: 1,
    });
    const rows = await candidates();
    expect(rows[0]).toMatchObject({ status: "merged" });
    expect(rows.slice(1).every((r) => r.status === "open")).toBe(true);
  });
});
