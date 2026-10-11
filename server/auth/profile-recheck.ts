// Nightly re-check of every logged-in account against the OAuth profile
// endpoint, so a block placed on Wikidata after login ends the app session
// without waiting for the user to attempt an edit. Login refuses blocked
// profiles and a rejected edit marks the block, so this is the backstop for
// accounts that only browse and dismiss.
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { sessions, users } from "../../db/schema.ts";
import { authConfig } from "./config.ts";
import { fetchProfile } from "./oauth.ts";
import { markBlocked } from "./session.ts";
import { getAccessToken, TokenError } from "./tokens.ts";

/** Pause between profile requests; a handful of users, no need to hurry. */
const PACE_MS = 250;

export interface RecheckResult {
  checked: number;
  blocked: number;
  /** Accounts whose token no longer works (grant revoked); left as they are. */
  skipped: number;
}

/**
 * Fetch the profile of every user with a live session and lock out the ones
 * Wikidata now reports as blocked. A profile that can't be fetched (grant
 * revoked, provider down) changes nothing: the user keeps their session and
 * is re-checked tomorrow.
 */
export async function recheckLoggedInUsers(
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<RecheckResult> {
  const cfg = authConfig();
  const rows = await db
    .selectDistinct({ id: users.id, username: users.username })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId));
  const result: RecheckResult = { checked: 0, blocked: 0, skipped: 0 };
  for (const [i, row] of rows.entries()) {
    if (i > 0) await sleep(PACE_MS);
    let blocked: boolean;
    try {
      const profile = await fetchProfile(cfg, await getAccessToken(row.id));
      blocked = Boolean(profile.blocked);
      // Keep the rest of the snapshot current while we have it.
      await db
        .update(users)
        .set({ username: profile.username, groups: profile.groups ?? [] })
        .where(eq(users.id, row.id));
    } catch (err) {
      const why = err instanceof TokenError ? err.code : err instanceof Error ? err.message : err;
      console.warn(`profile-recheck: skipped ${row.id} (${row.username}): ${String(why)}`);
      result.skipped += 1;
      continue;
    }
    result.checked += 1;
    if (blocked) {
      console.warn(`profile-recheck: ${row.id} (${row.username}) is blocked; ending sessions`);
      await markBlocked(row.id);
      result.blocked += 1;
    }
  }
  return result;
}
