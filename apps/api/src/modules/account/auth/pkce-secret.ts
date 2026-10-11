import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts and decrypts PKCE code-verifier values with a per-process AES
 * key. When the DB is plaintext (`DB_ENCRYPTION=false` — the default),
 * an at-rest dump of `pkce_challenges` during an active OAuth flow no
 * longer yields a usable verifier; the attacker would also need
 * read-access to the API process memory.
 *
 * The key is generated at first use and never persisted. PKCE rows have
 * a 10-minute TTL, so a process restart invalidates in-flight verifiers
 * (callers fail with `oauth_state_invalid` and re-initiate login) —
 * acceptable for the security gain.
 *
 * Storage format: `${iv-hex}:${ciphertext-hex}:${auth-tag-hex}`. The
 * leading `v1:` token versions the scheme so a future change can
 * detect and migrate (or reject) old records.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LEN = 12;
const SCHEME_TAG = "v1";

let key: Buffer | null = null;

function getKey(): Buffer {
  if (key === null)
    key = randomBytes(32);
  return key;
}

export function sealPkceVerifier(verifier: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(verifier, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SCHEME_TAG}:${iv.toString("hex")}:${ciphertext.toString("hex")}:${tag.toString("hex")}`;
}

/** Returns `undefined` when the input is malformed or fails AEAD verification. */
export function openPkceVerifier(sealed: string): string | undefined {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== SCHEME_TAG)
    return undefined;
  try {
    const iv = Buffer.from(parts[1]!, "hex");
    const ciphertext = Buffer.from(parts[2]!, "hex");
    const tag = Buffer.from(parts[3]!, "hex");
    const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
  catch {
    return undefined;
  }
}

/** Test hook — drop the cached key between specs. */
export function __resetPkceSecretForTests(): void {
  key = null;
}
