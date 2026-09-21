// Integration tests for the dump import's write path (server/dump-import.ts)
// against a real MariaDB: upsert + external-id rebuild, property sync, and the
// prune of items that left the dump. Opt-in via DB_TEST=1 — see
// test/global-setup.ts.
import { Readable } from "node:stream";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { asc, eq } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { externalIds, items, mergeCandidates, properties } from "../db/schema.ts";
import { MAX_PRUNE_FRACTION, runDumpImport } from "./dump-import.ts";
import type { Entity, Statement } from "../src/lib/wikibase.ts";
import { DB_TEST, insertItem, makeItem, truncateAll } from "../test/db-helpers.ts";

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
      expect(line).toMatch(/(\d+|\?) MB\/s now \((\d+|\?) avg\), rss \d+ MB$/);
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
