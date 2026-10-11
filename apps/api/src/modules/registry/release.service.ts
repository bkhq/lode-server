import type { PackageRequest } from "./access";
import type { BlobStoreConfig } from "./blob";
import type { getEffectiveQuota } from "./registry.service";
import type { AppDatabase } from "@/db";
import { and, asc, count, desc, eq, isNull } from "drizzle-orm";
import { AppError, isUniqueViolation, NotFoundError } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";
import { BlobPutError, getActiveBlobStore } from "./blob";
import { abortUploadsInStore, assertUploadAllowed, assetBlobKey, inFlightUploads, retireVersions, versionPrefix } from "./registry.service";
import { registryAssets, registryChannels, registryKeys, registryPackages, registryRetiredVersions, registryVersions } from "./schema";
import { verifyArtifactSignature } from "./signature";

export type RegistryVersion = typeof registryVersions.$inferSelect;
export type RegistryAsset = typeof registryAssets.$inferSelect;

export interface VersionWithAssets extends RegistryVersion {
  readonly assets: RegistryAsset[];
}

/** A channel pointer with the version string it resolves to. */
export interface ChannelPointer {
  readonly name: string;
  readonly version: string;
  readonly updatedAt: string;
}

type ReleaseConfig = BlobStoreConfig & Parameters<typeof getEffectiveQuota>[2];
type Target = Pick<PackageRequest, "namespace" | "package">;

/**
 * Largest body the single-request upload takes: 95 MiB, under the 100 MB
 * request cap of the smallest Workers plans. Anything larger is multipart.
 */
export const SINGLE_REQUEST_MAX_BYTES = 95 * 1024 * 1024;

export function notDraft(version: string): AppError {
  return new AppError(`Version ${version} is not a draft: its assets can no longer change`, 409, "VERSION_NOT_DRAFT");
}

function inChannel(version: string): AppError {
  return new AppError(`A channel points at version ${version}; move the pointer first`, 409, "VERSION_IN_CHANNEL");
}

// ─── In-flight work ───

// What is being changed right now, per version id: the names of the assets
// in flight, or `WHOLE_VERSION` for an operation on the version itself.
//
// An upload reads the version, streams for a long time and only then writes
// its row; without this a publish could land in between and the upload would
// replace the bytes of a published asset. Held in memory, which is enough
// because one process owns the database: the Durable Object on Workers, the
// server process on Bun.
const busy = new Map<string, Set<string>>();
// Not a valid asset name, so it cannot collide with one.
const WHOLE_VERSION = "*";

/**
 * Claim an asset of a version, or the whole version, until the returned
 * function is called. State read before the claim has to be read again
 * after it.
 */
export function claim(versionId: string, what: string = WHOLE_VERSION): () => void {
  const held = busy.get(versionId) ?? new Set<string>();
  if (held.has(WHOLE_VERSION) || held.has(what) || (what === WHOLE_VERSION && held.size > 0))
    throw new AppError("Another upload or release operation on this version is in progress", 409, "VERSION_BUSY");
  held.add(what);
  busy.set(versionId, held);
  return () => {
    held.delete(what);
    if (held.size === 0)
      busy.delete(versionId);
  };
}

// ─── Reading ───

async function requireVersion(db: AppDatabase, packageId: string, version: string): Promise<RegistryVersion> {
  const row = await db.select().from(registryVersions).where(and(eq(registryVersions.packageId, packageId), eq(registryVersions.version, version))).get();
  if (!row)
    throw new NotFoundError("Version");
  return row;
}

async function assetsOf(db: AppDatabase, versionId: string): Promise<RegistryAsset[]> {
  return await db.select().from(registryAssets).where(eq(registryAssets.versionId, versionId)).orderBy(asc(registryAssets.name)).all();
}

export async function getVersion(db: AppDatabase, packageId: string, version: string): Promise<VersionWithAssets> {
  const row = await requireVersion(db, packageId, version);
  return { ...row, assets: await assetsOf(db, row.id) };
}

/** Every version of a package, newest first, drafts and yanked ones included. */
export async function listVersions(db: AppDatabase, packageId: string): Promise<VersionWithAssets[]> {
  const versions = await db.select().from(registryVersions).where(eq(registryVersions.packageId, packageId)).orderBy(desc(registryVersions.createdAt), desc(registryVersions.id)).all();
  const assets = await db
    .select({ asset: registryAssets })
    .from(registryAssets)
    .innerJoin(registryVersions, eq(registryVersions.id, registryAssets.versionId))
    .where(eq(registryVersions.packageId, packageId))
    .orderBy(asc(registryAssets.name))
    .all();
  return versions.map(version => ({ ...version, assets: assets.map(a => a.asset).filter(a => a.versionId === version.id) }));
}

export async function listChannels(db: AppDatabase, packageId: string): Promise<ChannelPointer[]> {
  return await db
    .select({ name: registryChannels.name, version: registryVersions.version, updatedAt: registryChannels.updatedAt })
    .from(registryChannels)
    .innerJoin(registryVersions, eq(registryVersions.id, registryChannels.versionId))
    .where(eq(registryChannels.packageId, packageId))
    .orderBy(asc(registryChannels.name))
    .all();
}

// ─── Drafts ───

async function isRetired(db: AppDatabase, packageId: string, version: string): Promise<boolean> {
  const row = await db
    .select({ version: registryRetiredVersions.version })
    .from(registryRetiredVersions)
    .innerJoin(registryPackages, and(
      eq(registryPackages.namespaceId, registryRetiredVersions.namespaceId),
      eq(registryPackages.slug, registryRetiredVersions.packageSlug),
    ))
    .where(and(eq(registryPackages.id, packageId), eq(registryRetiredVersions.version, version)))
    .get();
  return row !== undefined;
}

/** Create a draft. The caller validates the version id. */
export async function createDraft(db: AppDatabase, packageId: string, input: { version: string; notes?: string | undefined }): Promise<VersionWithAssets> {
  // Its assets were served as immutable: other bytes under the same id would
  // fail the digest check behind every cache that still holds the old ones.
  if (await isRetired(db, packageId, input.version))
    throw new AppError(`Version ${input.version} was published and then deleted; its id cannot be used again`, 409, "VERSION_RETIRED");
  try {
    const row = await db.insert(registryVersions).values({ id: nanoid(), packageId, version: input.version, notes: input.notes ?? null }).returning().get();
    return { ...row, assets: [] };
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new AppError(`Version ${input.version} already exists`, 409, "VERSION_EXISTS");
    throw err;
  }
}

// ─── Assets ───

/** What a publisher declares about an asset before sending its bytes. */
export interface AssetDeclaration {
  readonly version: string;
  /** Asset filename; validated by the caller, like `sha256`, `run` and `exec`. */
  readonly name: string;
  /** Declared size in bytes: the `Content-Length` of a single-request upload. */
  readonly size: number;
  /** Lowercase hex. */
  readonly sha256: string;
  readonly sig: string | null;
  readonly run: string | null;
  readonly exec: string | null;
}

export interface UploadInput extends AssetDeclaration {
  readonly body: ReadableStream<Uint8Array>;
}

/** The key a stored signature verified under. */
export interface VerifiedSignature {
  readonly keyId: string;
  readonly alg: string;
}

/**
 * The package's active key the signature verifies under. A signature that
 * verifies under none is refused: stored, it would fail on every operator
 * host instead of once here.
 */
async function verifyUnderPackageKeys(db: AppDatabase, pkg: Target["package"], version: string, input: AssetDeclaration & { sig: string }): Promise<VerifiedSignature> {
  const keys = await db
    .select()
    .from(registryKeys)
    .where(and(eq(registryKeys.packageId, pkg.id), eq(registryKeys.alg, "ed25519"), isNull(registryKeys.revokedAt)))
    .all();
  for (const key of keys) {
    const verified = await verifyArtifactSignature({
      // The slug is the manifest `name` an operator sets as `[global].app`.
      app: pkg.slug,
      name: input.name,
      version,
      sha256: input.sha256,
      run: input.run,
      exec: input.exec,
      publicKey: key.publicKey,
      sig: input.sig,
    });
    if (verified)
      return { keyId: key.keyId, alg: key.alg };
  }
  throw new AppError("The signature does not verify under any active signing key of the package: it must be made for this package's slug as the app, this asset name and this version", 400, "INVALID_SIGNATURE");
}

/** The version an upload goes into, which has to be a draft. */
export async function requireDraft(db: AppDatabase, packageId: string, versionString: string): Promise<RegistryVersion> {
  const version = await requireVersion(db, packageId, versionString);
  if (version.status !== "draft")
    throw notDraft(version.version);
  return version;
}

/**
 * What both upload paths check before a byte is accepted, once the draft is
 * known: the asset size limit and the owner's quota, then the signature.
 * Returns the key the signature verified under, or null for an unsigned
 * asset.
 */
export async function admitUpload(db: AppDatabase, config: ReleaseConfig, target: Target, input: AssetDeclaration): Promise<VerifiedSignature | null> {
  const { namespace, package: pkg } = target;
  // Charged to the owner: an administrator may be uploading into the package.
  await assertUploadAllowed(db, namespace.ownerUserId, input.size, config);

  if (input.sig === null && pkg.requireSignature)
    throw new AppError("This package requires signed assets: pass the signature as `sig`", 400, "SIGNATURE_REQUIRED");
  return input.sig === null ? null : await verifyUnderPackageKeys(db, pkg, input.version, { ...input, sig: input.sig });
}

/**
 * Store one asset of a draft from a single request body, replacing an asset
 * of the same name.
 *
 * Everything that can refuse the upload is checked before the body is
 * touched: the version, the size limits and the owner's quota, then the
 * signature. The body then goes to the blob store as is, and the asset row is
 * written only once the store has accepted the bytes against the declared
 * digest and length.
 */
export async function uploadAsset(db: AppDatabase, config: ReleaseConfig, target: Target, input: UploadInput): Promise<{ asset: RegistryAsset; replaced: boolean }> {
  const { namespace, package: pkg } = target;
  const version = await requireDraft(db, pkg.id, input.version);

  if (input.size > SINGLE_REQUEST_MAX_BYTES) {
    throw new AppError(
      `A single-request upload can be at most ${SINGLE_REQUEST_MAX_BYTES} bytes; start a multipart upload with POST /api/registry/packages/${namespace.slug}/${pkg.slug}/versions/${version.version}/uploads`,
      413,
      "SINGLE_REQUEST_TOO_LARGE",
    );
  }
  const signed = await admitUpload(db, config, target, input);

  const store = getActiveBlobStore(config);
  const key = assetBlobKey(pkg.id, version.id, input.name);
  const release = claim(version.id, input.name);
  try {
    // The version was read before the claim.
    if ((await requireVersion(db, pkg.id, input.version)).status !== "draft")
      throw notDraft(version.version);

    try {
      await store.put(key, input.body, { size: input.size, sha256: input.sha256 });
    }
    catch (err) {
      // Nothing was stored, and an asset of that name is still intact. R2
      // does not tell a digest mismatch from any other failed put, so both
      // drivers get the one answer.
      if (err instanceof BlobPutError)
        throw new AppError("The uploaded bytes do not match the declared sha256 and Content-Length", 422, "DIGEST_MISMATCH");
      throw err;
    }

    const sameName = and(eq(registryAssets.versionId, version.id), eq(registryAssets.name, input.name));
    try {
      return await db.transaction(async (tx) => {
        const replaced = await tx.delete(registryAssets).where(sameName).returning({ id: registryAssets.id }).get();
        const asset = await tx.insert(registryAssets).values({
          id: nanoid(),
          versionId: version.id,
          name: input.name,
          size: input.size,
          sha256: input.sha256,
          sig: signed && input.sig,
          keyId: signed?.keyId ?? null,
          alg: signed?.alg ?? null,
          run: input.run,
          exec: input.exec,
          blobKey: key,
        }).returning().get();
        return { asset, replaced: replaced !== undefined };
      });
    }
    catch (err) {
      // The bytes at the key are the new ones and no row describes them (the
      // version may be gone altogether): drop both rather than serve a
      // mismatch.
      await store.delete(key);
      await db.delete(registryAssets).where(sameName).run();
      throw err;
    }
  }
  finally {
    release();
  }
}

/** Remove one asset of a draft, row and bytes. */
export async function deleteAsset(db: AppDatabase, config: BlobStoreConfig, packageId: string, versionString: string, name: string): Promise<RegistryAsset> {
  const version = await requireVersion(db, packageId, versionString);
  const release = claim(version.id, name);
  try {
    if ((await requireVersion(db, packageId, versionString)).status !== "draft")
      throw notDraft(version.version);
    const asset = await db.delete(registryAssets).where(and(eq(registryAssets.versionId, version.id), eq(registryAssets.name, name))).returning().get();
    if (!asset)
      throw new NotFoundError("Asset");
    await getActiveBlobStore(config).delete(asset.blobKey);
    return asset;
  }
  finally {
    release();
  }
}

// ─── Publishing and channels ───

type Transaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

async function pointChannel(tx: Transaction, packageId: string, name: string, versionId: string): Promise<void> {
  await tx
    .insert(registryChannels)
    .values({ packageId, name, versionId })
    .onConflictDoUpdate({ target: [registryChannels.packageId, registryChannels.name], set: { versionId, updatedAt: new Date().toISOString() } })
    .run();
}

async function pointersAt(tx: Transaction, versionId: string): Promise<number> {
  return (await tx.select({ n: count() }).from(registryChannels).where(eq(registryChannels.versionId, versionId)).get())?.n ?? 0;
}

/**
 * Publish a draft that has at least one asset and move `channel` to it, in
 * one transaction: a client polling the manifest sees either the old pointer
 * or the new one with every asset in place.
 */
export async function publishVersion(db: AppDatabase, packageId: string, versionString: string, channel: string): Promise<VersionWithAssets> {
  const version = await requireVersion(db, packageId, versionString);
  const release = claim(version.id);
  try {
    await db.transaction(async (tx) => {
      const current = await tx.select({ status: registryVersions.status }).from(registryVersions).where(eq(registryVersions.id, version.id)).get();
      if (current?.status !== "draft")
        throw notDraft(version.version);
      const assets = await tx.select({ n: count() }).from(registryAssets).where(eq(registryAssets.versionId, version.id)).get();
      if ((assets?.n ?? 0) === 0)
        throw new AppError(`Version ${version.version} has no assets to publish`, 409, "VERSION_EMPTY");
      await tx.update(registryVersions).set({ status: "published", publishedAt: new Date().toISOString() }).where(eq(registryVersions.id, version.id)).run();
      await pointChannel(tx, packageId, channel, version.id);
    });
  }
  finally {
    release();
  }
  return await getVersion(db, packageId, versionString);
}

/** Promote or roll back a channel pointer. Only a published version can be a target. */
export async function setChannel(db: AppDatabase, packageId: string, channel: string, versionString: string): Promise<ChannelPointer> {
  const version = await requireVersion(db, packageId, versionString);
  await db.transaction(async (tx) => {
    const current = await tx.select({ status: registryVersions.status }).from(registryVersions).where(eq(registryVersions.id, version.id)).get();
    if (current?.status !== "published")
      throw new AppError(`Version ${version.version} is not published: a channel can only point at a published version`, 409, "VERSION_NOT_PUBLISHED");
    await pointChannel(tx, packageId, channel, version.id);
  });
  return (await listChannels(db, packageId)).find(pointer => pointer.name === channel)!;
}

/** Hide a published version from the manifest. Refused while a channel points at it. */
export async function yankVersion(db: AppDatabase, packageId: string, versionString: string): Promise<VersionWithAssets> {
  const version = await requireVersion(db, packageId, versionString);
  await db.transaction(async (tx) => {
    const current = await tx.select({ status: registryVersions.status }).from(registryVersions).where(eq(registryVersions.id, version.id)).get();
    if (current?.status !== "published")
      throw new AppError(`Version ${version.version} is not published`, 409, "VERSION_NOT_PUBLISHED");
    if (await pointersAt(tx, version.id) > 0)
      throw inChannel(version.version);
    await tx.update(registryVersions).set({ status: "yanked" }).where(eq(registryVersions.id, version.id)).run();
  });
  return await getVersion(db, packageId, versionString);
}

/** Put a yanked version back among the published ones. */
export async function restoreVersion(db: AppDatabase, packageId: string, versionString: string): Promise<VersionWithAssets> {
  const version = await requireVersion(db, packageId, versionString);
  const restored = await db
    .update(registryVersions)
    .set({ status: "published" })
    .where(and(eq(registryVersions.id, version.id), eq(registryVersions.status, "yanked")))
    .returning({ id: registryVersions.id })
    .get();
  if (!restored)
    throw new AppError(`Version ${version.version} is not yanked`, 409, "VERSION_NOT_YANKED");
  return await getVersion(db, packageId, versionString);
}

/**
 * Delete a version with its assets, uploads and stored bytes. With
 * `draftOnly` anything but a draft is refused; without it a published or
 * yanked version goes too, unless a channel still points at it.
 */
export async function deleteVersion(db: AppDatabase, config: BlobStoreConfig, packageId: string, versionString: string, opts: { draftOnly: boolean }): Promise<RegistryVersion> {
  const version = await requireVersion(db, packageId, versionString);
  const release = claim(version.id);
  try {
    // Read before the cascade takes the rows: the store has to be told about
    // each upload, `deletePrefix` does not reach unfinished ones.
    const uploads = await inFlightUploads(db, { versionId: version.id });
    const deleted = await db.transaction(async (tx) => {
      const current = await tx.select().from(registryVersions).where(eq(registryVersions.id, version.id)).get();
      if (!current)
        throw new NotFoundError("Version");
      if (opts.draftOnly && current.status !== "draft")
        throw notDraft(current.version);
      // The pointer has no cascade of its own.
      if (await pointersAt(tx, current.id) > 0)
        throw inChannel(current.version);
      await retireVersions(tx, packageId, current.id);
      // Assets and uploads cascade.
      await tx.delete(registryVersions).where(eq(registryVersions.id, current.id)).run();
      return current;
    });
    // Rows first: bytes left behind by a failure here are unreachable, while
    // rows without bytes would be served as broken downloads.
    const store = getActiveBlobStore(config);
    await abortUploadsInStore(store, uploads);
    await store.deletePrefix(versionPrefix(packageId, version.id));
    return deleted;
  }
  finally {
    release();
  }
}
