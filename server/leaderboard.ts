// Router for /api/leaderboard — who has resolved the most pairs through the
// app, counted from the `wikidata_edits` audit table rather than
// `merge_candidates.resolved_by`: a merge also settles every other open pair
// that referenced the merged-away item, under the same user, and those were
// never reviewed. Public, like the candidates themselves: every counted edit
// is already public on Wikidata under the user's name.
import { Hono } from "hono";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "./db.ts";
import type { AuthEnv } from "./auth/session.ts";
import { users, wikidataEdits } from "../db/schema.ts";
import type { LeaderboardPeriod, LeaderboardResponse } from "../src/lib/api-types.ts";

export const leaderboard = new Hono<AuthEnv>();

/** Most users listed. */
const LIMIT = 100;

// GET /api/leaderboard?period=all|30d — users by pairs resolved: successful
// merges plus pairs marked "different from", weighted equally (one pair may
// take two edits, so those count distinct candidates). Ties go to more merges.
leaderboard.get("/", async (c) => {
  const period: LeaderboardPeriod = c.req.query("period") === "30d" ? "30d" : "all";
  const merges = sql<number>`cast(sum(${wikidataEdits.action} = 'merge') as signed)`;
  const differentFrom = sql<number>`count(distinct case when ${wikidataEdits.action} = 'different-from' then ${wikidataEdits.candidateId} end)`;
  const total = sql<number>`${merges} + ${differentFrom}`;
  const rows = await db
    .select({ userId: users.id, username: users.username, merges, differentFrom })
    .from(wikidataEdits)
    .innerJoin(users, eq(users.id, wikidataEdits.userId))
    .where(
      and(
        eq(wikidataEdits.ok, true),
        period === "30d" ? gte(wikidataEdits.createdAt, sql`now() - interval 30 day`) : undefined,
      ),
    )
    .groupBy(users.id, users.username)
    .orderBy(desc(total), desc(merges), users.username)
    .limit(LIMIT);
  const payload: LeaderboardResponse = {
    period,
    entries: rows.map((r) => ({
      ...r,
      merges: Number(r.merges),
      differentFrom: Number(r.differentFrom),
      total: Number(r.merges) + Number(r.differentFrom),
    })),
  };
  return c.json(payload);
});
