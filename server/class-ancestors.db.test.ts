// Integration tests for the class-ancestor sync (server/class-ancestors.ts)
// against a real MariaDB, with the QLever lookup stubbed. Opt-in via
// DB_TEST=1 — see test/global-setup.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { db, pool } from "./db.ts";
import { classAncestors, items } from "../db/schema.ts";
import { collectItemClasses, syncClassAncestors } from "./class-ancestors.ts";
import type { Item, Value } from "../src/lib/compare.ts";
import { fetchClassAncestors } from "../src/lib/sparql.ts";
import { DB_TEST, insertItemValues, truncateAll } from "../test/db-helpers.ts";
import { quietLogs } from "../test/console.ts";

vi.mock("../src/lib/sparql.ts", () => ({
  fetchClassAncestors: vi.fn<typeof fetchClassAncestors>(),
}));

function item(qid: string, statements: Record<string, Value[]>): typeof items.$inferInsert {
  const data: Item = {
    id: qid,
    labels: {},
    descriptions: {},
    aliases: {},
    sitelinks: {},
    statements,
  };
  return { qid, primaryLabel: qid, data };
}

/** Insert items with the `item_values` rows the import would write for them. */
async function insert(rows: (typeof items.$inferInsert)[]): Promise<void> {
  await db.insert(items).values(rows);
  await insertItemValues(rows.map((r) => r.data));
}

const ref = (value: string): Value => ({ type: "item", value });

const rows = async () =>
  (await db.select().from(classAncestors)).map((r) => `${r.class}>${r.ancestor}`).sort();

afterAll(() => (DB_TEST ? pool.end() : undefined));

describe.skipIf(!DB_TEST)("collectItemClasses", () => {
  beforeEach(truncateAll);

  it("collects distinct instance of and subclass of values", async () => {
    await insert([
      item("Q1", { P31: [ref("Q7889")], P136: [ref("Q100")] }),
      item("Q2", { P31: [ref("Q7889"), ref("Q7725634")] }),
      item("Q3", { P279: [ref("Q386724")], P31: [{ type: "somevalue", value: "" }] }),
      item("Q4", {}),
    ]);
    expect((await collectItemClasses()).sort()).toEqual(["Q386724", "Q7725634", "Q7889"]);
  });

  it("refuses to collect from an empty item_values beside a non-empty mirror", async () => {
    await db.insert(items).values([item("Q1", { P31: [ref("Q7889")] })]);
    await expect(collectItemClasses()).rejects.toThrow(/item_values is empty/);
  });

  it("collects nothing from an empty mirror", async () => {
    expect(await collectItemClasses()).toEqual([]);
  });
});

describe.skipIf(!DB_TEST)("syncClassAncestors", () => {
  beforeEach(truncateAll);
  quietLogs();

  it("replaces looked-up classes, drops gone ones, and keeps failed ones", async () => {
    await insert([item("Q1", { P31: [ref("Q7889")] }), item("Q2", { P31: [ref("Q7725634")] })]);
    await db.insert(classAncestors).values([
      { class: "Q7889", ancestor: "Q7889" },
      { class: "Q7889", ancestor: "Q1" }, // stale
      { class: "Q7725634", ancestor: "Q7725634" },
      { class: "Q7725634", ancestor: "Q47461344" },
      { class: "Q5", ancestor: "Q5" }, // no item has it any more
    ]);
    vi.mocked(fetchClassAncestors).mockResolvedValueOnce({
      ancestors: new Map([["Q7889", ["Q7889", "Q386724"]]]),
      failed: ["Q7725634"],
    });
    expect(await syncClassAncestors()).toEqual({ classes: 1, rows: 2, failed: 1 });
    expect(await rows()).toEqual([
      "Q7725634>Q47461344",
      "Q7725634>Q7725634",
      "Q7889>Q386724",
      "Q7889>Q7889",
    ]);
  });

  it("throws, writing nothing, when every lookup fails", async () => {
    await insert([item("Q1", { P31: [ref("Q7889")] })]);
    await db.insert(classAncestors).values([{ class: "Q7889", ancestor: "Q7889" }]);
    vi.mocked(fetchClassAncestors).mockResolvedValueOnce({
      ancestors: new Map(),
      failed: ["Q7889"],
    });
    await expect(syncClassAncestors()).rejects.toThrow(/failed for all 1 classes/);
    expect(await rows()).toEqual(["Q7889>Q7889"]);
  });
});
