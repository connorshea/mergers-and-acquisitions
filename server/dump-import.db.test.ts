// Integration tests for the dump import's write path (server/dump-import.ts)
// against a real MariaDB: upsert + external-id rebuild, property sync, and the
// prune of items that left the dump. Opt-in via DB_TEST=1 — see
// test/global-setup.ts.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { asc, eq } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { dumpImportRuns, externalIds, items, mergeCandidates, properties } from "../db/schema.ts";
import { MAX_PRUNE_FRACTION, runDumpImport, upsertItems } from "./dump-import.ts";
import type { Entity, Statement } from "../src/lib/wikibase.ts";
import { DB_TEST, insertItem, makeItem, truncateAll } from "../test/db-helpers.ts";
import { dumpGz } from "../test/dump-gz.ts";

const itemRef = (qid: string) => ({
  type: "wikibase-entityid",
  value: { "entity-type": "item", "numeric-id": Number(qid.slice(1)), id: qid },
});
const p31 = (qid: string): Statement => ({
  mainsnak: {
    snaktype: "value",
    property: "P31",
    datatype: "wikibase-item",
    datavalue: itemRef(qid),
  },
  rank: "normal",
});
const steam = (value: string): Statement => ({
  mainsnak: {
    snaktype: "value",
    property: "P1733",
    datatype: "external-id",
    datavalue: { type: "string", value },
  },
  rank: "normal",
});
const game = (id: string, label: string, extra: Statement[] = []): Entity => ({
  type: "item",
  id,
  labels: { en: { value: label } },
  descriptions: { en: { value: `${label} (video game)` } },
  claims: { P31: [p31("Q7889")], ...(extra.length ? { P1733: extra } : {}) },
});
const STEAM_PROP: Entity = {
  type: "property",
  id: "P1733",
  datatype: "external-id",
  labels: { en: { value: "Steam application ID" } },
};

const source = (entities: object[]) =>
  Readable.from([Buffer.from(`[\n${entities.map((e) => `${JSON.stringify(e)},\n`).join("")}]\n`)]);

const run = (entities: object[], opts: Parameters<typeof runDumpImport>[0] = {}) =>
  runDumpImport({ source: source(entities), log: () => {}, ...opts });

const allItems = () => db.select().from(items).orderBy(asc(items.qid));
const idsOf = (qid: string) =>
  db
    .select({ property: externalIds.property, value: externalIds.value })
    .from(externalIds)
    .where(eq(externalIds.qid, qid));

describe.skipIf(!DB_TEST)("runDumpImport", () => {
  beforeEach(truncateAll);
  afterAll(() => pool.end());

  it("upserts matching items with their external ids and syncs properties", async () => {
    const stats = await run([
      game("Q100", "Starfall Drift", [steam("812340"), steam("812340")]),
      {
        type: "item",
        id: "Q101",
        labels: { en: { value: "not a game" } },
        claims: { P31: [p31("Q5")] },
      },
      STEAM_PROP,
    ]);
    expect(stats).toMatchObject({
      matched: 1,
      upserted: 1,
      externalIds: 1, // the duplicate value is collapsed onto the unique key
      propertyRows: 1,
      pruned: 0,
      settled: 0,
      stopped: false,
    });

    const rows = await allItems();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      qid: "Q100",
      primaryLabel: "Starfall Drift",
      primaryType: "Q7889",
    });
    expect(rows[0].data.descriptions).toEqual({ en: "Starfall Drift (video game)" });
    expect(await idsOf("Q100")).toEqual([{ property: "P1733", value: "812340" }]);
    expect(await db.select().from(properties)).toMatchObject([
      { pid: "P1733", label: "Steam application ID", datatype: "ExternalId" },
    ]);
  });

  it("is idempotent and rebuilds an item's external ids on re-import", async () => {
    await run([game("Q100", "Starfall Drift", [steam("812340")])]);
    await run([game("Q100", "Starfall Drift II", [steam("999")])]);
    const rows = await allItems();
    expect(rows).toHaveLength(1);
    expect(rows[0].primaryLabel).toBe("Starfall Drift II");
    expect(await idsOf("Q100")).toEqual([{ property: "P1733", value: "999" }]);
  });

  it("skips external id values too long for the column", async () => {
    const stats = await run([
      game("Q100", "Starfall Drift", [steam("812340"), steam("x".repeat(513))]),
    ]);
    expect(stats).toMatchObject({ upserted: 1, externalIds: 1 });
    expect(await idsOf("Q100")).toEqual([{ property: "P1733", value: "812340" }]);
  });

  it("skips an item the database refuses and keeps the rest of its batch", async () => {
    // A property id longer than external_ids.property (varchar 16) makes the
    // item's write fail; its batch-mates are retried one by one and land.
    const bad: Entity = {
      ...game("Q200", "Broken"),
      claims: {
        P31: [p31("Q7889")],
        P12345678901234567890: [
          {
            mainsnak: {
              snaktype: "value",
              property: "P12345678901234567890",
              datatype: "external-id",
              datavalue: { type: "string", value: "x" },
            },
            rank: "normal",
          },
        ],
      },
    };
    // Q200 was imported cleanly from an earlier dump.
    await insertItem(makeItem("Q200", "Broken (old)"));
    const logs: string[] = [];
    const stats = await run([game("Q100", "Alpha", [steam("1")]), bad, game("Q300", "Gamma")], {
      forcePrune: true,
      log: (m) => logs.push(m),
    });
    expect(stats).toMatchObject({ matched: 3, upserted: 2, failed: 1, pruned: 0 });
    // The old row survives untouched rather than being pruned as "gone".
    expect((await allItems()).map((r) => [r.qid, r.primaryLabel])).toEqual([
      ["Q100", "Alpha"],
      ["Q200", "Broken (old)"],
      ["Q300", "Gamma"],
    ]);
    expect(await idsOf("Q100")).toEqual([{ property: "P1733", value: "1" }]);
    expect(logs.some((m) => /skipped Q200: ER_DATA_TOO_LONG/.test(m))).toBe(true);
  });

  it("aborts once more than maxSkipped entities were skipped", async () => {
    const bad = (id: string): Entity => ({
      ...game(id, id),
      claims: { P31: [p31("Q7889")], P12345678901234567890: [steam("x")] },
    });
    await expect(run([bad("Q100"), bad("Q200")], { maxSkipped: 1 })).rejects.toThrow(
      /more than 1 entities skipped/,
    );
  });

  it("prunes items that left the dump and settles their open candidates", async () => {
    await insertItem(makeItem("Q100", "Alpha"));
    await insertItem(makeItem("Q200", "Beta"));
    await insertItem(makeItem("Q300", "Gamma"));
    await db.insert(mergeCandidates).values([
      { fromQid: "Q300", intoQid: "Q100", confidence: 0.9, status: "open", reasons: [] },
      { fromQid: "Q300", intoQid: "Q200", confidence: 0.9, status: "dismissed", reasons: [] },
      { fromQid: "Q200", intoQid: "Q100", confidence: 0.9, status: "open", reasons: [] },
    ]);

    // Q300 is gone from the dump (1 of 3 items is ≤ MAX_PRUNE_FRACTION only
    // with force off if the fraction allows; 1/3 > 0.2, so force it here).
    const stats = await run([game("Q100", "Alpha"), game("Q200", "Beta")], { forcePrune: true });
    expect(stats).toMatchObject({ upserted: 2, pruned: 1, settled: 1 });
    expect((await allItems()).map((r) => r.qid)).toEqual(["Q100", "Q200"]);

    const cands = await db.select().from(mergeCandidates).orderBy(asc(mergeCandidates.id));
    expect(cands.map((c) => [c.fromQid, c.intoQid, c.status])).toEqual([
      ["Q300", "Q100", "dismissed"],
      ["Q300", "Q200", "dismissed"], // was already dismissed; untouched
      ["Q200", "Q100", "open"], // neither side pruned
    ]);
    expect(cands[0].resolution).toMatch(/no longer in the Wikidata dump/);
    expect(cands[0].resolvedAt).not.toBeNull();
    expect(cands[1].resolvedAt).toBeNull();
  });

  it("refuses to prune past the safety cap unless forced", async () => {
    const existing = Array.from({ length: 10 }, (_, i) => makeItem(`Q${i + 1}`, `Game ${i + 1}`));
    for (const it of existing) await insertItem(it);
    expect(3 / 10).toBeGreaterThan(MAX_PRUNE_FRACTION);

    const refused = await run(existing.slice(0, 7).map((it) => game(it.id, it.labels.en)));
    expect(refused.pruned).toBe(0);
    expect(await allItems()).toHaveLength(10);

    const forced = await run(
      existing.slice(0, 7).map((it) => game(it.id, it.labels.en)),
      {
        forcePrune: true,
      },
    );
    expect(forced.pruned).toBe(3);
    expect(await allItems()).toHaveLength(7);
  });

  it("logs the interval rate and the cumulative average on each progress line", async () => {
    const lines: string[] = [];
    await run([game("Q100", "Alpha"), game("Q200", "Beta"), game("Q300", "Gamma")], {
      progressEveryBytes: 1,
      log: (m) => void lines.push(m),
    });
    const progress = lines.filter((l) => l.includes(" MB/s now ("));
    expect(progress.length).toBeGreaterThan(0);
    for (const line of progress)
      expect(line).toMatch(
        /(\d+|\?) MB\/s now \((\d+|\?) avg\), write wait \d+s \((\d+%|\?)\), rss \d+ MB$/,
      );
  });

  it("adds percent done and an ETA when reading from a file on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dump-import-db-"));
    const path = join(dir, "dump.json.gz");
    const entities = [game("Q100", "Alpha"), game("Q200", "Beta"), game("Q300", "Gamma")];
    await writeFile(
      path,
      gzipSync(`[\n${entities.map((e) => `${JSON.stringify(e)},\n`).join("")}]\n`),
    );
    const lines: string[] = [];
    const stats = await runDumpImport({
      path,
      progressEveryBytes: 1,
      prune: false,
      log: (m) => void lines.push(m),
    });
    expect(stats.matched).toBe(3);
    const progress = lines.filter((l) => l.includes(" MB/s now ("));
    expect(progress.length).toBeGreaterThan(0);
    for (const line of progress) {
      expect(line).toMatch(/^import-dump: \[\d+\.\d%\] \d+ GB inflated, /);
      expect(line).toMatch(
        / avg\), ETA (\d+h \d\dm|\d+m|<1m|\?), write wait \d+s \((\d+%|\?)\), rss \d+ MB$/,
      );
    }
    // The whole (tiny) file is read by the time the last line is logged.
    expect(progress.at(-1)).toMatch(/^import-dump: \[100\.0%\] /);
  });

  it("prunes a sharded import only once every shard of the dump has finished", async () => {
    await insertItem(makeItem("Q900", "Left the dump"));
    const dir = await mkdtemp(join(tmpdir(), "dump-import-db-"));
    const path = join(dir, "wikidata-20260914-all.json.gz");
    const games = [game("Q100", "Alpha"), game("Q200", "Beta"), game("Q300", "Gamma")];
    await writeFile(path, dumpGz([[games[0]], [games[1]], [games[2], STEAM_PROP]]).gz);
    const lines: string[] = [];
    const log = (m: string) => void lines.push(m);
    const opts = { path, forcePrune: true, log }; // 1 of 4 gone is past the 20% cap

    const first = await runDumpImport({ ...opts, shard: { index: 0, count: 2 } });
    expect(first.pruned).toBe(0);
    expect(lines.some((l) => l.startsWith("import-dump 1/2: ") && l.includes("waits for"))).toBe(
      true,
    );
    expect((await allItems()).map((r) => r.qid)).toContain("Q900");
    expect(await db.select().from(dumpImportRuns)).toMatchObject([
      { dump: "20260914", shard: 0, shards: 2 },
    ]);

    // A retried shard re-records itself rather than tripping the primary key.
    await runDumpImport({ ...opts, shard: { index: 0, count: 2 } });

    const second = await runDumpImport({ ...opts, shard: { index: 1, count: 2 } });
    expect(second.pruned).toBe(1);
    expect(first.matched + second.matched).toBe(3);
    const rows = await allItems();
    expect(rows.map((r) => r.qid)).toEqual(["Q100", "Q200", "Q300"]);
    expect(rows.map((r) => r.lastDump)).toEqual(["20260914", "20260914", "20260914"]);
    expect(await db.select().from(properties)).toHaveLength(1);
    const runs = await db.select().from(dumpImportRuns).orderBy(asc(dumpImportRuns.shard));
    expect(runs.map((r) => [r.shard, r.shards])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(runs.reduce((n, r) => n + r.matched, 0)).toBe(3);

    // The same dump re-run with another shard count starts a new set: the
    // re-recorded shard 0 now counts towards 3, not 2.
    const again = await runDumpImport({ ...opts, shard: { index: 0, count: 3 } });
    expect(again.pruned).toBe(0);
    expect(await db.select().from(dumpImportRuns).orderBy(asc(dumpImportRuns.shard))).toMatchObject(
      [
        { shard: 0, shards: 3 },
        { shard: 1, shards: 2 },
      ],
    );
  });

  it("keeps an item's dump stamp when the single-item importer rewrites it", async () => {
    await run([game("Q100", "Alpha")], { dump: "20260914" });
    await upsertItems([makeItem("Q100", "Alpha (renamed)")]);
    await upsertItems([makeItem("Q101", "Never in a dump")]);
    const rows = await allItems();
    expect(rows.map((r) => [r.qid, r.primaryLabel, r.lastDump])).toEqual([
      ["Q100", "Alpha (renamed)", "20260914"],
      ["Q101", "Never in a dump", null],
    ]);
  });

  it("never prunes after a capped run, an empty match, or with prune off", async () => {
    await insertItem(makeItem("Q100", "Alpha"));
    await insertItem(makeItem("Q200", "Beta"));

    const capped = await run([game("Q300", "Gamma"), game("Q400", "Delta")], { limit: 1 });
    expect(capped).toMatchObject({ matched: 1, stopped: true, pruned: 0 });
    expect(await allItems()).toHaveLength(3);

    const empty = await run([{ type: "item", id: "Q5", claims: {} }], { forcePrune: true });
    expect(empty).toMatchObject({ matched: 0, pruned: 0 });
    expect(await allItems()).toHaveLength(3);

    const off = await run([game("Q300", "Gamma")], { prune: false, forcePrune: true });
    expect(off.pruned).toBe(0);
    expect(await allItems()).toHaveLength(3);
  });
});
