// Integration tests for GET /api/leaderboard against a real MariaDB. Opt-in via
// DB_TEST=1 — see test/global-setup.ts.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { app } from "./app.ts";
import { db, pool } from "./db.ts";
import { users, wikidataEdits } from "../db/schema.ts";
import type { LeaderboardResponse } from "../src/lib/api-types.ts";
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
    const { period, entries } = await leaderboard();
    expect(period).toBe("all");
    expect(entries).toEqual([
      { userId: 2, username: "Bob", merges: 2, differentFrom: 1, total: 3 },
      { userId: 3, username: "Carol", merges: 0, differentFrom: 3, total: 3 },
      { userId: 1, username: "Alice", merges: 2, differentFrom: 0, total: 2 },
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
      { userId: 2, username: "Bob", merges: 1, differentFrom: 0, total: 1 },
    ]);
    const all = await leaderboard("?period=bogus");
    expect(all.period).toBe("all");
    expect(all.entries.map((e) => e.username)).toEqual(["Alice", "Bob"]);
  });

  it("is public", async () => {
    expect((await leaderboard()).entries).toEqual([]);
  });
});
