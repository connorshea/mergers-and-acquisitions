// Cookie-backed server-side sessions. The cookie carries an opaque random
// token; the `sessions` row is keyed on its SHA-256. `sessionMiddleware`
// resolves the cookie to a user on every /api request and exposes it as
// `c.get("user")`; `requireUser` / `requireAdmin` gate individual routes.
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, lt, notExists } from "drizzle-orm";
import { db } from "../db.ts";
import { oauthTokens, sessions, users } from "../../db/schema.ts";
import { cookiesSecure, parseAdminIds } from "./config.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { addSeconds, fromSqlDatetime, toSqlDatetime } from "./time.ts";

export const SESSION_COOKIE = "mna_session";
/** Absolute session lifetime. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A session unused for this long is dead even if its absolute lifetime remains. */
export const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;
/** Don't rewrite `last_seen_at` more often than this. */
const TOUCH_INTERVAL_SECONDS = 5 * 60;

export interface AuthUser {
  id: number;
  username: string;
  isAdmin: boolean;
  blocked: boolean;
}

export type AuthVariables = { user: AuthUser | null; sessionId: string | null };
/** Hono env for routers that read the session: `new Hono<AuthEnv>()`. */
export type AuthEnv = { Variables: AuthVariables };

function cookieOptions() {
  return {
    httpOnly: true,
    secure: cookiesSecure(),
    sameSite: "Lax" as const,
    path: "/",
  };
}

/** Insert a session for `userId` and set its cookie. Returns the row id (hash). */
export async function createSession(c: Context, userId: number, now = new Date()): Promise<string> {
  const token = randomToken(32);
  const id = sha256Hex(token);
  const stamp = toSqlDatetime(now);
  await db.insert(sessions).values({
    id,
    userId,
    createdAt: stamp,
    lastSeenAt: stamp,
    expiresAt: toSqlDatetime(addSeconds(now, SESSION_TTL_SECONDS)),
  });
  setCookie(c, SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_SECONDS });
  return id;
}

/** Delete a session row (by hash) and clear the cookie. */
export async function destroySession(c: Context, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
  deleteCookie(c, SESSION_COOKIE, cookieOptions());
}

/**
 * Once a user has no session left anywhere, don't keep their OAuth tokens
 * around: the refresh token is long-lived and only useful to an attacker who
 * gets hold of the database. Every path that ends a session goes through this
 * (logout, a stale cookie, the prune job) so tokens can't outlive the login.
 */
export async function deleteTokensIfLoggedOut(userId: number): Promise<void> {
  await db
    .delete(oauthTokens)
    .where(
      and(
        eq(oauthTokens.userId, userId),
        notExists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))),
      ),
    );
}

/**
 * Remove every session past its absolute expiry, then every OAuth token row
 * whose user has no session left (which also catches sessions that idled out
 * without their cookie ever coming back). Returns the counts.
 */
export async function pruneExpiredSessions(
  now = new Date(),
): Promise<{ sessions: number; tokens: number }> {
  const [pruned] = await db.delete(sessions).where(lt(sessions.expiresAt, toSqlDatetime(now)));
  const [orphaned] = await db
    .delete(oauthTokens)
    .where(
      notExists(
        db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.userId, oauthTokens.userId)),
      ),
    );
  return { sessions: pruned.affectedRows, tokens: orphaned.affectedRows };
}

/**
 * Resolve the session cookie (if any) to a user. Never rejects a request on
 * its own: a missing, expired, or unknown session just yields `user: null`
 * (and clears the stale cookie). Gating is `requireUser` / `requireAdmin`.
 */
export const sessionMiddleware: MiddlewareHandler<AuthEnv> = async (c, next) => {
  c.set("user", null);
  c.set("sessionId", null);

  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const id = sha256Hex(token);
    const now = new Date();
    const [row] = await db
      .select({
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        userId: users.id,
        username: users.username,
        blocked: users.blocked,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, id));

    const alive =
      row &&
      fromSqlDatetime(row.expiresAt) > now &&
      addSeconds(fromSqlDatetime(row.lastSeenAt), SESSION_IDLE_SECONDS) > now;

    if (!alive) {
      // Stale cookie: clear it, and if it named a real (expired) session drop
      // the row so it can't be revived, plus the user's tokens if that was
      // their last one. An unknown id gets no DB write at all.
      if (row) {
        await destroySession(c, id);
        await deleteTokensIfLoggedOut(row.userId);
      } else {
        deleteCookie(c, SESSION_COOKIE, cookieOptions());
      }
    } else {
      if (addSeconds(fromSqlDatetime(row.lastSeenAt), TOUCH_INTERVAL_SECONDS) < now) {
        await db
          .update(sessions)
          .set({ lastSeenAt: toSqlDatetime(now) })
          .where(eq(sessions.id, id));
      }
      c.set("user", {
        id: row.userId,
        username: row.username,
        isAdmin: isAdminId(row.userId),
        blocked: row.blocked,
      });
      c.set("sessionId", id);
    }
  }
  await next();
};

// Parsing ADMIN_USERS is pure over its raw string, so memoize against it: the
// session middleware calls this on every authenticated request, and the env var
// only ever changes between test runs (never mid-process in production).
let adminIdsCache: { raw: string | undefined; ids: Set<number> } | undefined;

function isAdminId(id: number): boolean {
  const raw = process.env.ADMIN_USERS;
  if (!adminIdsCache || adminIdsCache.raw !== raw) {
    adminIdsCache = { raw, ids: parseAdminIds(raw) };
  }
  return adminIdsCache.ids.has(id);
}

/** 401 unless a user is logged in. */
export const requireUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "Login required" }, 401);
  await next();
};

/** 401 when logged out, 403 unless the user is in ADMIN_USERS. */
export const requireAdmin: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Login required" }, 401);
  if (!user.isAdmin) return c.json({ error: "Admin access required" }, 403);
  await next();
};
