// Integration tests for the sitelink redirect sync (server/sitelink-redirects.ts)
// against a real MariaDB. The "replica" is a pair of `page` / `redirect` tables
// created in the test database with the replicas' VARBINARY columns. Opt-in via
// DB_TEST=1 — see test/global-setup.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import mysql from "mysql2/promise";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { connConfig } from "./db-config.ts";
import { mergeCandidates, sitelinkPages } from "../db/schema.ts";
import { runSitelinkRedirectSync } from "./sitelink-redirects.ts";
import { DB_TEST, insertItem, makeItem, truncateAll } from "../test/db-helpers.ts";

const connect = () => mysql.createConnection(connConfig());

async function candidate(fromQid: string, intoQid: string, status = "open") {
  await db
    .insert(mergeCandidates)
    .values({ fromQid, intoQid, confidence: 0.9, reasons: [], status });
}

describe.skipIf(!DB_TEST)("runSitelinkRedirectSync", () => {
  beforeAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS page, redirect`);
    await db.execute(sql`CREATE TABLE page (
      page_id INT PRIMARY KEY, page_namespace INT NOT NULL,
      page_title VARBINARY(255) NOT NULL, page_is_redirect TINYINT NOT NULL)`);
    await db.execute(sql`CREATE TABLE redirect (
      rd_from INT PRIMARY KEY, rd_namespace INT NOT NULL, rd_title VARBINARY(255) NOT NULL,
      rd_interwiki VARBINARY(32), rd_fragment VARBINARY(255))`);
    await db.execute(sql`INSERT INTO page VALUES
      (1, 0, 'Starfall_Drift', 0),
      (2, 0, 'Starfall_Drift_(video_game)', 1),
      (3, 0, 'Halo:_Reach_(beta)', 1),
      (4, 0, 'Orphan_redirect', 1),
      (5, 0, 'Sectioned', 1)`);
    await db.execute(sql`INSERT INTO redirect VALUES
      (2, 0, 'Starfall_Drift', '', NULL),
      (3, 4, 'Halo', '', NULL),
      (5, 0, 'Starfall_Drift', '', 'Sequel')`);
  });
  beforeEach(truncateAll);
  afterAll(async () => {
    await db.execute(sql`DROP TABLE IF EXISTS page, redirect`);
    await pool.end();
  });

  it("records each clashing page's redirect status and target", async () => {
    await insertItem(
      makeItem("Q1", "Starfall Drift", {}, { sitelinks: { enwiki: "Starfall Drift" } }),
    );
    await insertItem(
      makeItem(
        "Q2",
        "Starfall Drift",
        {},
        { sitelinks: { enwiki: "Starfall Drift (video game)" } },
      ),
    );
    await insertItem(makeItem("Q3", "X", {}, { sitelinks: { enwiki: "Halo: Reach (beta)" } }));
    await insertItem(makeItem("Q4", "X", {}, { sitelinks: { enwiki: "Orphan redirect" } }));
    await insertItem(makeItem("Q5", "X", {}, { sitelinks: { enwiki: "Sectioned" } }));
    await insertItem(makeItem("Q6", "X", {}, { sitelinks: { enwiki: "Gone: Page" } }));
    await insertItem(makeItem("Q7", "X", {}, { sitelinks: { enwiki: "Gone" } }));
    await candidate("Q2", "Q1");
    await candidate("Q4", "Q3");
    await candidate("Q6", "Q5");
    await candidate("Q7", "Q6");

    const stats = await runSitelinkRedirectSync({ connect });
    // "Gone: Page" isn't found and has a colon: maybe another namespace, so unknown.
    expect(stats).toMatchObject({ titles: 7, checked: 6, redirects: 4, failedWikis: [] });

    const rows = await db
      .select({
        title: sitelinkPages.title,
        missing: sitelinkPages.missing,
        isRedirect: sitelinkPages.isRedirect,
        redirectTarget: sitelinkPages.redirectTarget,
        redirectFragment: sitelinkPages.redirectFragment,
      })
      .from(sitelinkPages)
      .orderBy(sitelinkPages.title);
    expect(rows).toEqual([
      {
        title: "Gone",
        missing: true,
        isRedirect: false,
        redirectTarget: null,
        redirectFragment: null,
      },
      // Redirect into another namespace: flagged, target not kept.
      {
        title: "Halo: Reach (beta)",
        missing: false,
        isRedirect: true,
        redirectTarget: null,
        redirectFragment: null,
      },
      // Flagged as a redirect with no `redirect` row.
      {
        title: "Orphan redirect",
        missing: false,
        isRedirect: true,
        redirectTarget: null,
        redirectFragment: null,
      },
      {
        title: "Sectioned",
        missing: false,
        isRedirect: true,
        redirectTarget: "Starfall Drift",
        redirectFragment: "Sequel",
      },
      {
        title: "Starfall Drift",
        missing: false,
        isRedirect: false,
        redirectTarget: null,
        redirectFragment: null,
      },
      {
        title: "Starfall Drift (video game)",
        missing: false,
        isRedirect: true,
        redirectTarget: "Starfall Drift",
        redirectFragment: null,
      },
    ]);
  });

  it("ignores resolved candidates and recently checked pages", async () => {
    await insertItem(makeItem("Q1", "A", {}, { sitelinks: { enwiki: "Starfall Drift" } }));
    await insertItem(makeItem("Q2", "B", {}, { sitelinks: { enwiki: "Sectioned" } }));
    await insertItem(makeItem("Q3", "C", {}, { sitelinks: { enwiki: "Orphan redirect" } }));
    await candidate("Q2", "Q1");
    await candidate("Q3", "Q1", "dismissed");

    expect(await runSitelinkRedirectSync({ connect })).toMatchObject({ titles: 2, checked: 2 });
    expect(await runSitelinkRedirectSync({ connect })).toMatchObject({ titles: 2, checked: 0 });
  });

  it("keeps going when one wiki's replica fails, and prunes stale rows", async () => {
    await insertItem(
      makeItem("Q1", "A", {}, { sitelinks: { enwiki: "Starfall Drift", dewiki: "A" } }),
    );
    await insertItem(makeItem("Q2", "B", {}, { sitelinks: { enwiki: "Sectioned", dewiki: "B" } }));
    await candidate("Q2", "Q1");
    await db.insert(sitelinkPages).values({
      wiki: "frwiki",
      title: "Old",
      missing: false,
      isRedirect: false,
      checkedAt: "2000-01-01 00:00:00",
    });

    const stats = await runSitelinkRedirectSync({
      connect: (wiki) => (wiki === "dewiki" ? Promise.reject(new Error("down")) : connect()),
    });
    expect(stats).toMatchObject({ checked: 2, failedWikis: ["dewiki"], pruned: 1 });
    const wikis = await db.select({ wiki: sitelinkPages.wiki }).from(sitelinkPages);
    expect(wikis.map((r) => r.wiki)).toEqual(["enwiki", "enwiki"]);
  });

  it("throws when every wiki with work fails", async () => {
    await insertItem(makeItem("Q1", "A", {}, { sitelinks: { enwiki: "Starfall Drift" } }));
    await insertItem(makeItem("Q2", "B", {}, { sitelinks: { enwiki: "Sectioned" } }));
    await candidate("Q2", "Q1");
    await expect(
      runSitelinkRedirectSync({ connect: () => Promise.reject(new Error("down")) }),
    ).rejects.toThrow(/all 1 wikis/);
  });
});
