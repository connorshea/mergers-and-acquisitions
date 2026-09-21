// Unit tests for the env-derived auth config helpers (no DB, no network).
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  authConfig,
  authConfigured,
  baseOrigin,
  callbackUrl,
  cookiesSecure,
  parseAdminIds,
} from "./config.ts";

const VARS = [
  "OAUTH_CLIENT_ID",
  "OAUTH_CLIENT_SECRET",
  "OAUTH_ISSUER",
  "BASE_URL",
  "SESSION_SECRET",
  "TOKEN_ENC_KEY",
  "TOKEN_ENC_KEY_PREVIOUS",
  "ADMIN_USERS",
] as const;
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));

function setEnv(values: Partial<Record<(typeof VARS)[number], string>>) {
  for (const k of VARS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
}

const COMPLETE = {
  OAUTH_CLIENT_ID: "id",
  OAUTH_CLIENT_SECRET: "secret",
  SESSION_SECRET: "x".repeat(32),
  TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString("base64"),
};

afterEach(() => setEnv(saved));

describe("parseAdminIds", () => {
  it("keeps positive integers and drops everything else", () => {
    expect(parseAdminIds("42, 7,abc,-1,0,3.5,,")).toEqual(new Set([42, 7]));
    expect(parseAdminIds(undefined).size).toBe(0);
  });
});

describe("authConfigured / authConfig", () => {
  it("is unconfigured until every required variable is set", () => {
    setEnv({});
    expect(authConfigured()).toBe(false);
    setEnv({ ...COMPLETE, TOKEN_ENC_KEY: undefined });
    expect(authConfigured()).toBe(false);
    setEnv(COMPLETE);
    expect(authConfigured()).toBe(true);
  });

  it("treats a too-short SESSION_SECRET as unconfigured, so login degrades to 503", () => {
    setEnv({ ...COMPLETE, SESSION_SECRET: "too-short" });
    expect(authConfigured()).toBe(false);
  });

  it("treats a malformed TOKEN_ENC_KEY as unconfigured rather than failing mid-callback", () => {
    // 64 hex chars (`openssl rand -hex 32`) base64-decodes to 48 bytes, not 32.
    setEnv({ ...COMPLETE, TOKEN_ENC_KEY: "ab".repeat(32) });
    expect(authConfigured()).toBe(false);
    expect(() => authConfig()).toThrow(/TOKEN_ENC_KEY must be 32 bytes/);

    setEnv({ ...COMPLETE, TOKEN_ENC_KEY_PREVIOUS: "not-a-key" });
    expect(authConfigured()).toBe(false);
    expect(() => authConfig()).toThrow(/TOKEN_ENC_KEY_PREVIOUS must be 32 bytes/);
  });

  it("refuses a short SESSION_SECRET and names a missing variable", () => {
    setEnv({ ...COMPLETE, SESSION_SECRET: "too-short" });
    expect(() => authConfig()).toThrow(/SESSION_SECRET must be at least 32/);
    setEnv({ ...COMPLETE, OAUTH_CLIENT_SECRET: undefined });
    expect(() => authConfig()).toThrow(/OAUTH_CLIENT_SECRET is not set/);
  });

  it("defaults the issuer and base URL, trimming trailing slashes", () => {
    setEnv({
      ...COMPLETE,
      OAUTH_ISSUER: "https://oauth.test/oauth2/",
      BASE_URL: "https://mna.example/",
    });
    const cfg = authConfig();
    expect(cfg.issuer).toBe("https://oauth.test/oauth2");
    expect(cfg.baseUrl).toBe("https://mna.example");
    expect(callbackUrl()).toBe("https://mna.example/api/auth/callback");
    expect(baseOrigin()).toBe("https://mna.example");
    expect(cookiesSecure()).toBe(true);

    setEnv(COMPLETE);
    expect(authConfig().issuer).toBe("https://www.wikidata.org/w/rest.php/oauth2");
    expect(callbackUrl()).toBe("http://localhost:5173/api/auth/callback");
    expect(cookiesSecure()).toBe(false);
  });
});
