// Storage and refresh of a user's OAuth tokens. `getAccessToken` is what the
// Wikidata edit path calls: it returns a token valid for at least a few minutes,
// refreshing (under a row lock, so concurrent requests can't race the rotating
// refresh token) when needed. Tokens are encrypted at rest (crypto.ts).
import { eq } from "drizzle-orm";
import { db } from "../db.ts";
import { oauthTokens } from "../../db/schema.ts";
import { authConfig } from "./config.ts";
import { decrypt, encrypt } from "./crypto.ts";
import { userAgent } from "./user-agent.ts";
import { addSeconds, fromSqlDatetime, toSqlDatetime } from "./time.ts";

/** Refresh when the access token has less than this long left. */
const REFRESH_MARGIN_SECONDS = 5 * 60;
/** If the provider omits `expires_in`, assume the extension default (1h). */
const DEFAULT_EXPIRES_IN = 60 * 60;

/** The OAuth 2.0 token endpoint response (RFC 6749 §5.1). */
export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
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
  const values = tokenRow(tokens, now);
  await db
    .insert(oauthTokens)
    .values({ userId, ...values })
    .onDuplicateKeyUpdate({ set: values });
}

export async function deleteTokens(userId: number): Promise<void> {
  await db.delete(oauthTokens).where(eq(oauthTokens.userId, userId));
}

function tokenRow(tokens: TokenResponse, now: Date) {
  return {
    accessToken: encrypt(tokens.access_token),
    refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
    accessExpiresAt: toSqlDatetime(addSeconds(now, tokens.expires_in ?? DEFAULT_EXPIRES_IN)),
    updatedAt: toSqlDatetime(now),
  };
}

/**
 * Return a usable access token for `userId`, refreshing it first if it is
 * about to expire. Throws `TokenError` when the user has no stored token or the
 * provider rejects the refresh (grant revoked): the caller should ask them to
 * log in again.
 */
export async function getAccessToken(userId: number, now = new Date()): Promise<string> {
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.userId, userId))
      .for("update");
    if (!row) throw new TokenError("no-token", "No OAuth token stored for this user");

    if (fromSqlDatetime(row.accessExpiresAt) > addSeconds(now, REFRESH_MARGIN_SECONDS)) {
      return { token: decrypt(row.accessToken) };
    }
    if (!row.refreshToken) {
      throw new TokenError("revoked", "Access token expired and no refresh token is available");
    }

    const refreshed = await refreshTokens(decrypt(row.refreshToken));
    if (!refreshed.ok) {
      if (refreshed.revoked) return { revoked: true as const };
      throw new TokenError("refresh-failed", `Token refresh failed: ${refreshed.error}`);
    }
    // The provider rotates refresh tokens; if it did not return a new one, keep the old.
    const tokens: TokenResponse = {
      ...refreshed.tokens,
      refresh_token: refreshed.tokens.refresh_token ?? decrypt(row.refreshToken),
    };
    await tx.update(oauthTokens).set(tokenRow(tokens, now)).where(eq(oauthTokens.userId, userId));
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
  const cfg = authConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  let res: Response;
  try {
    res = await fetch(`${cfg.issuer}/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent() },
      body,
    });
  } catch (err) {
    return { ok: false, revoked: false, error: err instanceof Error ? err.message : String(err) };
  }
  const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (!res.ok || !json.access_token) {
    // RFC 6749 §5.2: invalid_grant = the refresh token is expired/revoked/unknown.
    return {
      ok: false,
      revoked: json.error === "invalid_grant",
      error: json.error ?? `HTTP ${res.status}`,
    };
  }
  return { ok: true, tokens: json as TokenResponse };
}
