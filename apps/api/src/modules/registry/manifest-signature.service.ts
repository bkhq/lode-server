import type { RegistryPackage } from "./access";
import type { Manifest } from "./feed.service";
import type { AppDatabase } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { AppError } from "@/shared/lib/errors";
import { registryKeys, registryManifestSignatures } from "./schema";
import { canonicalCatalog, manifestExpiryMessage, manifestMessage, verifyEd25519 } from "./signature";

// The publisher's signature over the manifest the registry generates (lode's
// top-level `sig`, and `expires` with its `expires_sig`). The registry never
// signs: it holds no private key. The publisher downloads the manifest, signs
// it with `lode-cli manifest-sign` and sends the result here; it is served
// only while it still matches the catalog and can still verify.

export type ManifestSignature = typeof registryManifestSignatures.$inferSelect;

/**
 * Whether a stored signature is served:
 * - `live`: attached to the manifest;
 * - `stale`: the catalog changed since it was made (a publish, a channel move, a yank or restore);
 * - `expired`: its `expires` has passed;
 * - `revoked`: its key is no longer an active signing key of the package.
 */
export type ManifestSignatureStatus = "live" | "stale" | "expired" | "revoked";

export interface ManifestSignatureInput {
  readonly keyId: string;
  readonly sig: string;
  /** Unix seconds; present together with `expiresSig`. */
  readonly expires?: number | undefined;
  readonly expiresSig?: string | undefined;
}

async function catalogSha256(catalog: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(catalog)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function activeKey(db: AppDatabase, packageId: string, keyId: string) {
  return await db
    .select()
    .from(registryKeys)
    .where(and(eq(registryKeys.packageId, packageId), eq(registryKeys.keyId, keyId), eq(registryKeys.alg, "ed25519"), isNull(registryKeys.revokedAt)))
    .get();
}

export async function findManifestSignature(db: AppDatabase, packageId: string): Promise<ManifestSignature | undefined> {
  return await db.select().from(registryManifestSignatures).where(eq(registryManifestSignatures.packageId, packageId)).get();
}

/** Where `stored` stands against `manifest`, the package's manifest as generated now. */
export async function manifestSignatureStatus(db: AppDatabase, stored: ManifestSignature, manifest: Manifest, now = Date.now()): Promise<ManifestSignatureStatus> {
  if (!(await activeKey(db, stored.packageId, stored.keyId)))
    return "revoked";
  if (stored.catalogSha256 !== await catalogSha256(canonicalCatalog(manifest)))
    return "stale";
  // lode refuses a manifest at or past its expiry.
  if (stored.expires !== null && stored.expires <= Math.floor(now / 1000))
    return "expired";
  return "live";
}

/**
 * `manifest` with the package's stored signature, when that signature is
 * live; otherwise `manifest` as it is. A signature that no longer verifies
 * must never go out: lode rejects a manifest whose signature fails, where it
 * accepts an unsigned one under its default policy. The same holds for a
 * lapsed expiry, which lode enforces whenever the field is present.
 */
export async function withManifestSignature(db: AppDatabase, pkg: RegistryPackage, manifest: Manifest, now = Date.now()): Promise<Manifest> {
  const stored = await findManifestSignature(db, pkg.id);
  if (!stored || await manifestSignatureStatus(db, stored, manifest, now) !== "live")
    return manifest;
  const { schema, name, ...catalog } = manifest;
  return {
    schema,
    name,
    key_id: stored.keyId,
    sig: stored.sig,
    ...(stored.expires !== null && stored.expiresSig !== null && { expires: stored.expires, expires_sig: stored.expiresSig }),
    ...catalog,
  };
}

/**
 * Store the publisher's signature over `manifest`, the package's manifest as
 * generated now, replacing an earlier one. Both signatures are verified
 * against the rebuilt catalog first: nothing unverified is stored.
 */
export async function putManifestSignature(db: AppDatabase, pkg: RegistryPackage, manifest: Manifest, input: ManifestSignatureInput, now = Date.now()): Promise<ManifestSignature> {
  const key = await activeKey(db, pkg.id, input.keyId);
  if (!key)
    throw new AppError(`${input.keyId} is not an active signing key of this package`, 400, "UNKNOWN_KEY");
  if (input.expires !== undefined && input.expires <= Math.floor(now / 1000))
    throw new AppError("The signed expiry has already passed", 400, "MANIFEST_EXPIRED");

  const catalog = canonicalCatalog(manifest);
  const verified = await verifyEd25519(key.publicKey, input.sig, manifestMessage(manifest.name, input.keyId, catalog))
    && (input.expires === undefined
      || await verifyEd25519(key.publicKey, input.expiresSig ?? "", manifestExpiryMessage(manifest.name, input.keyId, input.expires, catalog)));
  if (!verified) {
    // A wrong signature and a manifest that changed since it was signed look
    // the same from here; the remedy is the same too.
    throw new AppError("The signature does not verify over the manifest served now: download the manifest again and re-sign it", 409, "MANIFEST_CHANGED");
  }

  const row = {
    keyId: input.keyId,
    sig: input.sig,
    expires: input.expires ?? null,
    expiresSig: input.expiresSig ?? null,
    catalogSha256: await catalogSha256(catalog),
    updatedAt: new Date(now).toISOString(),
  };
  await db.insert(registryManifestSignatures).values({ packageId: pkg.id, ...row }).onConflictDoUpdate({ target: registryManifestSignatures.packageId, set: row }).run();
  return { packageId: pkg.id, ...row };
}

/** Drop the package's stored signature; false when it had none. */
export async function deleteManifestSignature(db: AppDatabase, packageId: string): Promise<boolean> {
  if (!(await findManifestSignature(db, packageId)))
    return false;
  await db.delete(registryManifestSignatures).where(eq(registryManifestSignatures.packageId, packageId)).run();
  return true;
}
