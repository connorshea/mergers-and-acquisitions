// Auth configuration, read from the environment on every call (not memoized) so
// tests can set variables after import and the server never caches a half-set
// config. Nothing here is required for the read-only parts of the app: when the
// OAuth consumer isn't configured, login returns 503 and everything else works.
import "dotenv/config";
import { loadEncKeys } from "./crypto.ts";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  /** Base of the OAuth 2.0 REST endpoints, e.g. https://meta.wikimedia.org/w/rest.php/oauth2 */
  issuer: string;
  /** Public origin of this app (scheme + host), used for the callback URL and cookie flags. */
  baseUrl: string;
  /** HMAC key for the short-lived login-state cookie. */
  sessionSecret: string;
  /** Wikidata Action API endpoint the edits go to (test.wikidata.org in dev). */
  wikidataApiUrl: string;
}

export const DEFAULT_ISSUER = "https://meta.wikimedia.org/w/rest.php/oauth2";
export const DEFAULT_WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php";

const MIN_SECRET_LENGTH = 32;
const DEFAULT_BASE_URL = "http://localhost:5173";

/** Public base URL of this app (scheme + host[:port][/prefix]), trailing slashes trimmed. */
export function baseUrl(): string {
  return (process.env.BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * True when the auth config is complete and usable. Defined as "`authConfig()`
 * doesn't throw" so the two can't drift: any check added there automatically
 * makes a misconfiguration degrade to a 503 rather than throwing a 500 from
 * inside the login route.
 */
export function authConfigured(): boolean {
  try {
    authConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and validate the auth config. Throws with a pointed message on a
 * missing/short secret or a malformed encryption key; callers that can degrade
 * (the login route) check `authConfigured()` first.
 */
export function authConfig(): AuthConfig {
  const env = process.env;
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set (see .env.example)`);
    return value;
  };
  const sessionSecret = need("SESSION_SECRET");
  if (sessionSecret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  // Parse the token-encryption key(s) up front: a malformed TOKEN_ENC_KEY would
  // otherwise only surface from `encrypt()` mid-callback, after the user row
  // has already been written.
  loadEncKeys(env);
  return {
    clientId: need("OAUTH_CLIENT_ID"),
    clientSecret: need("OAUTH_CLIENT_SECRET"),
    issuer: (env.OAUTH_ISSUER ?? DEFAULT_ISSUER).replace(/\/+$/, ""),
    baseUrl: baseUrl(),
    sessionSecret,
    wikidataApiUrl: wikidataApiUrl(),
  };
}

/** The Wikidata Action API endpoint edits go to (test.wikidata.org while developing). */
export function wikidataApiUrl(): string {
  return process.env.WIKIDATA_API_URL ?? DEFAULT_WIKIDATA_API_URL;
}

/**
 * Origin (scheme + host) of the Wikidata instance edits go to, e.g.
 * `https://test.wikidata.org`. Used to build article/user-page links that point
 * at the same wiki the app edits, not always www.wikidata.org.
 */
export function wikiOrigin(): string {
  try {
    return new URL(wikidataApiUrl()).origin;
  } catch {
    return new URL(DEFAULT_WIKIDATA_API_URL).origin;
  }
}

/**
 * Comma-separated central user ids (ADMIN_USERS) → set. Non-numeric entries are
 * ignored. Admin membership is deliberately not part of `AuthConfig`: the
 * session middleware is its only consumer and memoizes this against the raw
 * env value, so there is exactly one place that decides who is an admin.
 */
export function parseAdminIds(raw: string | undefined): Set<number> {
  const ids = new Set<number>();
  for (const part of (raw ?? "").split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n > 0) ids.add(n);
  }
  return ids;
}

/** Cookies are `Secure` exactly when the app is served over https. */
export function cookiesSecure(): boolean {
  return baseUrl().startsWith("https://");
}

/** Origin (scheme + host[:port]) of BASE_URL, for the same-origin check. */
export function baseOrigin(): string {
  return new URL(baseUrl()).origin;
}

/** The exact redirect URI registered with the OAuth consumer. */
export function callbackUrl(): string {
  return `${baseUrl()}/api/auth/callback`;
}
