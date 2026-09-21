// Integration tests for the OAuth login flow, sessions, and token refresh
// against a real MariaDB, with www.wikidata.org replaced by a stubbed
// `fetch`. Opt-in via DB_TEST=1 — see test/global-setup.ts.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { app } from "../app.ts";
import { db, pool } from "../db.ts";
import { oauthTokens, sessions, users } from "../../db/schema.ts";
import type { AuthMeResponse } from "../../src/lib/api-types.ts";
import { DB_TEST, loginAs, truncateAll } from "../../test/db-helpers.ts";
import { decrypt, randomToken, sha256Hex } from "./crypto.ts";
import { wikiOrigin } from "./config.ts";
import { MAX_RETURN_TO_LENGTH, safeReturnTo } from "./oauth.ts";
import { pruneExpiredSessions, SESSION_COOKIE, SESSION_TTL_SECONDS } from "./session.ts";
import { addSeconds, fromSqlDatetime, toSqlDatetime } from "./time.ts";
import { getAccessToken, storeTokens, TokenError } from "./tokens.ts";

const ISSUER = "https://oauth.test/w/rest.php/oauth2";
const ENV = {
  OAUTH_CLIENT_ID: "client-123",
  OAUTH_CLIENT_SECRET: "shh-client-secret",
  OAUTH_ISSUER: ISSUER,
  BASE_URL: "http://localhost:5173",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef-session",
  TOKEN_ENC_KEY: randomBytes(32).toString("base64"),
  ADMIN_USERS: "42",
};

const PROFILE = {
  sub: 7,
  username: "Alice",
  groups: ["*", "user", "autoconfirmed"],
  blocked: false,
};

/** Parse `name=value` out of a Set-Cookie header list. */
function cookieValue(res: Response, name: string): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const m = line.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return m[1];
  }
  return undefined;
}

/** The full Set-Cookie line for `name`, to inspect its attributes. */
function cookieLine(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((l) => l.startsWith(`${name}=`));
}

/**
 * Stub `fetch` for the token + profile endpoints. Records each token-endpoint
 * body so tests can assert on the exchange/refresh parameters.
 */
function stubProvider(opts: { tokenStatus?: number; tokenBody?: object; profile?: object } = {}) {
  const tokenCalls: URLSearchParams[] = [];
  const stub = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${ISSUER}/access_token`) {
      // The client sends a URLSearchParams body; its toString() is the form encoding.
      tokenCalls.push(new URLSearchParams(String(init?.body as URLSearchParams | undefined)));
      return Response.json(
        opts.tokenBody ?? {
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          token_type: "Bearer",
        },
        { status: opts.tokenStatus ?? 200 },
      );
    }
    if (url === `${ISSUER}/resource/profile`) {
      return Response.json(opts.profile ?? PROFILE);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", stub);
  return { stub, tokenCalls };
}

/** Run the login redirect and return what the callback needs. */
async function startLogin(returnTo = "/candidates/5") {
  const res = await app.request(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  const loginCookie = cookieValue(res, "mna_oauth")!;
  return { res, location, state: location.searchParams.get("state")!, loginCookie };
}

async function callback(query: string, loginCookie?: string) {
  return app.request(`/api/auth/callback?${query}`, {
    headers: loginCookie ? { Cookie: `mna_oauth=${loginCookie}` } : {},
  });
}

async function me(sessionCookie?: string): Promise<AuthMeResponse> {
  const res = await app.request("/api/auth/me", {
    headers: sessionCookie ? { Cookie: `${SESSION_COOKIE}=${sessionCookie}` } : {},
  });
  expect(res.status).toBe(200);
  return (await res.json()) as AuthMeResponse;
}

describe.skipIf(!DB_TEST)("auth", () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await pool.end();
  });
  beforeEach(truncateAll);
  afterEach(() => vi.unstubAllGlobals());

  describe("GET /api/auth/login", () => {
    it("redirects to the authorize endpoint with PKCE and a signed state cookie", async () => {
      const { location, loginCookie, res } = await startLogin();
      expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`);
      expect(Object.fromEntries(location.searchParams)).toMatchObject({
        response_type: "code",
        client_id: "client-123",
        redirect_uri: "http://localhost:5173/api/auth/callback",
        code_challenge_method: "S256",
      });
      expect(location.searchParams.get("state")).toHaveLength(43);
      expect(location.searchParams.get("code_challenge")).toHaveLength(43);
      expect(loginCookie).toBeTruthy();
      const line = cookieLine(res, "mna_oauth")!;
      expect(line).toMatch(/HttpOnly/);
      expect(line).toMatch(/SameSite=Lax/);
      expect(line).toMatch(/Path=\/api\/auth/);
      expect(line).toMatch(/Max-Age=600/);
      // http BASE_URL → not Secure (dev); the flag flips with https.
      expect(line).not.toMatch(/Secure/);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("marks cookies Secure and uses an https callback when BASE_URL is https", async () => {
      process.env.BASE_URL = "https://mna.toolforge.org";
      try {
        stubProvider();
        const { location, loginCookie, res, state } = await startLogin();
        expect(location.searchParams.get("redirect_uri")).toBe(
          "https://mna.toolforge.org/api/auth/callback",
        );
        expect(cookieLine(res, "mna_oauth")).toMatch(/Secure/);
        const done = await callback(`code=abc&state=${state}`, loginCookie);
        expect(cookieLine(done, SESSION_COOKIE)).toMatch(/Secure/);
      } finally {
        process.env.BASE_URL = ENV.BASE_URL;
      }
    });

    it("503s when the consumer isn't configured", async () => {
      const id = process.env.OAUTH_CLIENT_ID;
      delete process.env.OAUTH_CLIENT_ID;
      try {
        expect((await app.request("/api/auth/login")).status).toBe(503);
      } finally {
        process.env.OAUTH_CLIENT_ID = id;
      }
    });
  });

  describe("GET /api/auth/callback", () => {
    it("logs the user in: exchanges the code, stores encrypted tokens, sets a session", async () => {
      const { tokenCalls } = stubProvider();
      const { state, loginCookie } = await startLogin("/candidates/5");

      const res = await callback(`code=abc&state=${state}`, loginCookie);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/candidates/5");
      expect(res.headers.get("cache-control")).toBe("no-store");

      // The exchange is a confidential-client + PKCE request.
      expect(tokenCalls).toHaveLength(1);
      expect(Object.fromEntries(tokenCalls[0])).toMatchObject({
        grant_type: "authorization_code",
        code: "abc",
        client_id: "client-123",
        client_secret: "shh-client-secret",
        redirect_uri: "http://localhost:5173/api/auth/callback",
      });
      expect(tokenCalls[0].get("code_verifier")).toHaveLength(64);

      // The login cookie is consumed, the session cookie is set.
      expect(cookieLine(res, "mna_oauth")).toMatch(/Max-Age=0/);
      const session = cookieValue(res, SESSION_COOKIE)!;
      expect(session).toHaveLength(43);
      const line = cookieLine(res, SESSION_COOKIE)!;
      expect(line).toMatch(/HttpOnly/);
      expect(line).toMatch(/SameSite=Lax/);
      expect(line).toMatch(/Path=\//);
      expect(line).toMatch(new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));

      // User upserted from the profile; tokens stored encrypted, not in the clear.
      const [user] = await db.select().from(users).where(eq(users.id, 7));
      expect(user).toMatchObject({ username: "Alice", groups: PROFILE.groups, blocked: false });
      const [tok] = await db.select().from(oauthTokens).where(eq(oauthTokens.userId, 7));
      expect(tok.accessToken).not.toContain("access-1");
      expect(tok.refreshToken).not.toContain("refresh-1");
      expect(decrypt(tok.accessToken, "oauth_tokens:7")).toBe("access-1");
      expect(decrypt(tok.refreshToken!, "oauth_tokens:7")).toBe("refresh-1");

      // The DB holds only the hash of the cookie, and the cookie resolves to the user.
      const [row] = await db.select().from(sessions);
      expect(row.id).toBe(sha256Hex(session));
      expect(row.userId).toBe(7);
      expect(await me(session)).toEqual({
        user: { id: 7, username: "Alice", isAdmin: false, blocked: false },
        configured: true,
        wikiBaseUrl: wikiOrigin(),
      });
    });

    it("rejects a state that doesn't match the login cookie", async () => {
      stubProvider();
      const { loginCookie } = await startLogin();
      const res = await callback(`code=abc&state=${randomToken(32)}`, loginCookie);
      expect(res.status).toBe(400);
      expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined();
      expect(await db.select().from(sessions)).toHaveLength(0);
      expect(await db.select().from(users)).toHaveLength(0);
    });

    it("rejects a login attempt older than ten minutes even if the cookie survived", async () => {
      stubProvider();
      const { state, loginCookie } = await startLogin();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 11 * 60 * 1000);
        const res = await callback(`code=abc&state=${state}`, loginCookie);
        expect(res.status).toBe(400);
        expect(await db.select().from(sessions)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects a callback without a code", async () => {
      stubProvider();
      const { state, loginCookie } = await startLogin();
      expect((await callback(`state=${state}`, loginCookie)).status).toBe(400);
    });

    it("rejects a callback with no login cookie, or a tampered one", async () => {
      stubProvider();
      const { state, loginCookie } = await startLogin();
      expect((await callback(`code=abc&state=${state}`)).status).toBe(400);
      const [value, sig] = loginCookie.split(".");
      const tampered = `${value}${sig ? `.${sig.slice(0, -2)}xx` : ""}`;
      expect((await callback(`code=abc&state=${state}`, tampered)).status).toBe(400);
      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it("never redirects off-site after login", async () => {
      stubProvider();
      const { state, loginCookie } = await startLogin("https://evil.example/phish");
      const res = await callback(`code=abc&state=${state}`, loginCookie);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
      expect(safeReturnTo("//evil.example")).toBe("/");
      expect(safeReturnTo("/\\evil.example")).toBe("/");
      expect(safeReturnTo("/candidates/1?x=1")).toBe("/candidates/1?x=1");
      expect(safeReturnTo(undefined)).toBe("/");
      expect(safeReturnTo("")).toBe("/");
      expect(safeReturnTo("https://evil.example/")).toBe("/");
      expect(safeReturnTo("javascript:alert(1)")).toBe("/");
      // Control characters (CRLF) would poison the redirect's Location header.
      expect(safeReturnTo("/foo\r\nSet-Cookie: x=1")).toBe("/");
      expect(safeReturnTo("/foo\nbar")).toBe("/");
      expect(safeReturnTo("/foo\x00bar")).toBe("/");
    });

    it("falls back to the home page when returnTo would overflow the login cookie", async () => {
      const atLimit = `/?q=${"a".repeat(MAX_RETURN_TO_LENGTH - 4)}`;
      expect(safeReturnTo(atLimit)).toBe(atLimit);
      expect(safeReturnTo(`${atLimit}a`)).toBe("/");

      stubProvider();
      const { state, loginCookie } = await startLogin(`/?q=${"a".repeat(5000)}`);
      // The cookie stayed well under the browser's limit, so the callback still works.
      expect(loginCookie.length).toBeLessThan(4096);
      const res = await callback(`code=abc&state=${state}`, loginCookie);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
    });

    it("sends the user home with a note when they decline on Wikimedia", async () => {
      const { stub } = stubProvider();
      const { loginCookie } = await startLogin();
      const res = await callback("error=access_denied", loginCookie);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/?auth=denied");
      expect(stub).not.toHaveBeenCalled();
    });

    it("fails soft when the token exchange is refused", async () => {
      stubProvider({ tokenStatus: 400, tokenBody: { error: "invalid_grant" } });
      const { state, loginCookie } = await startLogin();
      const res = await callback(`code=abc&state=${state}`, loginCookie);
      expect(res.headers.get("location")).toBe("/?auth=failed");
      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it("fails soft when the provider is unreachable, and bounds the wait", async () => {
      const stub = vi.fn<typeof fetch>(async () => {
        throw new Error("ECONNRESET");
      });
      vi.stubGlobal("fetch", stub);
      const { state, loginCookie } = await startLogin();
      const res = await callback(`code=abc&state=${state}`, loginCookie);
      expect(res.headers.get("location")).toBe("/?auth=failed");
      expect(stub.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
      expect(await db.select().from(users)).toHaveLength(0);
    });

    it("fails soft on a profile without a user id, creating nothing", async () => {
      stubProvider({ profile: { username: "NoSub" } });
      const { state, loginCookie } = await startLogin();
      const res = await callback(`code=abc&state=${state}`, loginCookie);
      expect(res.headers.get("location")).toBe("/?auth=failed");
      expect(await db.select().from(users)).toHaveLength(0);
      expect(await db.select().from(oauthTokens)).toHaveLength(0);
    });

    it("updates an existing user's name and block status on re-login", async () => {
      stubProvider();
      const first = await startLogin();
      await callback(`code=abc&state=${first.state}`, first.loginCookie);

      stubProvider({ profile: { sub: 7, username: "Alicia", groups: ["user"], blocked: true } });
      const second = await startLogin();
      const res = await callback(`code=def&state=${second.state}`, second.loginCookie);
      const rows = await db.select().from(users);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 7, username: "Alicia", groups: ["user"], blocked: true });
      expect((await me(cookieValue(res, SESSION_COOKIE))).user).toMatchObject({
        username: "Alicia",
        blocked: true,
      });
    });

    it("replaces an existing session in the same browser", async () => {
      stubProvider();
      const old = await loginAs(7, "Alice");
      const oldToken = old.Cookie.split("=")[1];
      const { state, loginCookie } = await startLogin();
      const res = await app.request(`/api/auth/callback?code=abc&state=${state}`, {
        headers: { Cookie: `mna_oauth=${loginCookie}; ${old.Cookie}` },
      });
      const fresh = cookieValue(res, SESSION_COOKIE)!;
      expect(fresh).not.toBe(oldToken);
      expect((await me(oldToken)).user).toBeNull();
      expect((await me(fresh)).user?.id).toBe(7);
      expect(await db.select().from(sessions)).toHaveLength(1);
    });
  });

  describe("sessions", () => {
    it("reports nobody when logged out, and flags admins", async () => {
      expect(await me()).toEqual({ user: null, configured: true, wikiBaseUrl: wikiOrigin() });
      const admin = await loginAs(42, "Root");
      expect((await me(admin.Cookie.split("=")[1])).user).toMatchObject({ isAdmin: true });
    });

    it("ignores and deletes an expired session", async () => {
      const token = randomToken(32);
      await db.insert(users).values({ id: 7, username: "Alice", groups: [] });
      await db.insert(sessions).values({
        id: sha256Hex(token),
        userId: 7,
        lastSeenAt: toSqlDatetime(new Date()),
        expiresAt: toSqlDatetime(addSeconds(new Date(), -1)),
      });
      expect((await me(token)).user).toBeNull();
      expect(await db.select().from(sessions)).toHaveLength(0);
    });

    it("ignores a session idle for too long", async () => {
      const token = randomToken(32);
      await db.insert(users).values({ id: 7, username: "Alice", groups: [] });
      await db.insert(sessions).values({
        id: sha256Hex(token),
        userId: 7,
        lastSeenAt: toSqlDatetime(addSeconds(new Date(), -8 * 24 * 3600)),
        expiresAt: toSqlDatetime(addSeconds(new Date(), SESSION_TTL_SECONDS)),
      });
      expect((await me(token)).user).toBeNull();
    });

    it("touches last_seen_at only once the touch interval has passed", async () => {
      await db.insert(users).values({ id: 7, username: "Alice", groups: [] });
      const expiresAt = toSqlDatetime(addSeconds(new Date(), SESSION_TTL_SECONDS));
      const insert = async (ageSeconds: number) => {
        const token = randomToken(32);
        const lastSeenAt = toSqlDatetime(addSeconds(new Date(), -ageSeconds));
        await db
          .insert(sessions)
          .values({ id: sha256Hex(token), userId: 7, lastSeenAt, expiresAt });
        return { token, lastSeenAt };
      };
      const recent = await insert(60);
      const stale = await insert(10 * 60);
      expect((await me(recent.token)).user?.id).toBe(7);
      expect((await me(stale.token)).user?.id).toBe(7);

      const rows = await db.select().from(sessions);
      const seen = (token: string) => rows.find((r) => r.id === sha256Hex(token))!.lastSeenAt;
      expect(seen(recent.token)).toBe(recent.lastSeenAt);
      expect(fromSqlDatetime(seen(stale.token)).getTime()).toBeGreaterThan(Date.now() - 10_000);
    });

    it("prunes sessions past their absolute expiry", async () => {
      const live = await loginAs(7, "Alice");
      await db.insert(sessions).values({
        id: sha256Hex(randomToken(32)),
        userId: 7,
        lastSeenAt: toSqlDatetime(new Date()),
        expiresAt: toSqlDatetime(addSeconds(new Date(), -1)),
      });
      expect(await pruneExpiredSessions()).toEqual({ sessions: 1, tokens: 0 });
      expect(await db.select().from(sessions)).toHaveLength(1);
      expect((await me(live.Cookie.split("=")[1])).user?.id).toBe(7);
    });

    it("prunes the tokens of anyone left with no session, keeping everyone else's", async () => {
      await db.insert(users).values({ id: 7, username: "Alice", groups: [] });
      await db.insert(sessions).values({
        id: sha256Hex(randomToken(32)),
        userId: 7,
        lastSeenAt: toSqlDatetime(new Date()),
        expiresAt: toSqlDatetime(addSeconds(new Date(), -1)),
      });
      await storeTokens(7, { access_token: "a", refresh_token: "r", expires_in: 3600 });
      await loginAs(8, "Bob");
      await storeTokens(8, { access_token: "b", refresh_token: "s", expires_in: 3600 });
      // A user whose session already idled out (and was never pruned) is caught too.
      await db.insert(users).values({ id: 9, username: "Carol", groups: [] });
      await storeTokens(9, { access_token: "c", refresh_token: "t", expires_in: 3600 });

      expect(await pruneExpiredSessions()).toEqual({ sessions: 1, tokens: 2 });
      const left = await db.select({ userId: oauthTokens.userId }).from(oauthTokens);
      expect(left).toEqual([{ userId: 8 }]);
    });

    it("drops the tokens along with an expired session when its cookie shows up", async () => {
      const token = randomToken(32);
      await db.insert(users).values({ id: 7, username: "Alice", groups: [] });
      await db.insert(sessions).values({
        id: sha256Hex(token),
        userId: 7,
        lastSeenAt: toSqlDatetime(new Date()),
        expiresAt: toSqlDatetime(addSeconds(new Date(), -1)),
      });
      await storeTokens(7, { access_token: "a", refresh_token: "r", expires_in: 3600 });
      expect((await me(token)).user).toBeNull();
      expect(await db.select().from(sessions)).toHaveLength(0);
      expect(await db.select().from(oauthTokens)).toHaveLength(0);
    });

    it("keeps the tokens when the expired session wasn't the user's last", async () => {
      const stale = randomToken(32);
      const live = await loginAs(7, "Alice");
      await db.insert(sessions).values({
        id: sha256Hex(stale),
        userId: 7,
        lastSeenAt: toSqlDatetime(new Date()),
        expiresAt: toSqlDatetime(addSeconds(new Date(), -1)),
      });
      await storeTokens(7, { access_token: "a", refresh_token: "r", expires_in: 3600 });
      expect((await me(stale)).user).toBeNull();
      expect((await me(live.Cookie.split("=")[1])).user?.id).toBe(7);
      expect(await db.select().from(oauthTokens)).toHaveLength(1);
    });

    it("clears an unknown session cookie without touching the database", async () => {
      const res = await app.request("/api/auth/me", {
        headers: { Cookie: `${SESSION_COOKIE}=${randomToken(32)}` },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as AuthMeResponse).user).toBeNull();
      expect(cookieLine(res, SESSION_COOKIE)).toMatch(/Max-Age=0/);
    });

    it("logs out: drops the session and, with no other session left, the tokens", async () => {
      const headers = await loginAs(7, "Alice");
      const token = headers.Cookie.split("=")[1];
      await storeTokens(7, { access_token: "a", refresh_token: "r", expires_in: 3600 });

      const res = await app.request("/api/auth/logout", { method: "POST", headers });
      expect(res.status).toBe(200);
      expect(cookieLine(res, SESSION_COOKIE)).toMatch(/Max-Age=0/);
      expect((await me(token)).user).toBeNull();
      expect(await db.select().from(sessions)).toHaveLength(0);
      expect(await db.select().from(oauthTokens)).toHaveLength(0);
    });

    it("keeps the tokens while another session is still alive", async () => {
      const first = await loginAs(7, "Alice");
      await loginAs(7, "Alice");
      await storeTokens(7, { access_token: "a", refresh_token: "r", expires_in: 3600 });
      await app.request("/api/auth/logout", { method: "POST", headers: first });
      expect(await db.select().from(sessions)).toHaveLength(1);
      expect(await db.select().from(oauthTokens)).toHaveLength(1);
    });

    it("rejects a cross-site logout", async () => {
      const headers = await loginAs(7, "Alice");
      const res = await app.request("/api/auth/logout", {
        method: "POST",
        headers: { Cookie: headers.Cookie, Origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
      expect(await db.select().from(sessions)).toHaveLength(1);
      // BASE_URL's origin is accepted (Vite's dev proxy rewrites the Host).
      const ok = await app.request("/api/auth/logout", {
        method: "POST",
        headers: { Cookie: headers.Cookie, Origin: "http://localhost:5173" },
      });
      expect(ok.status).toBe(200);
    });

    it("treats same-site as cross-origin, and accepts the request's own origin", async () => {
      const headers = await loginAs(7, "Alice");
      // Another *.toolforge.org tool is same-site but not same-origin.
      const sameSite = await app.request("/api/auth/logout", {
        method: "POST",
        headers: { Cookie: headers.Cookie, "Sec-Fetch-Site": "same-site" },
      });
      expect(sameSite.status).toBe(403);
      // app.request() targets http://localhost; an Origin of exactly that passes.
      const own = await app.request("/api/auth/logout", {
        method: "POST",
        headers: { Cookie: headers.Cookie, Origin: "http://localhost" },
      });
      expect(own.status).toBe(200);
      expect(await db.select().from(sessions)).toHaveLength(0);
    });
  });

  describe("getAccessToken", () => {
    beforeEach(async () => {
      await db.insert(users).values({ id: 7, username: "Alice", groups: [] });
    });

    it("returns the stored token while it is fresh", async () => {
      const { stub } = stubProvider();
      await storeTokens(7, { access_token: "fresh", refresh_token: "r", expires_in: 3600 });
      expect(await getAccessToken(7)).toBe("fresh");
      expect(stub).not.toHaveBeenCalled();
    });

    it("refreshes an expiring token and persists the rotated pair", async () => {
      const { tokenCalls } = stubProvider({
        tokenBody: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 },
      });
      await storeTokens(7, { access_token: "old", refresh_token: "refresh-1", expires_in: 60 });
      expect(await getAccessToken(7)).toBe("access-2");
      expect(Object.fromEntries(tokenCalls[0])).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
        client_id: "client-123",
        client_secret: "shh-client-secret",
      });
      const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.userId, 7));
      expect(decrypt(row.accessToken, "oauth_tokens:7")).toBe("access-2");
      expect(decrypt(row.refreshToken!, "oauth_tokens:7")).toBe("refresh-2");
      // And now it's fresh: no second refresh.
      expect(await getAccessToken(7)).toBe("access-2");
      expect(tokenCalls).toHaveLength(1);
    });

    it("refreshes once when several requests race, via in-process coalescing", async () => {
      const { tokenCalls } = stubProvider({
        tokenBody: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 },
      });
      await storeTokens(7, { access_token: "old", refresh_token: "refresh-1", expires_in: 0 });
      const results = await Promise.all([getAccessToken(7), getAccessToken(7), getAccessToken(7)]);
      expect(results).toEqual(["access-2", "access-2", "access-2"]);
      expect(tokenCalls).toHaveLength(1);
    });

    it("keeps the old refresh token when the provider doesn't rotate it", async () => {
      stubProvider({ tokenBody: { access_token: "access-2", expires_in: 3600 } });
      await storeTokens(7, { access_token: "old", refresh_token: "refresh-1", expires_in: 0 });
      await getAccessToken(7);
      const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.userId, 7));
      expect(decrypt(row.refreshToken!, "oauth_tokens:7")).toBe("refresh-1");
    });

    it("drops the tokens and reports a revoked grant on invalid_grant", async () => {
      stubProvider({ tokenStatus: 400, tokenBody: { error: "invalid_grant" } });
      await storeTokens(7, { access_token: "old", refresh_token: "refresh-1", expires_in: 0 });
      await expect(getAccessToken(7)).rejects.toMatchObject({ code: "revoked" });
      expect(await db.select().from(oauthTokens)).toHaveLength(0);
    });

    it("keeps the tokens on a transient refresh failure", async () => {
      stubProvider({ tokenStatus: 503, tokenBody: { error: "temporarily_unavailable" } });
      await storeTokens(7, { access_token: "old", refresh_token: "refresh-1", expires_in: 0 });
      await expect(getAccessToken(7)).rejects.toMatchObject({ code: "refresh-failed" });
      expect(await db.select().from(oauthTokens)).toHaveLength(1);
    });

    it("rejects a ciphertext copied from another user's row", async () => {
      await storeTokens(7, { access_token: "alice", refresh_token: "r-alice", expires_in: 3600 });
      const [alice] = await db.select().from(oauthTokens).where(eq(oauthTokens.userId, 7));
      await db.insert(users).values({ id: 8, username: "Mallory", groups: [] });
      await db.insert(oauthTokens).values({ ...alice, userId: 8 });
      await expect(getAccessToken(8)).rejects.toThrow(/auth/i);
      expect(await getAccessToken(7)).toBe("alice");
    });

    it("errors when the user has no token", async () => {
      await expect(getAccessToken(7)).rejects.toBeInstanceOf(TokenError);
      await expect(getAccessToken(7)).rejects.toMatchObject({ code: "no-token" });
    });
  });
});
