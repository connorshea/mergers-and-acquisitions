import { describe, expect, it } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import {
  decrypt,
  encrypt,
  loadEncKeys,
  pkceChallenge,
  randomToken,
  safeEqual,
  sha256Hex,
} from "./crypto.ts";

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");

describe("pkceChallenge", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("randomToken", () => {
  it("is base64url and long enough for PKCE", () => {
    const t = randomToken(48);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(43);
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe("safeEqual", () => {
  it("compares strings of any length without throwing", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("token encryption", () => {
  const AAD = "oauth_tokens:7";

  it("binds the ciphertext to its context: a different AAD fails to decrypt", () => {
    const keys = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    const ct = encrypt("tok", AAD, keys);
    expect(decrypt(ct, AAD, keys)).toBe("tok");
    expect(() => decrypt(ct, "oauth_tokens:8", keys)).toThrow(/auth/i);
  });

  it("round-trips and never stores the plaintext", () => {
    const keys = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    const ct = encrypt("secret-access-token", AAD, keys);
    expect(ct).not.toContain("secret-access-token");
    expect(ct.startsWith("v1:")).toBe(true);
    expect(decrypt(ct, AAD, keys)).toBe("secret-access-token");
  });

  it("uses a fresh IV each time", () => {
    const keys = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    expect(encrypt("x", AAD, keys)).not.toBe(encrypt("x", AAD, keys));
  });

  it("rejects tampering", () => {
    const keys = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    const parts = encrypt("payload", AAD, keys).split(":");
    expect(parts).toHaveLength(5);
    const [v, kid, iv, ct, tag] = parts;
    const flipped = ct!.startsWith("A") ? "B" : "A";
    expect(() => decrypt([v, kid, iv, flipped + ct!.slice(1), tag].join(":"), AAD, keys)).toThrow(
      /auth/i,
    );
    expect(() => decrypt("garbage", AAD, keys)).toThrow(/format/);
  });

  it("rejects a truncated auth tag rather than verifying a shorter one", () => {
    const keys = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    const [v, kid, iv, ct, tag] = encrypt("payload", AAD, keys).split(":") as [
      string,
      string,
      string,
      string,
      string,
    ];
    expect(Buffer.from(tag, "base64url")).toHaveLength(16);
    // Node accepts 4/8/12..16-byte GCM tags by default; every short one must fail here.
    for (const n of [15, 12, 8, 4]) {
      const short = Buffer.from(tag, "base64url").subarray(0, n).toString("base64url");
      expect(() => decrypt([v, kid, iv, ct, short].join(":"), AAD, keys)).toThrow(/format/);
    }
  });

  it("rejects an IV of any length but 12 bytes", () => {
    const keys = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    const [v, kid, iv, ct, tag] = encrypt("payload", AAD, keys).split(":") as [
      string,
      string,
      string,
      string,
      string,
    ];
    expect(Buffer.from(iv, "base64url")).toHaveLength(12);
    for (const bad of [Buffer.alloc(0), Buffer.alloc(8), Buffer.alloc(16)]) {
      expect(() =>
        decrypt([v, kid, bad.toString("base64url"), ct, tag].join(":"), AAD, keys),
      ).toThrow(/format/);
    }
  });

  it("decrypts with the previous key during a rotation, encrypts with the current one", () => {
    const old = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    const ct = encrypt("tok", AAD, old);
    const rotated = loadEncKeys({ TOKEN_ENC_KEY: keyB, TOKEN_ENC_KEY_PREVIOUS: keyA });
    expect(decrypt(ct, AAD, rotated)).toBe("tok");
    expect(encrypt("tok", AAD, rotated).split(":")[1]).toBe(rotated[0]?.kid);
    // Without the previous key the old ciphertext is unreadable, with a pointed error.
    expect(() => decrypt(ct, AAD, loadEncKeys({ TOKEN_ENC_KEY: keyB }))).toThrow(
      /TOKEN_ENC_KEY_PREVIOUS/,
    );
  });

  it("insists on a 32-byte key", () => {
    expect(() => loadEncKeys({ TOKEN_ENC_KEY: Buffer.alloc(16).toString("base64") })).toThrow(
      /32 bytes/,
    );
    expect(() => loadEncKeys({})).toThrow(/TOKEN_ENC_KEY/);
  });
});

describe("sha256Hex", () => {
  it("hashes deterministically to 64 hex chars", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
