/**
 * ECIES (Elliptic Curve Integrated Encryption Scheme) using secp256k1.
 *
 * Uses @noble/secp256k1 for EC operations and SubtleCrypto for HKDF + AES-256-GCM.
 * Works in both Node.js/Bun and browser environments.
 *
 * KDF: HKDF-SHA256(x-coordinate of ECDH shared point, info="ecies-aes256gcm")
 */
import { getPublicKey, getSharedSecret, Point, utils } from "@noble/secp256k1";

const IV_LEN = 12;
const HKDF_INFO = new TextEncoder().encode("ecies-aes256gcm");

/** Convert Uint8Array to ArrayBuffer for SubtleCrypto compatibility. */
function toAB(arr: Uint8Array): ArrayBuffer {
  return arr.buffer instanceof ArrayBuffer
    ? arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength)
    : new Uint8Array(arr).buffer as ArrayBuffer;
}

/**
 * Derive AES-256 key from ECDH shared secret x-coordinate using HKDF-SHA256.
 * Uses only the x-coordinate (bytes 1..33 of the uncompressed shared point).
 */
async function deriveAesKey(sharedPoint: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  // Uncompressed point: 0x04 || x (32 bytes) || y (32 bytes) — extract x only
  const sharedX = sharedPoint.subarray(1, 33);
  const ikm = await crypto.subtle.importKey("raw", toAB(sharedX), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: toAB(HKDF_INFO) },
    ikm,
    256,
  );
  return crypto.subtle.importKey("raw", bits, "AES-GCM", false, [usage]);
}

/** Generate a new secp256k1 keypair. Returns hex-encoded private and public keys. */
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const privKey = utils.randomSecretKey();
  const pubKey = getPublicKey(privKey, false);
  return {
    privateKey: bytesToHex(privKey),
    publicKey: bytesToHex(pubKey),
  };
}

/** Generate a random 32-byte salt (hex-encoded). */
export function generateSalt(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/**
 * Derive a secp256k1 keypair from a password + salt using PBKDF2-SHA256.
 * 600,000 iterations per OWASP recommendation.
 * The derived 32 bytes are used as the secp256k1 private key.
 */
export async function deriveKeyPairFromPassword(
  password: string,
  saltHex: string,
): Promise<{ privateKey: string; publicKey: string }> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const saltBytes = hexToBytes(saltHex);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toAB(saltBytes), iterations: 600_000 },
    keyMaterial,
    256,
  );
  const privKey = new Uint8Array(bits);

  // Validate the derived key is a valid secp256k1 secret key
  if (!utils.isValidSecretKey(privKey)) {
    throw new Error("Derived key is not a valid secp256k1 secret key — try a different password");
  }

  const pubKey = getPublicKey(privKey, false);
  return {
    privateKey: bytesToHex(privKey),
    publicKey: bytesToHex(pubKey),
  };
}

/** Generate random IV using crypto.getRandomValues. */
function randomIv(): Uint8Array {
  const buf = new Uint8Array(IV_LEN);
  crypto.getRandomValues(buf);
  return buf;
}

/**
 * ECIES encrypt: encrypt plaintext bytes with a secp256k1 public key.
 * Returns: ephemeralPubKey (65 bytes) + iv (12 bytes) + ciphertext + tag (16 bytes)
 */
export async function eciesEncrypt(publicKeyHex: string, plaintext: Uint8Array): Promise<Uint8Array> {
  Point.fromHex(publicKeyHex);
  const pubKeyBytes = hexToBytes(publicKeyHex);

  const ephPriv = utils.randomSecretKey();
  const ephPub = getPublicKey(ephPriv, false);

  const shared = getSharedSecret(ephPriv, pubKeyBytes, false);
  const aesKey = await deriveAesKey(shared, "encrypt");

  const iv = randomIv();
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: toAB(iv) }, aesKey, toAB(plaintext)));

  const result = new Uint8Array(ephPub.length + IV_LEN + encrypted.length);
  result.set(ephPub, 0);
  result.set(iv, ephPub.length);
  result.set(encrypted, ephPub.length + IV_LEN);
  return result;
}

/**
 * ECIES decrypt: decrypt ciphertext with a secp256k1 private key.
 * Input format: ephemeralPubKey (65 bytes) + iv (12 bytes) + ciphertext + tag (16 bytes)
 */
export async function eciesDecrypt(privateKeyHex: string, data: Uint8Array): Promise<Uint8Array> {
  const ephPub = data.subarray(0, 65);
  const iv = data.subarray(65, 65 + IV_LEN);
  const encrypted = data.subarray(65 + IV_LEN);

  const privKeyBytes = hexToBytes(privateKeyHex);
  const shared = getSharedSecret(privKeyBytes, ephPub, false);
  const aesKey = await deriveAesKey(shared, "decrypt");

  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: toAB(iv) }, aesKey, toAB(encrypted)));
}

/** Hex encode bytes */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/** Hex decode string to bytes */
export function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const result = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}
