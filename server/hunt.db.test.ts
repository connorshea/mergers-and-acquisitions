// Integration tests for the hunt (server/hunt.ts) against a real MariaDB:
// blocking, scoring, and the upsert rules. Opt-in via DB_TEST=1 — see
// test/global-setup.ts.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { db, pool } from "./db.ts";
import { mergeCandidates, properties } from "../db/schema.ts";
import { MIN_CONFIDENCE, runHunt } from "./hunt.ts";
import type { Value } from "../src/lib/compare.ts";
import { DB_TEST, insertItem, makeItem, truncateAll } from "../test/db-helpers.ts";

const steam = (value: string): Record<string, Value[]> => ({
  P1733: [{ type: "external-id", value }],
});
const allCandidates = () => db.select().from(mergeCandidates);

describe.skipIf(!DB_TEST)("runHunt", () => {
  beforeEach(truncateAll);
  afterAll(() => pool.end());

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
    expect(stats).toEqual({ pairs: 1, scored: 1, upserted: 1, deleted: 0, failed: 0 });

    const rows = await allCandidates();
    expect(rows).toHaveLength(1);
    // Higher QID is merged into the lower one.
    expect(rows[0]).toMatchObject({
      fromQid: "Q200",
      intoQid: "Q100",
      status: "open",
      hasBlocker: false,
    });
    expect(rows[0].confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(rows[0].reasons.some((r) => r.startsWith("shares external identifier"))).toBe(true);
  });

  it("is idempotent across runs", async () => {
    await insertItem(makeItem("Q100", "Starfall Drift", steam("812340")));
    await insertItem(makeItem("Q200", "Starfall Drift", steam("812340")));
    await runHunt();
    const [first] = await allCandidates();
    await runHunt();
    const rows = await allCandidates();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
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
});
