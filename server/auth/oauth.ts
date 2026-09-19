// The Wikimedia OAuth 2.0 login flow (authorization code + PKCE, confidential
// client) and the session endpoints:
//
//   GET  /api/auth/login?returnTo=/path  → redirect to meta.wikimedia.org
//   GET  /api/auth/callback?code&state   → exchange, upsert user, start session
//   POST /api/auth/logout
//   GET  /api/auth/me
//
// The pending login (state + PKCE verifier + return path) lives in a signed,
// 10-minute, HttpOnly cookie scoped to /api/auth, so there is no state table.
// SameSite=Lax cookies are sent on the top-level GET redirect back from meta,
// which is exactly the callback request.
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { sessions, users } from "../../db/schema.ts";
import type { AuthMeResponse, LogoutResponse } from "../../src/lib/api-types.ts";
import { authConfig, authConfigured, callbackUrl, cookiesSecure } from "./config.ts";
import { pkceChallenge, randomToken, safeEqual } from "./crypto.ts";
import { type AuthEnv, createSession, deleteTokensIfLoggedOut, destroySession } from "./session.ts";
import { toSqlDatetime } from "./time.ts";
import { FETCH_TIMEOUT_MS, storeTokens, tokenRequest, type TokenResponse } from "./tokens.ts";
import { userAgent } from "./user-agent.ts";

const LOGIN_COOKIE = "mna_oauth";
const LOGIN_TTL_SECONDS = 10 * 60;

interface PendingLogin {
  state: string;
  verifier: string;
  returnTo: string;
  /** Epoch ms when the login started; belt-and-braces with the cookie's maxAge. */
  startedAt: number;
}

/** What meta.wikimedia.org's `oauth2/resource/profile` returns (identification grant). */
export interface WikimediaProfile {
  sub: number;
  username: string;
  editcount?: number;
  confirmed_email?: boolean;
  blocked?: boolean;
  registered?: string;
  groups?: string[];
  rights?: string[];
  grants?: string[];
}

function loginCookieOptions() {
  return {
    httpOnly: true,
    secure: cookiesSecure(),
    sameSite: "Lax" as const,
    path: "/api/auth",
    maxAge: LOGIN_TTL_SECONDS,
  };
}

/**
 * Longest `returnTo` we'll carry through the login. It rides in the signed
 * login cookie alongside the state and PKCE verifier, and browsers silently
 * drop cookies over ~4096 bytes (which would make the callback fail with
 * "cookie missing"), so anything longer falls back to the home page.
 */
export const MAX_RETURN_TO_LENGTH = 1024;

/**
 * Only ever send the user back to a path on this site. Anything with a scheme,
 * a host, or a protocol-relative `//` prefix is an open-redirect vector, and any
 * control character (notably CR/LF) would poison the `Location` header on the
 * eventual redirect — Node rejects such a header with ERR_INVALID_CHAR (a 500).
 * Over-long values fall back to `/` rather than overflowing the login cookie.
 */
export function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (raw.length > MAX_RETURN_TO_LENGTH) return "/";
  // eslint-disable-next-line no-control-regex -- deliberately matching control chars
  if (/[\u0000-\u001f\u007f]/.test(raw)) return "/";
  return raw;
}

export const authRoutes = new Hono<AuthEnv>();

authRoutes.get("/login", async (c) => {
  if (!authConfigured()) {
    return c.json({ error: "OAuth login is not configured on this server" }, 503);
  }
  const cfg = authConfig();
  const pending: PendingLogin = {
    state: randomToken(32),
    verifier: randomToken(48),
    returnTo: safeReturnTo(c.req.query("returnTo")),
    startedAt: Date.now(),
  };
  await setSignedCookie(
    c,
    LOGIN_COOKIE,
    JSON.stringify(pending),
    cfg.sessionSecret,
    loginCookieOptions(),
  );

  const url = new URL(`${cfg.issuer}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("state", pending.state);
  url.searchParams.set("code_challenge", pkceChallenge(pending.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  c.header("Cache-Control", "no-store");
  return c.redirect(url.toString(), 302);
});

authRoutes.get("/callback", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!authConfigured()) {
    return c.json({ error: "OAuth login is not configured on this server" }, 503);
  }
  const cfg = authConfig();

  // The pending-login cookie is single-use whatever happens next.
  const raw = await getSignedCookie(c, cfg.sessionSecret, LOGIN_COOKIE);
  deleteCookie(c, LOGIN_COOKIE, loginCookieOptions());
  const pending = parsePending(raw);
  if (!pending || Date.now() - pending.startedAt > LOGIN_TTL_SECONDS * 1000) {
    return c.json({ error: "Login attempt expired or its cookie is missing; start again" }, 400);
  }

  // The user declined on meta, or meta reported a problem.
  const providerError = c.req.query("error");
  if (providerError) {
    console.warn(`oauth: provider returned error=${providerError}`);
    return c.redirect(`/?auth=${providerError === "access_denied" ? "denied" : "failed"}`, 303);
  }

  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  if (!code || !safeEqual(state, pending.state)) {
    return c.json({ error: "OAuth state mismatch" }, 400);
  }

  let tokens: TokenResponse;
  let profile: WikimediaProfile;
  try {
    tokens = await exchangeCode(cfg, code, pending.verifier);
    profile = await fetchProfile(cfg, tokens.access_token);
  } catch (err) {
    console.error("oauth: callback failed", err);
    return c.redirect("/?auth=failed", 303);
  }

  const now = new Date();
  const userValues = {
    username: profile.username,
    groups: profile.groups ?? [],
    blocked: Boolean(profile.blocked),
    lastLoginAt: toSqlDatetime(now),
  };
  await db
    .insert(users)
    .values({ id: profile.sub, createdAt: toSqlDatetime(now), ...userValues })
    .onDuplicateKeyUpdate({ set: userValues });
  await storeTokens(profile.sub, tokens, now);

  // Rotate: a session that was already active in this browser is replaced.
  const previous = c.get("sessionId");
  if (previous) await db.delete(sessions).where(eq(sessions.id, previous));
  await createSession(c, profile.sub, now);

  return c.redirect(pending.returnTo, 303);
});

authRoutes.post("/logout", async (c) => {
  const user = c.get("user");
  const sessionId = c.get("sessionId");
  if (user && sessionId) {
    await destroySession(c, sessionId);
    await deleteTokensIfLoggedOut(user.id);
  }
  const payload: LogoutResponse = { ok: true };
  return c.json(payload);
});

authRoutes.get("/me", (c) => {
  c.header("Cache-Control", "no-store");
  const payload: AuthMeResponse = { user: c.get("user"), configured: authConfigured() };
  return c.json(payload);
});

function parsePending(raw: string | false | undefined): PendingLogin | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingLogin>;
    if (
      typeof value.state === "string" &&
      typeof value.verifier === "string" &&
      typeof value.returnTo === "string" &&
      typeof value.startedAt === "number"
    ) {
      return value as PendingLogin;
    }
  } catch {
    // fall through
  }
  return null;
}

async function exchangeCode(
  cfg: ReturnType<typeof authConfig>,
  code: string,
  verifier: string,
): Promise<TokenResponse> {
  const result = await tokenRequest(cfg, {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
    code_verifier: verifier,
  });
  if (!result.ok) throw new Error(`token exchange failed: ${result.error}`);
  return result.tokens;
}

async function fetchProfile(
  cfg: ReturnType<typeof authConfig>,
  accessToken: string,
): Promise<WikimediaProfile> {
  const res = await fetch(`${cfg.issuer}/resource/profile`, {
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": userAgent() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`profile fetch failed: HTTP ${res.status}`);
  const profile = (await res.json()) as Partial<WikimediaProfile>;
  if (typeof profile.sub !== "number" || typeof profile.username !== "string") {
    throw new Error("profile response is missing sub/username");
  }
  return profile as WikimediaProfile;
}
