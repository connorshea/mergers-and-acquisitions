// Integration tests for the place-ancestor sync (server/place-ancestors.ts)
// against a real MariaDB, with the QLever lookup stubbed. Opt-in via
// DB_TEST=1 — see test/global-setup.ts.
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { db, pool } from "./db.ts";
import { items, placeAncestors } from "../db/schema.ts";
import { collectItemPlaces, loadPlaceAncestors, syncPlaceAncestors } from "./place-ancestors.ts";
import type { Item, Value } from "../src/lib/compare.ts";
import { fetchPlaceAncestors } from "../src/lib/sparql.ts";
import { DB_TEST, truncateAll } from "../test/db-helpers.ts";
import { quietLogs } from "../test/console.ts";

vi.mock("../src/lib/sparql.ts", () => ({
  fetchPlaceAncestors: vi.fn<typeof fetchPlaceAncestors>(),
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

const ref = (value: string): Value => ({ type: "item", value });

const rows = async () =>
  (await db.select().from(placeAncestors))
    .map((r) => `${r.qid}>${r.ancestor}${r.country ? " (country)" : ""}`)
    .sort();

afterAll(() => (DB_TEST ? pool.end() : undefined));

describe.skipIf(!DB_TEST)("collectItemPlaces", () => {
  beforeEach(truncateAll);

  it("collects distinct place values across every page", async () => {
    await db
      .insert(items)
      .values([
        item("Q1", { P159: [ref("Q416131")], P136: [ref("Q100")] }),
        item("Q2", { P19: [ref("Q1490")], P20: [ref("Q1490")] }),
        item("Q3", { P276: [ref("Q16554")], P19: [{ type: "somevalue", value: "" }] }),
        item("Q4", {}),
      ]);
    for (const pageSize of [1, 3, 5000]) {
      expect((await collectItemPlaces(pageSize)).sort()).toEqual(["Q1490", "Q16554", "Q416131"]);
    }
  });
});

describe.skipIf(!DB_TEST)("syncPlaceAncestors", () => {
  beforeEach(truncateAll);
  quietLogs();

  it("replaces looked-up places, drops gone ones, and keeps failed ones", async () => {
    await db
      .insert(items)
      .values([item("Q1", { P159: [ref("Q416131")] }), item("Q2", { P19: [ref("Q16554")] })]);
    await db.insert(placeAncestors).values([
      { qid: "Q416131", ancestor: "Q999" }, // stale
      { qid: "Q16554", ancestor: "Q1261" },
      { qid: "Q35765", ancestor: "Q17", country: true }, // no item names it any more
    ]);
    // The lookup streams: the Q416131 chunk comes back, the Q16554 one fails.
    vi.mocked(fetchPlaceAncestors).mockImplementationOnce(async (_places, opts) => {
      await opts?.onChunk?.(
        ["Q416131"],
        new Map([
          [
            "Q416131",
            [
              { ancestor: "Q1490", country: false },
              { ancestor: "Q17", country: true },
            ],
          ],
        ]),
      );
      return { ancestors: new Map(), failed: ["Q16554"] };
    });
    expect(await syncPlaceAncestors()).toEqual({ places: 1, rows: 2, failed: 1 });
    expect(await rows()).toEqual(["Q16554>Q1261", "Q416131>Q1490", "Q416131>Q17 (country)"]);
    expect((await loadPlaceAncestors(["Q416131", "Q1490"])).length).toBe(2);
  });

  it("throws, writing nothing, when every lookup fails", async () => {
    await db.insert(items).values([item("Q1", { P159: [ref("Q416131")] })]);
    await db.insert(placeAncestors).values([{ qid: "Q416131", ancestor: "Q1490" }]);
    vi.mocked(fetchPlaceAncestors).mockResolvedValueOnce({
      ancestors: new Map(),
      failed: ["Q416131"],
    });
    await expect(syncPlaceAncestors()).rejects.toThrow(/failed for all 1 places/);
    expect(await rows()).toEqual(["Q416131>Q1490"]);
  });
});
