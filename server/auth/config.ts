// Auth configuration, read from the environment on every call (not memoized) so
// tests can set variables after import and the server never caches a half-set
// config. Nothing here is required for the read-only parts of the app: when the
// OAuth consumer isn't configured, login returns 503 and everything else works.
import "dotenv/config";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  /** Base of the OAuth 2.0 REST endpoints, e.g. https://meta.wikimedia.org/w/rest.php/oauth2 */
  issuer: string;
  /** Public origin of this app (scheme + host), used for the callback URL and cookie flags. */
  baseUrl: string;
  /** HMAC key for the short-lived login-state cookie. */
  sessionSecret: string;
  /** Wikimedia central user ids allowed to run maintenance actions. */
  adminUserIds: Set<number>;
  /** Wikidata Action API endpoint the edits go to (test.wikidata.org in dev). */
  wikidataApiUrl: string;
}

export const DEFAULT_ISSUER = "https://meta.wikimedia.org/w/rest.php/oauth2";
export const DEFAULT_WIKIDATA_API_URL = "https://www.wikidata.org/w/api.php";

const MIN_SECRET_LENGTH = 32;

/** True when the variables needed to start an OAuth login are all present. */
export function authConfigured(): boolean {
  const env = process.env;
  return Boolean(
    env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET && env.SESSION_SECRET && env.TOKEN_ENC_KEY,
  );
}

/**
 * Read and validate the auth config. Throws with a pointed message on a
 * missing/short secret; callers that can degrade (the login route) check
 * `authConfigured()` first.
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
  const baseUrl = (env.BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "");
  return {
    clientId: need("OAUTH_CLIENT_ID"),
    clientSecret: need("OAUTH_CLIENT_SECRET"),
    issuer: (env.OAUTH_ISSUER ?? DEFAULT_ISSUER).replace(/\/+$/, ""),
    baseUrl,
    sessionSecret,
    adminUserIds: parseAdminIds(env.ADMIN_USERS),
    wikidataApiUrl: env.WIKIDATA_API_URL ?? DEFAULT_WIKIDATA_API_URL,
  };
}

/** Comma-separated central user ids → set. Non-numeric entries are ignored. */
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
  return (process.env.BASE_URL ?? "http://localhost:5173").startsWith("https://");
}

/** Origin (scheme + host[:port]) of BASE_URL, for the same-origin check. */
export function baseOrigin(): string {
  return new URL(process.env.BASE_URL ?? "http://localhost:5173").origin;
}

/** The exact redirect URI registered with the OAuth consumer. */
export function callbackUrl(): string {
  return `${(process.env.BASE_URL ?? "http://localhost:5173").replace(/\/+$/, "")}/api/auth/callback`;
}
