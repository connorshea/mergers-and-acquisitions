// Integration tests for the hunt (server/hunt.ts) against a real MariaDB:
// blocking, scoring, and the upsert rules. Opt-in via DB_TEST=1 — see
// test/global-setup.ts.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import {
  classAncestors,
  dumpImportSegments,
  externalIdDupes,
  externalIds,
  itemSync,
  items,
  mergeCandidates,
  properties,
  syncState,
} from "../db/schema.ts";
import { MIN_CONFIDENCE, runHunt } from "./hunt.ts";
import type { Item, Value } from "../src/lib/compare.ts";
import { DB_TEST, insertItem, makeItem, truncateAll } from "../test/db-helpers.ts";
import { expectConsole, quietLogs } from "../test/console.ts";

const steam = (value: string): Record<string, Value[]> => ({
  P1733: [{ type: "external-id", value }],
});
const allCandidates = () => db.select().from(mergeCandidates);

/**
 * Insert an item row without the denormalized columns insertItem derives, so
 * a test can store data those columns couldn't hold, plus its Steam id row.
 */
async function insertRawItem(data: unknown, qid: string, steamId: string): Promise<void> {
  await db.insert(items).values({ qid, data: data as Item });
  await db.insert(itemSync).values({ qid });
  await db.insert(externalIds).values({ qid, property: "P1733", value: steamId });
}

describe.skipIf(!DB_TEST)("runHunt", () => {
  beforeEach(truncateAll);
  afterAll(() => pool.end());
  quietLogs();

  it("pairs items sharing an external id and stores one scored candidate", async () => {
    // Found by both blocking strategies (shared id AND same label+type); the
    // pair is deduped before scoring.
    await insertItem(
      makeItem("Q100", "Starfall Drift", {
        ...steam("812340"),
        P178: [{ type: "item", value: "Q100010" }],
      }),
    );
    await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));

    const stats = await runHunt();
    expect(stats).toEqual({
      pairs: 1,
      scored: 1,
      upserted: 1,
      deleted: 0,
      pruned: 0,
      failed: 0,
    });

    const rows = await allCandidates();
    expect(rows).toHaveLength(1);
    // Higher QID is merged into the lower one.
    expect(rows[0]).toMatchObject({
      fromQid: "Q200",
      intoQid: "Q100",
      status: "open",
      hasBlocker: false,
      // Copies of each item's type/label, for the list's filters.
      fromType: "Q7889",
      intoType: "Q7889",
      fromLabel: "Starfall Drift",
      intoLabel: "Starfall Drift",
      // What a reviewer must read, for the list's language filter.
      clashLangs: "",
      fromLabelLangs: ",en",
      intoLabelLangs: ",en",
    });
    expect(rows[0]!.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(rows[0]?.reasons.some((r) => r.startsWith("shares external identifier"))).toBe(true);
  });

  it("scores every pair when the pairs span several windows read ahead", async () => {
    // Five pairs in windows of two: three windows, each read while the one
    // before it is scored and written.
    for (let i = 1; i <= 5; i++) {
      await insertItem(makeItem(`Q${i}00`, `Starfall Drift ${i}`, steam(`81234${i}`)));
      await insertItem(makeItem(`Q${i}01`, `Starfall Drift ${i}`, steam(`81234${i}`)));
    }
    const stats = await runHunt({ scoreWindow: 2 });
    expect(stats).toMatchObject({ pairs: 5, scored: 5, upserted: 5, failed: 0 });
    const rows = await allCandidates();
    expect(rows.map((r) => `${r.fromQid}>${r.intoQid}`).sort()).toEqual([
      "Q101>Q100",
      "Q201>Q200",
      "Q301>Q300",
      "Q401>Q400",
      "Q501>Q500",
    ]);
  });

  it("is idempotent across runs", async () => {
    await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
    await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));
    await runHunt();
    const [first] = await allCandidates();
    await runHunt();
    const rows = await allCandidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first!.id);
  });

  it("blocks on label AND type, not label alone", async () => {
    await insertItem(makeItem("Q300", "Gamma"));
    await insertItem(
      makeItem("Q400", "Gamma", {
        P31: [{ type: "item", value: "Q865493", label: "video game mod" }],
      }),
    );
    const stats = await runHunt();
    expect(stats.pairs).toBe(0);
    expect(await allCandidates()).toHaveLength(0);
  });

  it("blocks on the stored label key, filling it in for rows without one", async () => {
    // Differ only in punctuation, so they share a blocking key; no shared id.
    await insertItem(makeItem("Q300", "Go West: A Lucky Luke Adventure"));
    await insertItem(makeItem("Q400", "Go West! A Lucky Luke Adventure"));
    const stats = await runHunt();
    expect(stats.pairs).toBe(1);
    const keys = await db
      .select({ qid: items.qid, blockingKey: items.blockingKey })
      .from(items)
      .orderBy(items.qid);
    expect(keys).toEqual([
      { qid: "Q300", blockingKey: "go west a lucky luke adventure" },
      { qid: "Q400", blockingKey: "go west a lucky luke adventure" },
    ]);
  });

  it("skips an oversized label+type block", async () => {
    for (let i = 0; i < 101; i++) await insertItem(makeItem(`Q${1000 + i}`, "Untitled"));
    const warn = expectConsole("warn");
    expect((await runHunt()).pairs).toBe(0);
    expect(warn).toHaveBeenCalledWith("hunt: skipping oversized label+type block of 101 qids");
  });

  it("never rescores or resurrects a pair Claude hid", async () => {
    await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
    await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));
    await db.insert(mergeCandidates).values({
      fromQid: "Q200",
      intoQid: "Q100",
      confidence: 0.123,
      reasons: ["hidden by Claude"],
      status: "auto_dismissed",
      resolvedAt: "2026-01-01 00:00:00",
      resolution: "llm-review:1",
    });

    await runHunt();

    const rows = await allCandidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "auto_dismissed",
      confidence: 0.123,
      reasons: ["hidden by Claude"],
      resolution: "llm-review:1",
    });
  });

  it("never rescores or resurrects a pair a human resolved", async () => {
    await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
    await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));
    await db.insert(mergeCandidates).values({
      fromQid: "Q200",
      intoQid: "Q100",
      confidence: 0.123,
      reasons: ["reviewed by a human"],
      status: "dismissed",
      resolvedAt: "2026-01-01 00:00:00",
    });

    await runHunt();

    const rows = await allCandidates();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "dismissed",
      confidence: 0.123,
      reasons: ["reviewed by a human"],
      resolvedAt: "2026-01-01 00:00:00",
    });
  });

  it("drops a stale open row once the pair no longer clears the floor", async () => {
    // Same label + type (so the pair is blocked and rescored), but conflicting
    // developer, publisher, release year, and Steam id — scores 0.
    await insertItem(
      makeItem("Q700", "Echo", {
        ...steam("1"),
        P178: [{ type: "item", value: "Q1" }],
        P123: [{ type: "item", value: "Q2" }],
        P577: [{ type: "time", value: "2001-01-01" }],
      }),
    );
    await insertItem(
      makeItem("Q800", "Echo", {
        ...steam("2"),
        P178: [{ type: "item", value: "Q3" }],
        P123: [{ type: "item", value: "Q4" }],
        P577: [{ type: "time", value: "2015-06-01" }],
      }),
    );
    await db.insert(mergeCandidates).values({
      fromQid: "Q800",
      intoQid: "Q700",
      confidence: 0.9,
      reasons: ["stale"],
    });

    const stats = await runHunt();
    expect(stats).toMatchObject({ pairs: 1, scored: 1, upserted: 0, deleted: 1 });
    expect(await allCandidates()).toHaveLength(0);
  });

  it("keeps a dismissed row even when the pair no longer clears the floor", async () => {
    await insertItem(makeItem("Q700", "Echo", { P577: [{ type: "time", value: "2001-01-01" }] }));
    await insertItem(makeItem("Q800", "Echo", { P577: [{ type: "time", value: "2015-06-01" }] }));
    await db.insert(mergeCandidates).values({
      fromQid: "Q800",
      intoQid: "Q700",
      confidence: 0.9,
      reasons: [],
      status: "dismissed",
    });
    await runHunt();
    expect(await allCandidates()).toHaveLength(1);
  });

  it("prunes an open row whose pair the scan no longer produces", async () => {
    // Q100/Q200 still block (and survive); Q300/Q400 share nothing, so an open
    // row for them is an orphan of some older blocking rule.
    await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
    await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));
    await insertItem(makeItem("Q300", "Gamma"));
    await insertItem(makeItem("Q400", "Delta"));
    await db.insert(mergeCandidates).values([
      { fromQid: "Q400", intoQid: "Q300", confidence: 0.9, reasons: ["orphan"] },
      // Items that no longer exist at all.
      { fromQid: "Q999", intoQid: "Q998", confidence: 0.9, reasons: ["orphan"] },
    ]);

    const stats = await runHunt();
    expect(stats).toMatchObject({ pairs: 1, upserted: 1, deleted: 0, pruned: 2 });
    const rows = await allCandidates();
    expect(rows.map((r) => [r.fromQid, r.intoQid])).toEqual([["Q200", "Q100"]]);
  });

  it("keeps a resolved row whose pair the scan no longer produces", async () => {
    await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
    await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));
    await db.insert(mergeCandidates).values({
      fromQid: "Q400",
      intoQid: "Q300",
      confidence: 0.9,
      reasons: [],
      status: "merged",
    });
    const stats = await runHunt();
    expect(stats.pruned).toBe(0);
    expect(await allCandidates()).toHaveLength(2);
  });

  it("prunes nothing when the scan finds no pairs at all", async () => {
    await db.insert(mergeCandidates).values({
      fromQid: "Q400",
      intoQid: "Q300",
      confidence: 0.9,
      reasons: [],
    });
    expect((await runHunt()).pruned).toBe(0);
    expect(await allCandidates()).toHaveLength(1);
  });

  it("drops a pair whose item has left the table since the scan", async () => {
    // An external id that outlived its item still blocks, but there's nothing
    // to score: the pair is dropped and its open row pruned as an orphan.
    await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
    await db.insert(externalIds).values({ qid: "Q900", property: "P1733", value: "812340" });
    await db.insert(mergeCandidates).values({
      fromQid: "Q900",
      intoQid: "Q100",
      confidence: 0.9,
      reasons: ["item gone"],
    });

    const stats = await runHunt();
    expect(stats).toMatchObject({ pairs: 1, scored: 0, upserted: 0, pruned: 1, failed: 0 });
    expect(await allCandidates()).toHaveLength(0);
  });

  it("counts a pair that fails to score and carries on with the rest", async () => {
    await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
    await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));
    // No statements: the scorer throws on it.
    const broken = (id: string) => ({ id, labels: {}, sitelinks: {} });
    await insertRawItem(broken("Q300"), "Q300", "999");
    await insertRawItem(broken("Q400"), "Q400", "999");

    const error = expectConsole("error");
    const stats = await runHunt();
    expect(stats).toMatchObject({ pairs: 2, scored: 2, upserted: 1, failed: 1 });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("pair Q300/Q400 failed"),
      expect.anything(),
    );
    const rows = await allCandidates();
    expect(rows.map((r) => [r.fromQid, r.intoQid])).toEqual([["Q200", "Q100"]]);
  });

  it("retries a failed batch upsert row by row, losing only the bad row", async () => {
    await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
    await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));
    // A P31 longer than merge_candidates.from_type holds: the pair scores, but
    // its row can't be written, which fails the multi-row upsert it's part of.
    const longType = `Q${"9".repeat(40)}`;
    const odd = (id: string) =>
      makeItem(id, "Echo", { ...steam("777"), P31: [{ type: "item", value: longType }] });
    await insertRawItem(odd("Q300"), "Q300", "777");
    await insertRawItem(odd("Q400"), "Q400", "777");

    const warn = expectConsole("warn");
    const error = expectConsole("error");
    const stats = await runHunt();
    expect(stats).toMatchObject({ pairs: 2, scored: 2, upserted: 1, failed: 1 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying rows individually"),
      expect.anything(),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("pair Q400/Q300 failed"),
      expect.anything(),
    );
    const rows = await allCandidates();
    expect(rows.map((r) => [r.fromQid, r.intoQid])).toEqual([["Q200", "Q100"]]);
  });

  it("writes an audit record per scored pair with AUDIT=1", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hunt-audit-"));
    process.env.AUDIT = "1";
    process.env.AUDIT_DIR = dir;
    try {
      await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
      await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));
      await runHunt();
      const lines = (await readFile(join(dir, "pairs.jsonl"), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        from: "Q200",
        into: "Q100",
        fromLabel: "Starfall Drift",
        intoType: "Q7889",
        kept: true,
      });
    } finally {
      delete process.env.AUDIT;
      delete process.env.AUDIT_DIR;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a shared id the property's subject type constraint rules out", async () => {
    // A BVMC person ID (P2799) copied onto two different games: once the
    // constraint and the games' class ancestry are synced, it's no evidence.
    const personId: Record<string, Value[]> = { P2799: [{ type: "external-id", value: "4321" }] };
    await insertItem(makeItem("Q500", "Delta One", personId));
    await insertItem(makeItem("Q600", "Delta Two", personId));
    await db.insert(properties).values({
      pid: "P2799",
      label: "BVMC person ID",
      datatype: "ExternalId",
      subjectTypes: [{ classes: ["Q5"], relation: "instance", exceptions: [] }],
    });

    // Constraint synced but no ancestor data yet: the check fails open.
    expect(await runHunt()).toMatchObject({ pairs: 1, upserted: 1 });

    await db.delete(mergeCandidates);
    await db.insert(classAncestors).values([
      { class: "Q7889", ancestor: "Q7889" },
      { class: "Q5", ancestor: "Q5" },
    ]);
    expect(await runHunt()).toMatchObject({ pairs: 1, scored: 1, upserted: 0 });
    expect(await allCandidates()).toHaveLength(0);
  });

  it("lowers namesake humans with no occupation in common once the name is common", async () => {
    const occupations = ["Q937857", "Q33999", "Q82955", "Q1622272", "Q39631"];
    const human = (i: number) =>
      makeItem(`Q${700 + i}`, "Alex Morgan", {
        P31: [{ type: "item", value: "Q5", label: "human" }],
        P106: [{ type: "item", value: occupations[i]! }],
      });
    // Four namesakes: the name alone carries each pair over the floor.
    for (let i = 0; i < 4; i++) await insertItem(human(i));
    expect(await runHunt()).toMatchObject({ pairs: 6, upserted: 6 });

    // A fifth makes it a common name (COMMON_NAME_MIN), so each conflict counts.
    await db.delete(mergeCandidates);
    await insertItem(human(4));
    expect(await runHunt()).toMatchObject({ pairs: 10, scored: 10, upserted: 0 });
    expect(await allCandidates()).toHaveLength(0);
  });

  describe("mass-prune guard", () => {
    const orphans = Array.from({ length: 150 }, (_, i) => ({
      fromQid: `Q${20000 + i}`,
      intoQid: `Q${10000 + i}`,
      confidence: 0.9,
      reasons: [],
    }));
    const seed = async () => {
      await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
      await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));
      await db.insert(mergeCandidates).values(orphans);
    };
    afterEach(() => {
      delete process.env.HUNT_FORCE_PRUNE;
    });

    it("skips the prune when most open rows would go", async () => {
      await seed();
      const warn = expectConsole("warn");
      expect((await runHunt()).pruned).toBe(0);
      expect(await allCandidates()).toHaveLength(151);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("NOT pruning 150 of 150 open rows"),
      );
    });

    it("prunes anyway with HUNT_FORCE_PRUNE=1", async () => {
      await seed();
      process.env.HUNT_FORCE_PRUNE = "1";
      expect((await runHunt()).pruned).toBe(150);
      expect(await allCandidates()).toHaveLength(1);
    });
  });

  it("only blocks on real identifier properties once the property table is synced", async () => {
    // Two differently-named games sharing a review score (P444), which the dump
    // path classifies as external-id shaped.
    const score: Record<string, Value[]> = { P444: [{ type: "external-id", value: "80" }] };
    await insertItem(makeItem("Q500", "Delta One", score));
    await insertItem(makeItem("Q600", "Delta Two", score));

    // Before the first property sync: legacy behaviour, any shared value blocks.
    expect((await runHunt()).pairs).toBe(1);
    expect(await allCandidates()).toHaveLength(1);

    // After the sync, P444 is known not to be an identifier, so nothing pairs.
    await db.delete(mergeCandidates);
    await db.insert(properties).values([
      { pid: "P1733", label: "Steam application ID", datatype: "ExternalId" },
      { pid: "P444", label: "review score", datatype: "String" },
    ]);
    expect((await runHunt()).pairs).toBe(0);
    expect(await allCandidates()).toHaveLength(0);
  });

  describe("shared id keys", () => {
    const dupeKeys = async () =>
      (await db.select().from(externalIdDupes).orderBy(externalIdDupes.value)).map((k) => [
        k.property,
        k.value,
      ]);
    // Did the run rebuild external_id_dupes from scratch, or only add new rows?
    const rebuiltOn = async (run: () => Promise<unknown>): Promise<boolean> => {
      const log = vi.mocked(console.log);
      log.mockClear();
      await run();
      return log.mock.calls.some(([line]) => String(line).includes("rebuilding the shared id"));
    };

    it("adds keys from new rows and drops keys that are no longer shared", async () => {
      await insertItem(makeItem("Q100", "Alpha", steam("1")));
      await insertItem(makeItem("Q200", "Beta", steam("1")));
      await insertItem(makeItem("Q300", "Gamma", steam("2")));
      expect(await rebuiltOn(async () => expect((await runHunt()).pairs).toBe(1))).toBe(true);
      expect(await dupeKeys()).toEqual([["P1733", "1"]]);
      // An aggregate with no GROUP BY always returns exactly one row.
      const [{ maxId }] = (await db
        .select({ maxId: sql<number>`max(${externalIds.id})` })
        .from(externalIds)) as [{ maxId: number }];
      const [state] = await db
        .select()
        .from(syncState)
        .where(eq(syncState.scope, "hunt-external-id-dupes"));
      expect(state?.cursor).toBe(Number(maxId));

      // A new item sharing Q300's id: found without a rebuild.
      await insertItem(makeItem("Q400", "Delta", steam("2")));
      expect(await rebuiltOn(async () => expect((await runHunt()).pairs).toBe(2))).toBe(false);
      expect(await dupeKeys()).toEqual([
        ["P1733", "1"],
        ["P1733", "2"],
      ]);

      // Q200's id goes away (a merge, or an edit on Wikidata): the key is dropped.
      await db.delete(externalIds).where(eq(externalIds.qid, "Q200"));
      expect(await rebuiltOn(async () => expect((await runHunt()).pairs).toBe(1))).toBe(false);
      expect(await dupeKeys()).toEqual([["P1733", "2"]]);
    });

    it("never keys on a library classification, and drops keys stored before", async () => {
      // Two books on one subject: the same Dewey number, nothing else shared.
      const dewey: Record<string, Value[]> = { P1036: [{ type: "external-id", value: "499.221" }] };
      await insertItem(makeItem("Q100", "Struktur bahasa Manui", dewey));
      await insertItem(makeItem("Q200", "Struktur bahasa Mekongga", dewey));
      expect(await rebuiltOn(async () => expect((await runHunt()).pairs).toBe(0))).toBe(true);
      expect(await dupeKeys()).toEqual([]);

      // New rows above the watermark aren't keyed either.
      await insertItem(makeItem("Q300", "Struktur bahasa Baru", dewey));
      expect(await rebuiltOn(async () => expect((await runHunt()).pairs).toBe(0))).toBe(false);
      expect(await dupeKeys()).toEqual([]);

      // A key an earlier hunt stored is dropped without a rebuild.
      await db.insert(externalIdDupes).values({ property: "P1036", value: "499.221" });
      expect(await rebuiltOn(async () => expect((await runHunt()).pairs).toBe(0))).toBe(false);
      expect(await dupeKeys()).toEqual([]);
    });

    it("keeps the watermark back while a dump import is running", async () => {
      await insertItem(makeItem("Q100", "Alpha", steam("1")));
      await insertItem(makeItem("Q200", "Beta", steam("1")));
      const cursor = async () =>
        (await db.select().from(syncState).where(eq(syncState.scope, "hunt-external-id-dupes")))[0]
          ?.cursor;
      // A live claim: a worker may still be committing rows below max(id).
      await db.insert(dumpImportSegments).values({
        dump: "20260922",
        segments: 64,
        segment: 0,
        claimedBy: "import-dump-1",
        claim: "abc",
        claimedAt: sql`current_timestamp`,
      });
      await runHunt();
      expect(await cursor()).toBe(0);

      // Finished (or abandoned) claims don't count.
      await db.update(dumpImportSegments).set({ doneAt: sql`current_timestamp` });
      await runHunt();
      const [{ maxId }] = (await db
        .select({ maxId: sql<number>`max(${externalIds.id})` })
        .from(externalIds)) as [{ maxId: number }];
      expect(await cursor()).toBe(Number(maxId));
    });

    it("rebuilds once the external ids have been truncated", async () => {
      for (const qid of ["Q100", "Q200", "Q300"]) await insertItem(makeItem(qid, qid, steam("1")));
      await runHunt();
      await db.execute(sql`truncate table external_ids`);
      await db.execute(sql`delete from items`);
      await insertItem(makeItem("Q500", "Epsilon", steam("9")));
      await insertItem(makeItem("Q600", "Zeta", steam("9")));
      expect(await rebuiltOn(async () => expect((await runHunt()).pairs).toBe(1))).toBe(true);
      expect(await dupeKeys()).toEqual([["P1733", "9"]]);
    });
  });
});
