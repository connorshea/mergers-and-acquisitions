// Integration tests for the entity-label sync's QID scan
// (server/entity-labels-sync.ts) against a real MariaDB. Opt-in via DB_TEST=1 —
// see test/global-setup.ts.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { db, pool } from "./db.ts";
import { items } from "../db/schema.ts";
import { collectReferencedItemQids, labelsFromMirror } from "./entity-labels-sync.ts";
import type { Item, Value } from "../src/lib/compare.ts";
import { DB_TEST, truncateAll } from "../test/db-helpers.ts";

function item(
  qid: string,
  statements: Record<string, Value[]>,
  labels: Record<string, string> = { en: qid },
): typeof items.$inferInsert {
  const data: Item = {
    id: qid,
    labels,
    descriptions: {},
    aliases: {},
    sitelinks: {},
    statements,
  };
  return { qid, primaryLabel: qid, data };
}

const ref = (value: string): Value => ({ type: "item", value });

afterAll(() => (DB_TEST ? pool.end() : undefined));

describe.skipIf(!DB_TEST)("collectReferencedItemQids", () => {
  beforeEach(truncateAll);

  it("collects distinct item-valued QIDs across every page", async () => {
    await db
      .insert(items)
      .values([
        item("Q1", { P31: [ref("Q7889")], P136: [ref("Q100"), ref("Q101")] }),
        item("Q2", { P31: [ref("Q7889")], P1476: [{ type: "string", value: "Q999" }] }),
        item("Q3", { P400: [ref("Q102")], P577: [{ type: "time", value: "+2001-01-01" }] }),
        item("Q4", {}),
        item("Q5", { P400: [ref("Q102")], P178: [{ type: "somevalue", value: "" }, ref("Q103")] }),
      ]);
    const expected = ["Q100", "Q101", "Q102", "Q103", "Q7889"];
    // A page size that divides the row count, one that doesn't, and one page.
    for (const pageSize of [1, 2, 5, 5000]) {
      expect((await collectReferencedItemQids(pageSize)).sort()).toEqual(expected);
    }
  });

  it("returns nothing for an empty mirror", async () => {
    expect(await collectReferencedItemQids(2)).toEqual([]);
  });
});

describe.skipIf(!DB_TEST)("labelsFromMirror", () => {
  beforeEach(truncateAll);

  it("takes en, else mul, labels of mirrored items and leaves the rest to look up", async () => {
    await db
      .insert(items)
      .values([
        item("Q10", {}, { en: "English", mul: "Mul", fr: "Français" }),
        item("Q11", {}, { mul: "Mul only", de: "Deutsch" }),
        item("Q12", {}, { en: "", mul: "Empty en" }),
        item("Q13", {}, { de: "Nur Deutsch" }),
      ]);
    const result = await labelsFromMirror(["Q10", "Q11", "Q12", "Q13", "Q20", "Q21"]);
    expect(result.rows.sort((a, b) => a.qid.localeCompare(b.qid))).toEqual([
      { qid: "Q10", label: "English" },
      { qid: "Q11", label: "Mul only" },
      { qid: "Q12", label: "Empty en" },
    ]);
    expect(result.unlabeled).toBe(1);
    expect(result.missing).toEqual(["Q20", "Q21"]);
  });

  it("handles no QIDs", async () => {
    expect(await labelsFromMirror([])).toEqual({ rows: [], unlabeled: 0, missing: [] });
  });
});
