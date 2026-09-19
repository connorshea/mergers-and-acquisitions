// Storage and refresh of a user's OAuth tokens. `getAccessToken` is what the
// Wikidata edit path calls: it returns a token valid for at least a few minutes,
// refreshing when needed. The refresh's provider round-trip is never made while
// holding a DB connection or row lock — the common (still-valid) path is a plain
// read, and concurrent refreshes for one user are coalesced in-process, with a
// short transaction reconciling the write. Tokens are encrypted at rest
// (crypto.ts), with the owning user id as authenticated data so a row can't be
// re-pointed at another user by copying ciphertext around in the database.
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { oauthTokens } from "../../db/schema.ts";
import { type AuthConfig, authConfig } from "./config.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { userAgent } from "./user-agent.ts";
import { addSeconds, fromSqlDatetime, toSqlDatetime } from "./time.ts";

/** Refresh when the access token has less than this long left. */
const REFRESH_MARGIN_SECONDS = 5 * 60;
/** If the provider omits `expires_in`, assume the extension default (1h). */
const DEFAULT_EXPIRES_IN = 60 * 60;
/** Give up on a request to the OAuth provider after this long. */
export const FETCH_TIMEOUT_MS = 15_000;

/** The AAD that ties a user's ciphertexts to their row. */
const tokenAad = (userId: number) => `oauth_tokens:${userId}`;

/** The OAuth 2.0 token endpoint response (RFC 6749 §5.1). */
export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

export type TokenResult =
  | { ok: true; tokens: TokenResponse }
  | {
      ok: false;
      error: string;
      /** The RFC 6749 §5.2 error code, when the provider returned one (vs. a network failure). */
      code?: string;
    };

/**
 * POST the provider's token endpoint (RFC 6749 §4.1.3 / §6) with `grant`
 * (the grant_type and its parameters); the client credentials are added here.
 * This is the one place that knows how to talk to it — the authorization-code
 * exchange and the refresh both go through it. Never throws: a network
 * failure or timeout is an `ok: false` result without a `code`.
 */
export async function tokenRequest(
  cfg: AuthConfig,
  grant: Record<string, string>,
): Promise<TokenResult> {
  let res: Response;
  try {
    res = await fetch(`${cfg.issuer}/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
      body: new URLSearchParams({
        ...grant,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || !json.access_token) {
    return { ok: false, error: json.error ?? `HTTP ${res.status}`, code: json.error };
  }
  return { ok: true, tokens: json as TokenResponse };
}

export class TokenError extends Error {
  code: "no-token" | "revoked" | "refresh-failed";
  constructor(code: TokenError["code"], message: string) {
    super(message);
    this.name = "TokenError";
    this.code = code;
  }
}

/** Persist a freshly issued token pair for `userId` (insert or replace). */
export async function storeTokens(
  userId: number,
  tokens: TokenResponse,
  now = new Date(),
): Promise<void> {
  const values = tokenRow(userId, tokens, now);
  await db
    .insert(oauthTokens)
    .values({ userId, ...values })
    .onDuplicateKeyUpdate({ set: values });
}

export async function deleteTokens(userId: number): Promise<void> {
  await db.delete(oauthTokens).where(eq(oauthTokens.userId, userId));
}

function tokenRow(userId: number, tokens: TokenResponse, now: Date) {
  const aad = tokenAad(userId);
  return {
    accessToken: encrypt(tokens.access_token, aad),
    refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token, aad) : null,
    accessExpiresAt: toSqlDatetime(addSeconds(now, tokens.expires_in ?? DEFAULT_EXPIRES_IN)),
    updatedAt: toSqlDatetime(now),
  };
}

/**
 * Coalesce concurrent refreshes for the same user within this process, so a
 * burst of edits near expiry makes a single provider round-trip rather than one
 * per request. The web server runs as a single Node process; the short
 * transaction in `refreshAndStore` still reconciles with any other writer.
 */
const refreshInFlight = new Map<number, Promise<string>>();

/**
 * Return a usable access token for `userId`, refreshing it first if it is
 * about to expire. Throws `TokenError` when the user has no stored token or the
 * provider rejects the refresh (grant revoked): the caller should ask them to
 * log in again.
 */
export async function getAccessToken(userId: number, now = new Date()): Promise<string> {
  // Fast path: a plain read — no transaction, no row lock. This is every call
  // whose token is still comfortably valid, i.e. the overwhelming majority.
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId));
  if (!row) throw new TokenError("no-token", "No OAuth token stored for this user");
  if (fromSqlDatetime(row.accessExpiresAt) > addSeconds(now, REFRESH_MARGIN_SECONDS)) {
    return decrypt(row.accessToken, tokenAad(userId));
  }
  if (!row.refreshToken) {
    throw new TokenError("revoked", "Access token expired and no refresh token is available");
  }

  const existing = refreshInFlight.get(userId);
  if (existing) return existing;
  const promise = refreshAndStore(userId, now).finally(() => refreshInFlight.delete(userId));
  refreshInFlight.set(userId, promise);
  return promise;
}

/**
 * Refresh `userId`'s token against the provider and persist the result. The
 * network call happens with no DB connection held; only the read-back-and-write
 * reconciliation runs inside a transaction (under a row lock).
 */
async function refreshAndStore(userId: number, now: Date): Promise<string> {
  const aad = tokenAad(userId);

  // Re-read (unlocked) to pick up a token another writer may have just stored
  // and to get the refresh token we will send to the provider.
  const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.userId, userId));
  if (!row) throw new TokenError("no-token", "No OAuth token stored for this user");
  if (fromSqlDatetime(row.accessExpiresAt) > addSeconds(now, REFRESH_MARGIN_SECONDS)) {
    return decrypt(row.accessToken, aad);
  }
  if (!row.refreshToken) {
    throw new TokenError("revoked", "Access token expired and no refresh token is available");
  }
  const usedRefreshCipher = row.refreshToken;
  const refreshed = await refreshTokens(decrypt(usedRefreshCipher, aad));

  const result = await db.transaction(async (tx) => {
    const [cur] = await tx
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, userId))
      .for("update");
    if (!cur) throw new TokenError("no-token", "No OAuth token stored for this user");

    // Another writer refreshed while we were on the network: adopt their token.
    if (fromSqlDatetime(cur.accessExpiresAt) > addSeconds(now, REFRESH_MARGIN_SECONDS)) {
      return { token: decrypt(cur.accessToken, aad) };
    }

    if (!refreshed.ok) {
      // If the stored refresh token changed under us, our failure is a lost
      // rotation race (another writer already spent it), not a real revocation.
      const raced = cur.refreshToken !== usedRefreshCipher;
      if (refreshed.revoked && !raced) return { revoked: true as const };
      throw new TokenError("refresh-failed", `Token refresh failed: ${refreshed.error}`);
    }

    // The provider rotates refresh tokens; if it did not return a new one, keep the old.
    const tokens: TokenResponse = {
      ...refreshed.tokens,
      refresh_token: refreshed.tokens.refresh_token ?? decrypt(usedRefreshCipher, aad),
    };
    await tx
      .update(oauthTokens)
      .set(tokenRow(userId, tokens, now))
      .where(eq(oauthTokens.userId, userId));
    return { token: tokens.access_token };
  });

  if ("revoked" in result) {
    // Done outside the transaction: a throw inside it would roll the delete back.
    await deleteTokens(userId);
    throw new TokenError("revoked", "The Wikimedia authorization was revoked; log in again");
  }
  return result.token;
}

type RefreshResult =
  | { ok: true; tokens: TokenResponse }
  | { ok: false; revoked: boolean; error: string };

async function refreshTokens(refreshToken: string): Promise<RefreshResult> {
  const result = await tokenRequest(authConfig(), {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (result.ok) return result;
  // RFC 6749 §5.2: invalid_grant = the refresh token is expired/revoked/unknown.
  return { ok: false, revoked: result.code === "invalid_grant", error: result.error };
}
