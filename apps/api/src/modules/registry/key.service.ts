import type { AppDatabase } from "@/db";
import { Buffer } from "node:buffer";
import { and, asc, eq } from "drizzle-orm";
import { AppError, isUniqueViolation, NotFoundError } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";
import { registryKeys } from "./schema";

export type RegistryKey = typeof registryKeys.$inferSelect;

const ED25519_KEY_BYTES = 32;
const RE_FIELD_SEPARATOR = /[:\s]+/;
const RE_BASE64 = /^[A-Z0-9+/]*$/i;

function invalidKey(why: string): AppError {
  return new AppError(`Invalid public key: ${why}`, 400, "INVALID_PUBLIC_KEY");
}

/**
 * Decode base64 the way lode's `decode_b64` does: either alphabet, with or
 * without padding, and strictly — no interior whitespace, no stray bits.
 */
function decodeBase64(text: string): Uint8Array {
  const normalised = text.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
  if (!RE_BASE64.test(normalised) || normalised.length % 4 === 1)
    throw invalidKey("not base64");
  const bytes = Buffer.from(normalised, "base64");
  // Buffer ignores trailing bits a strict decoder rejects; re-encoding
  // exposes them.
  if (bytes.toString("base64").replace(/=+$/, "") !== normalised)
    throw invalidKey("not canonical base64");
  return new Uint8Array(bytes);
}

/**
 * Parse a public key as a publisher would paste it: the bare base64 key, or
 * one of the forms lode prints and accepts in `trusted_keys` —
 * `<key_id>:<key>`, `ed25519:<key>`, `ed25519:<key_id>:<key>`. As in lode the
 * id in front is informational; the real one is derived from the key.
 *
 * Only ed25519 is accepted: any other algorithm name, and any key that is not
 * exactly 32 bytes (an ECDSA point is 33 or 65), is refused.
 */
export function parsePublicKey(input: string): Uint8Array {
  const fields = input.split(RE_FIELD_SEPARATOR).filter(Boolean);
  let encoded: string;
  if (fields.length === 1) {
    encoded = fields[0]!;
  }
  else if (fields.length === 2) {
    // `<alg>:<key>` when the first field names an algorithm, else the
    // legacy `<key_id>:<key>`.
    if (fields[0]!.startsWith("ecdsa"))
      throw invalidKey("only ed25519 keys are supported");
    encoded = fields[1]!;
  }
  else if (fields.length === 3) {
    if (fields[0] !== "ed25519")
      throw invalidKey("only ed25519 keys are supported");
    encoded = fields[2]!;
  }
  else {
    throw invalidKey("expected `[ed25519:][<key_id>:]<base64>`");
  }

  const bytes = decodeBase64(encoded);
  if (bytes.length !== ED25519_KEY_BYTES)
    throw invalidKey(`an ed25519 public key is ${ED25519_KEY_BYTES} bytes, got ${bytes.length}`);
  return bytes;
}

/** lode's `key_id`: the first 16 hex characters of sha256 over the raw key. */
export async function deriveKeyId(publicKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", publicKey as Uint8Array<ArrayBuffer>);
  return Buffer.from(digest).toString("hex").slice(0, 16);
}

export async function listKeys(db: AppDatabase, packageId: string): Promise<RegistryKey[]> {
  return await db.select().from(registryKeys).where(eq(registryKeys.packageId, packageId)).orderBy(asc(registryKeys.createdAt), asc(registryKeys.id)).all();
}

export async function registerKey(
  db: AppDatabase,
  packageId: string,
  input: { readonly publicKey: string; readonly name: string },
): Promise<RegistryKey> {
  const bytes = parsePublicKey(input.publicKey);
  const id = nanoid();
  try {
    await db.insert(registryKeys).values({
      id,
      packageId,
      keyId: await deriveKeyId(bytes),
      alg: "ed25519",
      publicKey: Buffer.from(bytes).toString("base64url"),
      name: input.name,
    }).run();
  }
  catch (err) {
    // Also hit by a revoked key: revocation is final, its id stays taken.
    if (isUniqueViolation(err))
      throw new AppError("This key is already registered for the package", 409, "KEY_EXISTS");
    throw err;
  }
  return (await db.select().from(registryKeys).where(eq(registryKeys.id, id)).get())!;
}

/** Revoke one of a package's keys. Revoking an already revoked key changes nothing. */
export async function revokeKey(db: AppDatabase, packageId: string, id: string): Promise<{ key: RegistryKey; changed: boolean }> {
  const owned = and(eq(registryKeys.id, id), eq(registryKeys.packageId, packageId));
  const key = await db.select().from(registryKeys).where(owned).get();
  if (!key)
    throw new NotFoundError("Key", id);
  if (key.revokedAt !== null)
    return { key, changed: false };
  const revokedAt = new Date().toISOString();
  await db.update(registryKeys).set({ revokedAt }).where(owned).run();
  return { key: { ...key, revokedAt }, changed: true };
}
