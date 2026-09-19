// Cookie-backed server-side sessions. The cookie carries an opaque random
// token; the `sessions` row is keyed on its SHA-256. `sessionMiddleware`
// resolves the cookie to a user on every /api request and exposes it as
// `c.get("user")`; `requireUser` / `requireAdmin` gate individual routes.
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq, lt } from "drizzle-orm";
import { db } from "../db.ts";
import { sessions, users } from "../../db/schema.ts";
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

/** Remove every session past its absolute expiry. Returns the count. */
export async function pruneExpiredSessions(now = new Date()): Promise<number> {
  const [result] = await db.delete(sessions).where(lt(sessions.expiresAt, toSqlDatetime(now)));
  return result.affectedRows;
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
      // Stale cookie: drop the row (if any) so it can't be revived, clear the cookie.
      await destroySession(c, id);
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

function isAdminId(id: number): boolean {
  return parseAdminIds(process.env.ADMIN_USERS).has(id);
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
