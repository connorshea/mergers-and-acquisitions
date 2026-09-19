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
  it("round-trips and never stores the plaintext", () => {
    const keys = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    const ct = encrypt("secret-access-token", keys);
    expect(ct).not.toContain("secret-access-token");
    expect(ct.startsWith("v1:")).toBe(true);
    expect(decrypt(ct, keys)).toBe("secret-access-token");
  });

  it("uses a fresh IV each time", () => {
    const keys = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    expect(encrypt("x", keys)).not.toBe(encrypt("x", keys));
  });

  it("rejects tampering", () => {
    const keys = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    const [v, kid, iv, ct, tag] = encrypt("payload", keys).split(":");
    const flipped = ct[0] === "A" ? "B" : "A";
    expect(() => decrypt([v, kid, iv, flipped + ct.slice(1), tag].join(":"), keys)).toThrow(
      /auth/i,
    );
    expect(() => decrypt("garbage", keys)).toThrow(/format/);
  });

  it("decrypts with the previous key during a rotation, encrypts with the current one", () => {
    const old = loadEncKeys({ TOKEN_ENC_KEY: keyA });
    const ct = encrypt("tok", old);
    const rotated = loadEncKeys({ TOKEN_ENC_KEY: keyB, TOKEN_ENC_KEY_PREVIOUS: keyA });
    expect(decrypt(ct, rotated)).toBe("tok");
    expect(encrypt("tok", rotated).split(":")[1]).toBe(rotated[0].kid);
    // Without the previous key the old ciphertext is unreadable, with a pointed error.
    expect(() => decrypt(ct, loadEncKeys({ TOKEN_ENC_KEY: keyB }))).toThrow(
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
