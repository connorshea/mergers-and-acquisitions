// Tests for the one-off snapshot backfill (server/snapshot-backfill.ts): the
// pre-merge revision pick, and the backfill against a real MariaDB with a fake
// Wikidata. The DB part is opt-in via DB_TEST=1 — see test/global-setup.ts.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { asc } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { mergeCandidates } from "../db/schema.ts";
import { preMergeRevid, runSnapshotBackfill } from "./snapshot-backfill.ts";
import { DB_TEST, insertItem, makeItem, truncateAll } from "../test/db-helpers.ts";

// Q137642501's real history, newest first, merged by the app into Q112944957.
const MERGED_HISTORY = [
  { revid: 5, comment: "/* wbcreateredirect:0||Q137642501|Q112944957 */" },
  { revid: 4, comment: "/* wbeditentity-override:0| */ Clearing item to prepare for redirect" },
  { revid: 3, comment: "/* wbmergeitems-to:0||Q112944957 */" },
  { revid: 2, comment: "/* wbsetlabel-add:1|mul */ La Partida" },
  { revid: 1, comment: "/* wbeditentity-create-item:0| */" },
];

describe("preMergeRevid", () => {
  it("takes the revision before the merge, clear and redirect", () => {
    expect(preMergeRevid(MERGED_HISTORY)).toBe(2);
    // wbmergeitems redirects by itself when the merge empties the item.
    expect(preMergeRevid([MERGED_HISTORY[0], ...MERGED_HISTORY.slice(2)])).toBe(2);
  });

  it("is null for an item that isn't a redirect, or has nothing before the merge", () => {
    expect(preMergeRevid(MERGED_HISTORY.slice(1))).toBeNull();
    expect(preMergeRevid(MERGED_HISTORY.slice(0, 3))).toBeNull();
    expect(preMergeRevid([])).toBeNull();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

/** A fake Wikidata: `histories` per qid for the API, `entities` per revid for EntityData. */
function fakeWikidata(
  histories: Record<string, { revid: number; comment: string }[]>,
  entities: Record<number, object>,
): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    urls.push(url.pathname + url.search);
    if (url.pathname === "/w/api.php") {
      const title = url.searchParams.get("titles")!;
      const revisions = histories[title];
      return jsonResponse({
        query: { pages: [revisions ? { title, revisions } : { title, missing: true }] },
      });
    }
    const qid = url.pathname.match(/(Q\d+)\.json$/)![1];
    const entity = entities[Number(url.searchParams.get("revision"))];
    return entity
      ? jsonResponse({ entities: { [qid]: entity } })
      : new Response("not found", { status: 404 });
  }) as typeof fetch & { urls: string[] };
  impl.urls = urls;
  return impl;
}

describe.skipIf(!DB_TEST)("snapshot backfill", () => {
  beforeEach(truncateAll);
  afterAll(() => pool.end());

  async function candidate(values: {
    fromQid: string;
    intoQid: string;
    status: string;
    resolution: string | null;
  }): Promise<void> {
    await db.insert(mergeCandidates).values({ ...values, confidence: 0.9, reasons: [] });
  }

  it("rebuilds merged-away items from their pre-merge revision", async () => {
    await insertItem(makeItem("Q1", "Kept Game"));
    await insertItem(makeItem("Q7", "Other Game"));
    // Q2 was merged into Q1 on Wikidata; it's in two settled pairs.
    await candidate({
      fromQid: "Q2",
      intoQid: "Q1",
      status: "merged",
      resolution: "Q2 merged into Q1 on Wikidata outside the app",
    });
    await candidate({
      fromQid: "Q7",
      intoQid: "Q2",
      status: "merged",
      resolution: "Q2 merged into Q1 elsewhere",
    });
    // Q5 was deleted: no history to read.
    await candidate({
      fromQid: "Q7",
      intoQid: "Q5",
      status: "merged",
      resolution: "Q5 merged into Q9 elsewhere",
    });
    // Not ours to touch: open, a different resolution, or already snapshotted.
    await candidate({ fromQid: "Q1", intoQid: "Q7", status: "open", resolution: null });
    await candidate({
      fromQid: "Q7",
      intoQid: "Q1",
      status: "dismissed",
      resolution: "marked as different from (P1889)",
    });

    const api = fakeWikidata(
      { Q2: MERGED_HISTORY.map((r) => ({ ...r, revid: r.revid + 100 })) },
      {
        102: {
          id: "Q2",
          labels: { mul: { language: "mul", value: "La Partida" } },
          claims: {},
        },
      },
    );
    expect(await runSnapshotBackfill({ fetch: api, pauseMs: 0 })).toEqual({
      candidates: 3,
      filled: 2,
      skipped: 1,
    });
    // Q2's history and revision are each read once, though it's in two pairs.
    expect(api.urls.filter((u) => u.includes("Q2"))).toHaveLength(2);

    const rows = await db
      .select({ snapshot: mergeCandidates.snapshot })
      .from(mergeCandidates)
      .orderBy(asc(mergeCandidates.id));
    expect(rows.map((r) => r.snapshot && [r.snapshot.from.id, r.snapshot.into.id])).toEqual([
      ["Q2", "Q1"],
      ["Q7", "Q2"],
      null,
      null,
      null,
    ]);
    expect(rows[0].snapshot?.from.labels).toEqual({ mul: "La Partida" });
    expect(rows[0].snapshot?.into.labels.en).toBe("Kept Game");

    // A re-run only retries the pair still without one.
    expect(await runSnapshotBackfill({ fetch: api, pauseMs: 0 })).toEqual({
      candidates: 1,
      filled: 0,
      skipped: 1,
    });
  });

  it("writes nothing on a dry run", async () => {
    await insertItem(makeItem("Q1", "Kept Game"));
    await candidate({
      fromQid: "Q2",
      intoQid: "Q1",
      status: "merged",
      resolution: "Q2 merged into Q1 on Wikidata outside the app",
    });
    const api = fakeWikidata(
      { Q2: MERGED_HISTORY },
      { 2: { id: "Q2", labels: { en: { language: "en", value: "Old" } }, claims: {} } },
    );
    expect(await runSnapshotBackfill({ fetch: api, pauseMs: 0, dryRun: true })).toMatchObject({
      filled: 1,
    });
    const [row] = await db.select({ snapshot: mergeCandidates.snapshot }).from(mergeCandidates);
    expect(row.snapshot).toBeNull();
  });
});
