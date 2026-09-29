// Integration tests for GET /api/leaderboard against a real MariaDB. Opt-in via
// DB_TEST=1 — see test/global-setup.ts.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { app } from "./app.ts";
import { db, pool } from "./db.ts";
import { mergeCandidates, users, wikidataEdits } from "../db/schema.ts";
import type { LeaderboardResponse } from "../src/lib/api-types.ts";
import { toSqlDatetime } from "./auth/time.ts";
import { DB_TEST, truncateAll } from "../test/db-helpers.ts";

async function leaderboard(query = ""): Promise<LeaderboardResponse> {
  const res = await app.request(`/api/leaderboard${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as LeaderboardResponse;
}

type Edit = typeof wikidataEdits.$inferInsert;
const edit = (userId: number, candidateId: number, over: Partial<Edit> = {}): Edit => ({
  userId,
  candidateId,
  action: "merge",
  fromQid: `Q${candidateId * 2}`,
  intoQid: `Q${candidateId * 2 + 1}`,
  ok: true,
  ...over,
});

type Candidate = typeof mergeCandidates.$inferInsert;
const dismissed = (
  id: number,
  resolvedBy: number | null,
  over: Partial<Candidate> = {},
): Candidate => ({
  id,
  fromQid: `Q${id * 2 + 1}`,
  intoQid: `Q${id * 2}`,
  confidence: 0.5,
  reasons: [],
  status: "dismissed",
  resolvedAt: "2026-01-01 00:00:00",
  resolvedBy,
  ...over,
});

describe.skipIf(!DB_TEST)("GET /api/leaderboard", () => {
  beforeEach(async () => {
    await truncateAll();
    await db.insert(users).values([
      { id: 1, username: "Alice", groups: ["user"] },
      { id: 2, username: "Bob", groups: ["user"] },
      { id: 3, username: "Carol", groups: ["user"] },
    ]);
  });

  afterAll(() => pool.end());

  it("ranks users by merges plus pairs marked different, from successful edits only", async () => {
    await db.insert(wikidataEdits).values([
      edit(1, 1),
      edit(1, 2),
      edit(1, 3, { ok: false, errorCode: "failed-save" }),
      edit(2, 4),
      edit(2, 5),
      // One "different from" pair is up to two edits, one per item: one pair.
      edit(2, 6, { action: "different-from" }),
      edit(2, 6, { action: "different-from", fromQid: "Q13", intoQid: "Q12" }),
      edit(3, 7, { action: "different-from", ok: false }),
      // Weighted equally, three "different from" pairs outrank Alice's two
      // merges and tie Bob's total of three, where more merges wins.
      edit(3, 8, { action: "different-from" }),
      edit(3, 9, { action: "different-from" }),
      edit(3, 10, { action: "different-from" }),
    ]);
    const { period, entries, totals } = await leaderboard();
    expect(period).toBe("all");
    expect(totals).toEqual({ users: 3, merges: 4, differentFrom: 4, dismissals: 0, total: 8 });
    expect(entries).toEqual([
      { userId: 2, username: "Bob", merges: 2, differentFrom: 1, dismissals: 0, total: 3 },
      { userId: 3, username: "Carol", merges: 0, differentFrom: 3, dismissals: 0, total: 3 },
      { userId: 1, username: "Alice", merges: 2, differentFrom: 0, dismissals: 0, total: 2 },
    ]);
  });

  it("limits to the last 30 days when asked, and treats anything else as all time", async () => {
    await db
      .insert(wikidataEdits)
      .values([
        edit(1, 1, { createdAt: "2020-01-01 00:00:00" }),
        edit(1, 2, { createdAt: "2020-01-01 00:00:00" }),
        edit(2, 3),
      ]);
    expect((await leaderboard("?period=30d")).entries).toEqual([
      { userId: 2, username: "Bob", merges: 1, differentFrom: 0, dismissals: 0, total: 1 },
    ]);
    const all = await leaderboard("?period=bogus");
    expect(all.period).toBe("all");
    expect(all.entries.map((e) => e.username)).toEqual(["Alice", "Bob"]);
    expect(all.totals).toEqual({ users: 2, merges: 3, differentFrom: 0, dismissals: 0, total: 3 });
  });

  it("counts plain dismissals, weighted equally, but not dismissals written by anything else", async () => {
    await db.insert(wikidataEdits).values([edit(1, 1), edit(2, 2, { action: "different-from" })]);
    await db.insert(mergeCandidates).values([
      dismissed(1, 1, { status: "merged" }),
      // Bob's "different from" pair is already counted from its edit.
      dismissed(2, 2, { resolution: "marked as different from (P1889)" }),
      dismissed(3, 2),
      dismissed(4, 2),
      dismissed(5, 3),
      // Settled by the dump import, then dismissed again by Carol: not hers.
      dismissed(6, 3, { resolution: "item no longer in the Wikidata dump" }),
      dismissed(7, null, { resolution: "item no longer in the Wikidata dump" }),
      // Dismissed, then reopened.
      dismissed(8, null, { status: "open", resolvedAt: null }),
    ]);
    const { entries, totals } = await leaderboard();
    expect(entries).toEqual([
      { userId: 2, username: "Bob", merges: 0, differentFrom: 1, dismissals: 2, total: 3 },
      { userId: 1, username: "Alice", merges: 1, differentFrom: 0, dismissals: 0, total: 1 },
      { userId: 3, username: "Carol", merges: 0, differentFrom: 0, dismissals: 1, total: 1 },
    ]);
    expect(totals).toEqual({ users: 3, merges: 1, differentFrom: 1, dismissals: 3, total: 5 });
  });

  it("limits dismissals to the last 30 days by when they were dismissed", async () => {
    await db
      .insert(mergeCandidates)
      .values([dismissed(1, 1), dismissed(2, 1, { resolvedAt: toSqlDatetime(new Date()) })]);
    const recent = await leaderboard("?period=30d");
    expect(recent.entries).toEqual([
      { userId: 1, username: "Alice", merges: 0, differentFrom: 0, dismissals: 1, total: 1 },
    ]);
    expect(recent.totals).toEqual({
      users: 1,
      merges: 0,
      differentFrom: 0,
      dismissals: 1,
      total: 1,
    });
    expect((await leaderboard()).totals.dismissals).toBe(2);
  });

  it("is public", async () => {
    const empty = await leaderboard();
    expect(empty.entries).toEqual([]);
    expect(empty.totals).toEqual({
      users: 0,
      merges: 0,
      differentFrom: 0,
      dismissals: 0,
      total: 0,
    });
  });
});
