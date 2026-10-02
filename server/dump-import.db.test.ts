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
import { and, asc, eq, sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import {
  dumpImportSegments,
  externalIds,
  items,
  mergeCandidates,
  properties,
} from "../db/schema.ts";
import { MAX_PRUNE_FRACTION, runDumpImport, sharedLinkedQids, upsertItems } from "./dump-import.ts";
import { SELECTIVE_IMPORT_CLASSES } from "../src/lib/import-classes.ts";
import { CONVERTER_VERSION } from "./converter-version.ts";
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
/** The entity as the dump has it at revision `lastrevid`. */
const at = (lastrevid: number, entity: Entity): Entity => ({ ...entity, lastrevid });
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
const segmentRows = async () =>
  (
    await db
      .select()
      .from(dumpImportSegments)
      .orderBy(asc(dumpImportSegments.segments), asc(dumpImportSegments.segment))
  ).map((r) => ({ ...r, done: r.doneAt !== null }));
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
      blockingKey: "starfall drift",
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
    expect(rows[0].blockingKey).toBe("starfall drift ii");
    expect(await idsOf("Q100")).toEqual([{ property: "P1733", value: "999" }]);
  });

  it("only touches the external id rows that changed", async () => {
    await run([game("Q100", "Alpha", [steam("1"), steam("2")])]);
    const rowId = async (value: string) =>
      (
        await db
          .select({ id: externalIds.id })
          .from(externalIds)
          .where(eq(externalIds.value, value))
      )[0]?.id;
    const kept = await rowId("1");
    const stats = await run([game("Q100", "Alpha II", [steam("1"), steam("3")])]);
    expect(stats).toMatchObject({ upserted: 1, unchanged: 0, externalIds: 2 });
    expect(await rowId("1")).toBe(kept);
    expect(await rowId("2")).toBeUndefined();
    expect((await idsOf("Q100")).map((r) => r.value).sort()).toEqual(["1", "3"]);
  });

  it("only restamps an item whose converted data is unchanged", async () => {
    await run([game("Q100", "Alpha", [steam("1")]), game("Q200", "Beta", [steam("2")])], {
      dump: "20260914",
    });
    const [before] = await allItems();
    expect(before.dataHash).toMatch(/^[0-9a-f]{40}$/);

    const stats = await run(
      [game("Q100", "Alpha", [steam("1")]), game("Q200", "Beta Remastered", [steam("3")])],
      { dump: "20260921" },
    );
    expect(stats).toMatchObject({
      matched: 2,
      upserted: 2,
      unchanged: 1,
      externalIds: 1,
      pruned: 0,
    });
    const rows = await allItems();
    expect(rows.map((r) => [r.qid, r.primaryLabel, r.lastDump])).toEqual([
      ["Q100", "Alpha", "20260921"],
      ["Q200", "Beta Remastered", "20260921"],
    ]);
    expect(rows[0].dataHash).toBe(before.dataHash);
    expect(rows[1].dataHash).not.toBe(before.dataHash);
    // The unchanged item kept its external ids; the changed one was rebuilt.
    expect(await idsOf("Q100")).toEqual([{ property: "P1733", value: "1" }]);
    expect(await idsOf("Q200")).toEqual([{ property: "P1733", value: "3" }]);
  });

  it("writes an item in full when its stored hash is missing", async () => {
    await run([game("Q100", "Alpha", [steam("1")])]);
    await db.update(items).set({ dataHash: null });
    const stats = await run([game("Q100", "Alpha", [steam("1")])]);
    expect(stats).toMatchObject({ upserted: 1, unchanged: 0, externalIds: 1 });
    expect((await allItems())[0].dataHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("stores an item whose only label is too long for primary_label", async () => {
    // Q55094769 in dump 20260922: a 260-character Italian title and no English one.
    const long: Entity = { ...game("Q100", ""), labels: { it: { value: "t".repeat(260) } } };
    const stats = await run([long]);
    expect(stats).toMatchObject({ upserted: 1, failed: 0 });
    const [row] = await allItems();
    expect(row.primaryLabel).toBe(`${"t".repeat(254)}…`);
    expect(row.data.labels.it).toHaveLength(260);
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
    expect(await segmentRows()).toMatchObject([
      { segments: 2, segment: 0, done: true },
      { segments: 2, segment: 1, done: false },
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
    const runs = await segmentRows();
    expect(runs.map((r) => [r.segment, r.segments, r.done])).toEqual([
      [0, 2, true],
      [1, 2, true],
    ]);
    expect(runs.reduce((n, r) => n + (r.matched ?? 0), 0)).toBe(3);

    // The same dump re-run with another shard count starts a new set: shard 0
    // of 3 doesn't complete it, whatever the set of 2 did.
    const again = await runDumpImport({ ...opts, shard: { index: 0, count: 3 } });
    expect(again.pruned).toBe(0);
    expect((await segmentRows()).map((r) => [r.segments, r.segment, r.done])).toEqual([
      [2, 0, true],
      [2, 1, true],
      [3, 0, true],
      [3, 1, false],
      [3, 2, false],
    ]);
  });

  describe("as queue workers", () => {
    // Six games, one gzip member each, so the segments partition them.
    const GAMES = ["Q100", "Q200", "Q300", "Q400", "Q500", "Q600"];
    const SEGMENTS = 6;
    const DUMP = "20260914";

    async function writeDump(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), "dump-import-db-"));
      const path = join(dir, `wikidata-${DUMP}-all.json.gz`);
      const batches: object[][] = GAMES.map((qid) => [game(qid, `Game ${qid}`)]);
      batches[batches.length - 1].push(STEAM_PROP);
      await writeFile(path, dumpGz(batches).gz);
      return path;
    }

    /** Pre-create the set with some rows already claimed or done. */
    async function seedSet(
      rows: { segment: number; claimedBy?: string; ageSeconds?: number; matched?: number }[],
    ): Promise<void> {
      await db.insert(dumpImportSegments).values(
        Array.from({ length: SEGMENTS }, (_, segment) => ({
          dump: DUMP,
          segments: SEGMENTS,
          segment,
        })),
      );
      for (const r of rows) {
        const where = and(
          eq(dumpImportSegments.dump, DUMP),
          eq(dumpImportSegments.segments, SEGMENTS),
          eq(dumpImportSegments.segment, r.segment),
        );
        if (r.claimedBy !== undefined) {
          await db
            .update(dumpImportSegments)
            .set({
              claimedBy: r.claimedBy,
              claim: "0000000000000000",
              claimedAt: sql`current_timestamp - interval ${sql.raw(String(r.ageSeconds ?? 0))} second`,
            })
            .where(where);
        }
        if (r.matched !== undefined) {
          await db
            .update(dumpImportSegments)
            .set({ doneAt: sql`current_timestamp`, matched: r.matched })
            .where(where);
        }
      }
    }

    const worker = (path: string, name: string, extra: Parameters<typeof runDumpImport>[0] = {}) =>
      runDumpImport({
        path,
        worker: name,
        segments: SEGMENTS,
        waitPollMs: 50,
        log: () => {},
        ...extra,
      });

    it("scans every segment exactly once between racing workers, and the last to finish prunes", async () => {
      await insertItem(makeItem("Q900", "Left the dump"));
      const path = await writeDump();

      const [a, b] = await Promise.all([worker(path, "a"), worker(path, "b")]);
      expect(a.segmentsScanned + b.segmentsScanned).toBe(SEGMENTS);
      // Each item matched once across the two: no segment was read twice.
      expect(a.matched + b.matched).toBe(GAMES.length);
      expect(a.pruned + b.pruned).toBe(1);
      expect((await allItems()).map((r) => r.qid)).toEqual(GAMES);
      const rows = await segmentRows();
      expect(rows.every((r) => r.done && (r.claimedBy === "a" || r.claimedBy === "b"))).toBe(true);
      expect(rows.reduce((n, r) => n + (r.matched ?? 0), 0)).toBe(GAMES.length);

      // A worker started on a dump that is already imported finds nothing to do…
      const late = await worker(path, "c");
      expect([late.segmentsScanned, late.pruned]).toEqual([0, 0]);
      // …unless asked to import it again…
      const redo = await worker(path, "c", { redo: "t1" });
      expect(redo.segmentsScanned).toBe(SEGMENTS);
      expect(redo.matched).toBe(GAMES.length);
      expect((await segmentRows()).every((r) => r.done && r.pass === "t1")).toBe(true);
      // …once: a worker of the same re-import that starts after it finished
      // (Pending, or a retry) leaves the set alone.
      const straggler = await worker(path, "d", { redo: "t1" });
      expect([straggler.segmentsScanned, straggler.pruned]).toEqual([0, 0]);
      // A new token is a new re-import.
      const next = await worker(path, "d", { redo: "t2" });
      expect(next.segmentsScanned).toBe(SEGMENTS);
    });

    it("reads the linked QIDs once per pass for all its workers, and afresh on a redo", async () => {
      const designedBy = (qid: string) => ({ P287: [{ type: "item" as const, value: qid }] });
      await insertItem(makeItem("Q900", "Names Q20", designedBy("Q20")));
      const path = await writeDump();
      const lines: string[] = [];
      const log = (m: string) => void lines.push(m);
      const linkedLines = () => lines.filter((l) => l.includes("items linked from the mirror"));

      await Promise.all([worker(path, "a", { log }), worker(path, "b", { log })]);
      // Every item-valued statement counts: Q20, and Q7889 from the P31.
      expect(
        linkedLines()
          .map((l) => l.replace(/^import-dump \w+: /, "").replace(/ in .*/, ""))
          .sort(),
      ).toEqual([
        "2 items linked from the mirror, loaded",
        "2 items linked from the mirror, read from the pass's first worker",
      ]);

      // The pass keeps the set it started with, whatever the mirror says now.
      await insertItem(
        makeItem("Q901", "Names Q21 and Q22", {
          P287: [...designedBy("Q21").P287, ...designedBy("Q22").P287],
        }),
      );
      const sources = [...new Set(SELECTIVE_IMPORT_CLASSES.flatMap((c) => c.linkedFrom))];
      expect(await sharedLinkedQids(DUMP, SEGMENTS, sources)).toEqual({
        qids: new Set([20, 7889]),
        shared: true,
      });

      // A redo is a new pass: it reads the mirror again (Q900 was pruned).
      lines.length = 0;
      await worker(path, "c", { log, redo: "t1" });
      expect(linkedLines()).toEqual([
        expect.stringMatching(/: 3 items linked from the mirror, loaded in /),
      ]);

      // A worker with nothing left to scan reads nothing.
      lines.length = 0;
      await worker(path, "d", { log });
      expect(linkedLines()).toEqual([]);
    });

    it("takes over a stale claim, and waits out a live one until it goes stale", async () => {
      const path = await writeDump();
      // Segment 1's worker died an hour ago; segment 4's claim is fresh.
      await seedSet([
        { segment: 1, claimedBy: "dead", ageSeconds: 3600 },
        { segment: 4, claimedBy: "busy" },
      ]);
      const lines: string[] = [];
      const stats = await worker(path, "w", {
        staleClaimSeconds: 2,
        waitPollMs: 100,
        log: (m) => void lines.push(m),
      });
      expect(stats.segmentsScanned).toBe(SEGMENTS);
      expect(lines.some((l) => l.includes("taken over from dead"))).toBe(true);
      expect(lines.some((l) => l.includes("waiting on the 1 segment(s)"))).toBe(true);
      expect(lines.some((l) => l.includes("taken over from busy"))).toBe(true);
      expect((await segmentRows()).every((r) => r.done && r.claimedBy === "w")).toBe(true);
      expect((await allItems()).map((r) => r.qid)).toEqual(GAMES);
    });

    it("prunes only once every segment is done, by the worker that finishes the last", async () => {
      await insertItem(makeItem("Q900", "Left the dump"));
      const path = await writeDump();
      // "other" holds segment 2 (fresh), so "w" runs out of segments first.
      await seedSet([{ segment: 2, claimedBy: "other" }]);
      const lines: string[] = [];
      const waiting = worker(path, "w", { waitPollMs: 50, log: (m) => void lines.push(m) });
      while (!lines.some((l) => l.includes("nothing left to claim"))) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await allItems()).map((r) => r.qid)).toContain("Q900");

      // "other" is retried under the same name and picks its segment back up.
      const other = await worker(path, "other");
      expect(other.segmentsScanned).toBe(1);
      expect(other.pruned).toBe(1);
      const w = await waiting;
      expect(w.segmentsScanned).toBe(SEGMENTS - 1);
      expect(w.pruned).toBe(0);
      expect((await allItems()).map((r) => r.qid)).toEqual(GAMES);
    });

    it("prunes a finished set without rescanning when re-run with forcePrune", async () => {
      const path = await writeDump();
      await worker(path, "a");
      // Items that left the dump after the pass, past the 20% cap.
      for (const qid of ["Q901", "Q902", "Q903"]) await insertItem(makeItem(qid, "Left the dump"));
      const lines: string[] = [];
      const forced = await worker(path, "a", {
        forcePrune: true,
        log: (m) => void lines.push(m),
      });
      expect([forced.segmentsScanned, forced.pruned]).toEqual([0, 3]);
      expect(lines.some((l) => l.includes("pruning it as forced"))).toBe(true);
      expect((await allItems()).map((r) => r.qid)).toEqual(GAMES);
    });

    it("resumes a retried worker at its unfinished segment rather than starting over", async () => {
      const path = await writeDump();
      // Every segment but 3 is done (by this worker's earlier pod, say); it
      // died holding 3.
      await seedSet([
        ...[0, 1, 2, 4, 5].map((segment) => ({ segment, claimedBy: "w", matched: 1 })),
        { segment: 3, claimedBy: "w" },
      ]);
      const stats = await worker(path, "w");
      expect(stats.segmentsScanned).toBe(1);
      const stored = await allItems();
      expect(stats.matched).toBe(stored.length);
      expect(stored.length).toBeLessThan(GAMES.length);
      expect((await segmentRows()).every((r) => r.done)).toBe(true);
    });
  });

  it("keeps an item's dump stamp when the single-item importer rewrites it", async () => {
    await run([at(10, game("Q100", "Alpha"))], { dump: "20260914" });
    await upsertItems([makeItem("Q100", "Alpha (renamed)")]);
    await upsertItems([makeItem("Q101", "Never in a dump")]);
    const rows = await allItems();
    // Without a revision to go with the new data, none is recorded.
    expect(rows.map((r) => [r.qid, r.primaryLabel, r.lastDump, r.sourceRevid])).toEqual([
      ["Q100", "Alpha (renamed)", "20260914", null],
      ["Q101", "Never in a dump", null, null],
    ]);
  });

  it("skips an item stored at the dump's revision without parsing it", async () => {
    await run([at(10, game("Q100", "Alpha", [steam("1")])), at(20, game("Q200", "Beta"))], {
      dump: "20260914",
    });
    expect((await allItems()).map((r) => [r.qid, r.sourceRevid, r.converterVersion])).toEqual([
      ["Q100", 10, CONVERTER_VERSION],
      ["Q200", 20, CONVERTER_VERSION],
    ]);

    // Q100's line differs but claims the same revision: had it been parsed,
    // the label would change. Q200 is at a new revision and is parsed.
    const lines: string[] = [];
    const stats = await run(
      [at(10, game("Q100", "Not parsed")), at(21, game("Q200", "Beta Remastered"))],
      { dump: "20260921", log: (m) => void lines.push(m) },
    );
    expect(stats).toMatchObject({ parsed: 1, matched: 2, unedited: 1, upserted: 1, pruned: 0 });
    expect(lines.some((l) => /2 items stored at a known revision/.test(l))).toBe(true);
    expect(
      (await allItems()).map((r) => [r.qid, r.primaryLabel, r.lastDump, r.sourceRevid]),
    ).toEqual([
      ["Q100", "Alpha", "20260921", 10],
      ["Q200", "Beta Remastered", "20260921", 21],
    ]);
    expect(await idsOf("Q100")).toEqual([{ property: "P1733", value: "1" }]);
  });

  it("records the new revision of an item whose converted data didn't change", async () => {
    await run([at(10, game("Q100", "Alpha"))]);
    const first = (await allItems())[0];
    // An edit the conversion drops (here, nothing at all) still moves the revision.
    const stats = await run([at(11, game("Q100", "Alpha"))]);
    expect(stats).toMatchObject({ unedited: 0, unchanged: 1 });
    const [row] = await allItems();
    expect(row.sourceRevid).toBe(11);
    expect(row.dataHash).toBe(first.dataHash);
    expect(await run([at(11, game("Q100", "Alpha"))])).toMatchObject({ unedited: 1 });
  });

  it("parses a stored item again under a new converter version, or on a full pass", async () => {
    await run([at(10, game("Q100", "Alpha"))]);
    await db.update(items).set({ converterVersion: CONVERTER_VERSION - 1 });
    expect(await run([at(10, game("Q100", "Alpha"))])).toMatchObject({
      parsed: 1,
      unedited: 0,
      unchanged: 1,
    });
    // Same output, so the row is now vouched for by the current version.
    expect((await allItems())[0].converterVersion).toBe(CONVERTER_VERSION);
    expect(await run([at(10, game("Q100", "Alpha"))])).toMatchObject({ unedited: 1 });

    const lines: string[] = [];
    const full = await run([at(10, game("Q100", "Alpha"))], {
      full: true,
      log: (m) => void lines.push(m),
    });
    expect(full).toMatchObject({ parsed: 1, unedited: 0, unchanged: 1 });
    expect(lines.some((l) => l.includes("full pass"))).toBe(true);
  });

  it("doesn't carry forward an item whose class was dropped from the import", async () => {
    // A mod that is "based on" a video game: in scope while mods are imported.
    const mod: Entity = {
      ...game("Q300", "Doom Mod"),
      claims: { P31: [p31("Q865493")], P144: [p31("Q7889")] },
    };
    await run([at(10, game("Q100", "Alpha")), at(30, mod)], {
      classQids: ["Q7889", "Q865493"],
      dump: "20260914",
    });
    expect((await allItems()).map((r) => [r.qid, r.primaryType])).toEqual([
      ["Q100", "Q7889"],
      ["Q300", "Q865493"],
    ]);

    // Mods dropped: the line still passes the pre-filter (it mentions Q7889),
    // but isn't skipped as unedited, so it's parsed, found out of scope, and pruned.
    const stats = await run([at(10, game("Q100", "Alpha")), at(30, mod)], {
      classQids: ["Q7889"],
      dump: "20260921",
      forcePrune: true,
    });
    expect(stats).toMatchObject({ parsed: 1, matched: 1, unedited: 1, pruned: 1 });
    expect((await allItems()).map((r) => r.qid)).toEqual(["Q100"]);
  });

  it("imports game people: linked from games, or by occupation, pruning the unlinked", async () => {
    const human = (id: string, label: string): Entity => ({
      type: "item",
      id,
      labels: { en: { value: label } },
      claims: { P31: [p31("Q5")] },
    });
    const designedBy = (entity: Entity, qid: string): Entity => ({
      ...entity,
      claims: { ...entity.claims, P287: [p31(qid)] },
    });
    // A game designer by occupation, whom no game names.
    const designer: Entity = {
      ...human("Q30", "Grace Designer"),
      claims: {
        P31: [p31("Q5")],
        P106: [{ ...p31("Q3630699"), mainsnak: { ...p31("Q3630699").mainsnak, property: "P106" } }],
      },
    };
    // The mirror's game names Q20 as its designer; nothing names Q21.
    await run([at(10, designedBy(game("Q100", "Alpha"), "Q20"))], { dump: "20260907" });
    const dump = [
      at(10, designedBy(game("Q100", "Alpha"), "Q20")),
      at(20, human("Q20", "Ada Designer")),
      at(21, human("Q21", "Someone Else")),
      at(30, designer),
    ];
    const lines: string[] = [];
    const first = await run(dump, { dump: "20260914", log: (m) => void lines.push(m) });
    expect(first).toMatchObject({ matched: 3, unedited: 1, parsed: 2 });
    expect(lines.some((l) => l.includes("2 items linked from the mirror"))).toBe(true);
    expect((await allItems()).map((r) => [r.qid, r.primaryType])).toEqual([
      ["Q100", "Q7889"],
      ["Q20", "Q5"],
      ["Q30", "Q5"],
    ]);

    // Unedited next week, the human is skipped unparsed like any other item.
    expect(await run(dump, { dump: "20260921" })).toMatchObject({ unedited: 3, parsed: 0 });

    // The game drops its designer: the human is still linked from the mirror
    // this week, and left out and pruned the week after. The designer by
    // occupation stays.
    const unlinked = [at(11, game("Q100", "Alpha")), ...dump.slice(1)];
    expect(await run(unlinked, { dump: "20260928" })).toMatchObject({ matched: 3, pruned: 0 });
    expect(await run(unlinked, { dump: "20261005", forcePrune: true })).toMatchObject({
      matched: 2,
      pruned: 1,
    });
    expect((await allItems()).map((r) => r.qid)).toEqual(["Q100", "Q30"]);
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
