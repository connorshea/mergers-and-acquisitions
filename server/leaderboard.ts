// Router for /api/leaderboard — who has resolved the most pairs through the
// app. Merges and pairs marked "different from" are counted from the
// `wikidata_edits` audit table rather than `merge_candidates.resolved_by`: a
// merge also settles every other open pair that referenced the merged-away
// item, under the same user, and those were never reviewed. Plain dismissals
// never reach Wikidata, so they come from `merge_candidates` itself. Public,
// like the candidates themselves: every counted edit is already public on
// Wikidata under the user's name, and each dismissal on the pair's own page.
import { Hono } from "hono";
import { and, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/mysql-core";
import { db } from "./db.ts";
import type { AuthEnv } from "./auth/session.ts";
import { mergeCandidates, users, wikidataEdits } from "../db/schema.ts";
import type { LeaderboardPeriod, LeaderboardResponse } from "../src/lib/api-types.ts";

export const leaderboard = new Hono<AuthEnv>();

/** Most users listed. */
const LIMIT = 100;

// GET /api/leaderboard?period=all|30d — users by pairs resolved: successful
// merges, pairs marked "different from", and pairs dismissed, weighted
// equally (one "different from" pair may take two edits, so those count
// distinct candidates). Ties go to more merges.
leaderboard.get("/", async (c) => {
  const period: LeaderboardPeriod = c.req.query("period") === "30d" ? "30d" : "all";
  const since = (column: typeof wikidataEdits.createdAt | typeof mergeCandidates.resolvedAt) =>
    period === "30d" ? gte(column, sql`now() - interval 30 day`) : undefined;

  // Per-user counts from each source, then summed per user.
  const fromEdits = db
    .select({
      userId: wikidataEdits.userId,
      merges: sql<number>`cast(sum(${wikidataEdits.action} = 'merge') as signed)`.as("merges"),
      differentFrom:
        sql<number>`count(distinct case when ${wikidataEdits.action} = 'different-from' then ${wikidataEdits.candidateId} end)`.as(
          "different_from",
        ),
      dismissals: sql<number>`0`.as("dismissals"),
    })
    .from(wikidataEdits)
    .where(and(eq(wikidataEdits.ok, true), since(wikidataEdits.createdAt)))
    .groupBy(wikidataEdits.userId);
  // A plain dismissal is the only way a user leaves a pair `dismissed` with
  // no resolution note: "different from" sets one (and is counted above), and
  // the dump import and outside-merge detection set one with no user. That
  // also keeps a user from claiming a pair those had already settled by
  // dismissing it again. Reopening clears `resolved_by`, so it stops counting;
  // dismissing again restamps it, so it counts once.
  const fromDismissals = db
    .select({
      userId: sql<number>`${mergeCandidates.resolvedBy}`.as("user_id"),
      merges: sql<number>`0`.as("merges"),
      differentFrom: sql<number>`0`.as("different_from"),
      dismissals: sql<number>`count(*)`.as("dismissals"),
    })
    .from(mergeCandidates)
    .where(
      and(
        eq(mergeCandidates.status, "dismissed"),
        isNotNull(mergeCandidates.resolvedBy),
        isNull(mergeCandidates.resolution),
        since(mergeCandidates.resolvedAt),
      ),
    )
    .groupBy(mergeCandidates.resolvedBy);
  const perUser = unionAll(fromEdits, fromDismissals).as("per_user");

  const merges = sql<number>`cast(sum(${perUser.merges}) as signed)`;
  const differentFrom = sql<number>`cast(sum(${perUser.differentFrom}) as signed)`;
  const dismissals = sql<number>`cast(sum(${perUser.dismissals}) as signed)`;
  const [rows, [totals]] = await Promise.all([
    db
      .select({ userId: users.id, username: users.username, merges, differentFrom, dismissals })
      .from(perUser)
      .innerJoin(users, eq(users.id, perUser.userId))
      .groupBy(users.id, users.username)
      .orderBy(
        desc(sql`${merges} + ${differentFrom} + ${dismissals}`),
        desc(merges),
        users.username,
      )
      .limit(LIMIT),
    // Across every user, not just the listed ones. Pairs marked different are
    // counted per user, as in the rows, so the column adds up.
    db
      .select({
        users: sql<number>`count(distinct ${perUser.userId})`,
        merges,
        differentFrom,
        dismissals,
      })
      .from(perUser),
  ]);
  const counts = (r: {
    merges: number | null;
    differentFrom: number | null;
    dismissals: number | null;
  }) => {
    // sum() over no rows is NULL.
    const merges = Number(r.merges ?? 0);
    const differentFrom = Number(r.differentFrom ?? 0);
    const dismissals = Number(r.dismissals ?? 0);
    return { merges, differentFrom, dismissals, total: merges + differentFrom + dismissals };
  };
  const payload: LeaderboardResponse = {
    period,
    entries: rows.map((r) => ({ userId: r.userId, username: r.username, ...counts(r) })),
    totals: { users: Number(totals.users), ...counts(totals) },
  };
  return c.json(payload);
});
