/**
 * Publisher-signature primitives, byte-compatible with the lode client
 * (`lode-core/src/verify.rs`). WebCrypto only, so the same code runs on Bun
 * and on Workers.
 *
 * v1 verifies ed25519 only: a raw 32-byte public key and a 64-byte signature,
 * both carried as base64. Two things are signed: an asset, and the catalog of
 * a whole manifest (with an optional expiry).
 */

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE64_VALUES = new Map<string, number>([
  ...Array.from(BASE64URL_ALPHABET, (char, value) => [char, value] as const),
  // The standard alphabet is accepted on input.
  ["+", 62],
  ["/", 63],
]);

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const KEY_ID_HEX_CHARS = 16;

/** Identity of a release asset as bound by its signature. */
export interface ArtifactIdentity {
  /** The app the asset belongs to: the package slug, lode's `[global].app`. */
  app: string;
  /** The asset filename. */
  name: string;
  version: string;
  /** Lowercase hex digest of the raw asset bytes; bound verbatim. */
  sha256: string;
  /** Bare-run launch override; absent encodes as an empty field. */
  run?: string | null | undefined;
  /** Passthrough launch override; absent encodes as an empty field. */
  exec?: string | null | undefined;
}

export interface ArtifactSignatureInput extends ArtifactIdentity {
  /** Raw ed25519 public key, base64 in either alphabet. */
  publicKey: string;
  /** Raw ed25519 signature, base64 in either alphabet. */
  sig: string;
}

/**
 * Canonical signed message for an asset: UTF-8, `\n`-separated, no trailing
 * newline. Fields are interpolated verbatim, exactly as lode does.
 */
export function artifactMessage({ app, name, version, sha256, run, exec }: ArtifactIdentity): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`lode.artifact.v2\n${app}\n${name}\n${version}\n${sha256}\n${run ?? ""}\n${exec ?? ""}`);
}

/**
 * Decode base64 in either alphabet (standard `+/` or URL-safe `-_`), with or
 * without `=` padding, ignoring surrounding whitespace. Mirrors lode's
 * `decode_b64`: decoding is strict (no interior whitespace or padding, no stray
 * trailing bits). Returns `null` when the input is not valid base64.
 */
export function decodeBase64Flexible(text: string): Uint8Array<ArrayBuffer> | null {
  const symbols = text.trim().replace(/=+$/, "");
  if (symbols.length % 4 === 1)
    return null;

  const bytes = new Uint8Array(Math.floor((symbols.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const symbol of symbols) {
    const value = BASE64_VALUES.get(symbol);
    if (value === undefined)
      return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xFF;
      buffer &= (1 << bits) - 1;
    }
  }
  // Whatever is left over must be zero padding bits.
  return buffer === 0 ? bytes : null;
}

/** Encode bytes as unpadded base64url, the encoding lode emits. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += BASE64URL_ALPHABET.charAt((buffer >> bits) & 0x3F);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0)
    out += BASE64URL_ALPHABET.charAt((buffer << (6 - bits)) & 0x3F);
  return out;
}

/** `key_id` of a raw public key: the first 16 hex chars of its sha256. */
export async function keyIdOf(rawPublicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawPublicKey));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("").slice(0, KEY_ID_HEX_CHARS);
}

/**
 * Check an ed25519 signature over `message`, key and signature as base64 in
 * either alphabet. Resolves to `false` for anything that does not verify,
 * including malformed keys and signatures; it never rejects.
 */
export async function verifyEd25519(publicKey: string, sig: string, message: Uint8Array<ArrayBuffer>): Promise<boolean> {
  try {
    const rawKey = decodeBase64Flexible(publicKey);
    const signature = decodeBase64Flexible(sig);
    if (rawKey?.length !== ED25519_PUBLIC_KEY_BYTES || signature?.length !== ED25519_SIGNATURE_BYTES) {
      return false;
    }
    const key = await crypto.subtle.importKey("raw", rawKey, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
  }
  catch {
    return false;
  }
}

/** Check an ed25519 signature over the asset's canonical message. */
export async function verifyArtifactSignature(input: ArtifactSignatureInput): Promise<boolean> {
  return await verifyEd25519(input.publicKey, input.sig, artifactMessage(input));
}

/** What of a `lode/v1` manifest its top-level signature covers. */
export interface ManifestCatalog {
  channels: Record<string, { latest: string }>;
  versions: Record<string, { assets: readonly { name: string; sha256: string; run?: string | null; exec?: string | null }[] }>;
}

// lode keeps both maps in a BTreeMap<String>: byte order. Channel names and
// version ids are ASCII here, where code-unit order is the same.
function sortedEntries<T>(map: Record<string, T>): [string, T][] {
  return Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The catalog as lode's `Manifest::canonical_catalog` serializes it: one
 * tab-separated record per line, every line ending in `\n`. Channels and
 * versions are sorted by name; a version's assets keep the manifest's order.
 */
export function canonicalCatalog(manifest: ManifestCatalog): string {
  let out = "";
  for (const [name, channel] of sortedEntries(manifest.channels))
    out += `channel\t${name}\t${channel.latest}\n`;
  for (const [id, version] of sortedEntries(manifest.versions)) {
    out += `version\t${id}\n`;
    for (const asset of version.assets)
      out += `asset\t${asset.name}\t${asset.sha256}\t${asset.run ?? ""}\t${asset.exec ?? ""}\n`;
  }
  return out;
}

/** Signed message of the top-level manifest `sig`. */
export function manifestMessage(name: string, keyId: string, catalog: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`lode.manifest.v1\n${name}\n${keyId}\n${catalog}`);
}

/** Signed message of the manifest's `expires_sig`; `expires` is Unix seconds. */
export function manifestExpiryMessage(name: string, keyId: string, expires: number, catalog: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`lode.manifest-expiry.v1\n${name}\n${keyId}\n${expires}\n${catalog}`);
}
