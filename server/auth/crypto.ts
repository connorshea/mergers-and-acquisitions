// Small crypto helpers for auth: random tokens, hashing, PKCE, and the
// authenticated encryption used for OAuth tokens at rest. All on node:crypto —
// no third-party dependency.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** `bytes` random bytes as unpadded base64url (the alphabet PKCE requires). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** RFC 7636 S256 code challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Constant-time string comparison that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// --- token encryption -------------------------------------------------------
//
// Ciphertext format: `v1:<kid>:<iv>:<ct>:<tag>` (base64url parts). `kid` is a
// fingerprint of the key that encrypted it, so a key rotation only needs the
// old key kept in TOKEN_ENC_KEY_PREVIOUS until every row has been re-written.
//
// `aad` (additional authenticated data) binds a ciphertext to its context —
// the owning user id for OAuth tokens — so a ciphertext copied into another
// user's row fails to decrypt instead of quietly letting that user act as
// someone else. It is authenticated, not encrypted, and must be passed
// identically to `decrypt`.

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

export interface EncKey {
  kid: string;
  key: Buffer;
}

function parseKey(raw: string, name: string): EncKey {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`${name} must be 32 bytes, base64-encoded (got ${key.length} bytes)`);
  }
  return { kid: createHash("sha256").update(key).digest("hex").slice(0, 8), key };
}

/** Current key (encrypts + decrypts) plus any previous key (decrypt only). */
export function loadEncKeys(env: NodeJS.ProcessEnv = process.env): EncKey[] {
  const current = env.TOKEN_ENC_KEY;
  if (!current) throw new Error("TOKEN_ENC_KEY is not set (see .env.example)");
  const keys = [parseKey(current, "TOKEN_ENC_KEY")];
  if (env.TOKEN_ENC_KEY_PREVIOUS)
    keys.push(parseKey(env.TOKEN_ENC_KEY_PREVIOUS, "TOKEN_ENC_KEY_PREVIOUS"));
  return keys;
}

export function encrypt(plaintext: string, aad: string, keys: EncKey[] = loadEncKeys()): string {
  const { kid, key } = keys[0];
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    kid,
    iv.toString("base64url"),
    ct.toString("base64url"),
    tag.toString("base64url"),
  ].join(":");
}

export function decrypt(payload: string, aad: string, keys: EncKey[] = loadEncKeys()): string {
  const parts = payload.split(":");
  if (parts.length !== 5 || parts[0] !== "v1") throw new Error("Unrecognised ciphertext format");
  const [, kid, ivB64, ctB64, tagB64] = parts;
  const entry = keys.find((k) => k.kid === kid);
  if (!entry)
    throw new Error(
      `No encryption key with id ${kid} (was TOKEN_ENC_KEY rotated without TOKEN_ENC_KEY_PREVIOUS?)`,
    );
  const decipher = createDecipheriv(ALGO, entry.key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
