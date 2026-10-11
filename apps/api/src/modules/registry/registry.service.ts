import type { RegistryNamespace, RegistryPackage } from "./access";
import type { BlobStore, BlobStoreConfig } from "./blob";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { PolicyContext } from "@/modules/policy";
import { and, asc, count, eq, ne, sum } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { userSubject } from "@/modules/policy";
import { AppError, isUniqueViolation } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";
import { namespaceSuspended, packageAccess } from "./access";
import { getActiveBlobStore } from "./blob";
import { registryAssets, registryNamespaces, registryPackages, registryQuotas, registryRetiredVersions, registryUploads, registryVersions } from "./schema";

// ─── Namespaces ───

export async function getNamespaceForUser(db: AppDatabase, userId: string): Promise<RegistryNamespace | undefined> {
  return await db.select().from(registryNamespaces).where(eq(registryNamespaces.ownerUserId, userId)).get();
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const slugHead = customAlphabet(LETTERS, 1);
const slugTail = customAlphabet(`${LETTERS}0123456789`, 7);

/**
 * A fresh namespace id: 8 random characters, lowercase letters and digits,
 * the first a letter so it never reads as a number.
 */
export function generateNamespaceSlug(): string {
  return slugHead() + slugTail();
}

/** How many ids are tried before giving up; one collision is already a rare event. */
const MAX_SLUG_ATTEMPTS = 8;

/**
 * The namespace of `userId`, assigning one when they have none yet. A user
 * has one namespace and its id never changes. `assigned` is true for the
 * call that created it.
 *
 * Safe to call concurrently: the unique index on the owner makes the insert
 * a no-op for every caller but one, and the others read that one's row.
 * `generate` is a parameter for the tests.
 */
export async function ensureNamespace(
  db: AppDatabase,
  userId: string,
  generate: () => string = generateNamespaceSlug,
): Promise<{ namespace: RegistryNamespace; assigned: boolean }> {
  const existing = await getNamespaceForUser(db, userId);
  if (existing)
    return { namespace: existing, assigned: false };

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      const inserted = await db
        .insert(registryNamespaces)
        .values({ id: nanoid(), slug: generate(), ownerUserId: userId })
        .onConflictDoNothing({ target: registryNamespaces.ownerUserId })
        .returning()
        .get();
      if (inserted)
        return { namespace: inserted, assigned: true };
      // A concurrent call assigned it first.
      return { namespace: (await getNamespaceForUser(db, userId))!, assigned: false };
    }
    catch (err) {
      // The generated id is taken: try another.
      if (!isUniqueViolation(err))
        throw err;
    }
  }
  throw new AppError("Could not assign a namespace, try again", 503, "NAMESPACE_UNAVAILABLE");
}

// ─── Quotas ───

export interface EffectiveQuota {
  readonly maxPackages: number;
  readonly maxStorageBytes: number;
  readonly maxAssetBytes: number;
}

/** No override lifts a single asset above what the upload path is built for. */
const MAX_ASSET_BYTES_CEILING = 500 * 1024 * 1024;

/**
 * The limits that apply to `userId`: the administrator's per-user override
 * where one is set, the platform default from configuration otherwise.
 */
export async function getEffectiveQuota(
  db: AppDatabase,
  userId: string,
  config: Pick<Config, "REGISTRY_MAX_PACKAGES_PER_USER" | "REGISTRY_MAX_STORAGE_BYTES_PER_USER" | "REGISTRY_MAX_ASSET_BYTES">,
): Promise<EffectiveQuota> {
  const override = await db.select().from(registryQuotas).where(eq(registryQuotas.userId, userId)).get();
  return {
    maxPackages: override?.maxPackages ?? config.REGISTRY_MAX_PACKAGES_PER_USER,
    maxStorageBytes: override?.maxStorageBytes ?? config.REGISTRY_MAX_STORAGE_BYTES_PER_USER,
    maxAssetBytes: Math.min(override?.maxAssetBytes ?? config.REGISTRY_MAX_ASSET_BYTES, MAX_ASSET_BYTES_CEILING),
  };
}

export interface Usage {
  readonly packages: number;
  readonly storageBytes: number;
}

/**
 * Bytes held per package: stored assets plus the declared sizes of uploads
 * still in flight, so space is reserved from the moment an upload starts.
 * Packages holding nothing are absent from the map.
 */
export async function getStorageByPackage(db: AppDatabase, namespaceId?: string): Promise<Map<string, number>> {
  const inNamespace = namespaceId === undefined ? undefined : eq(registryPackages.namespaceId, namespaceId);
  const stored = await db
    .select({ packageId: registryVersions.packageId, bytes: sum(registryAssets.size).mapWith(Number) })
    .from(registryAssets)
    .innerJoin(registryVersions, eq(registryVersions.id, registryAssets.versionId))
    .innerJoin(registryPackages, eq(registryPackages.id, registryVersions.packageId))
    .where(inNamespace)
    .groupBy(registryVersions.packageId)
    .all();
  const inFlight = await db
    .select({ packageId: registryVersions.packageId, bytes: sum(registryUploads.size).mapWith(Number) })
    .from(registryUploads)
    .innerJoin(registryVersions, eq(registryVersions.id, registryUploads.versionId))
    .innerJoin(registryPackages, eq(registryPackages.id, registryVersions.packageId))
    .where(inNamespace)
    .groupBy(registryVersions.packageId)
    .all();
  const bytes = new Map<string, number>();
  for (const row of [...stored, ...inFlight])
    bytes.set(row.packageId, (bytes.get(row.packageId) ?? 0) + row.bytes);
  return bytes;
}

/** What `userId` holds against their quota. */
export async function getUsage(db: AppDatabase, userId: string): Promise<Usage> {
  const namespace = await getNamespaceForUser(db, userId);
  if (!namespace)
    return { packages: 0, storageBytes: 0 };
  const held = await db.select({ n: count() }).from(registryPackages).where(eq(registryPackages.namespaceId, namespace.id)).get();
  const storage = await getStorageByPackage(db, namespace.id);
  return { packages: held?.n ?? 0, storageBytes: [...storage.values()].reduce((a, b) => a + b, 0) };
}

/**
 * Refuse an upload of `size` bytes into a package owned by `userId` before
 * any byte is accepted: 413 when the asset alone is over the limit, 409 when
 * it would take the owner over their storage quota. Call it when an upload
 * starts, before its `registry_uploads` row is written.
 */
export async function assertUploadAllowed(
  db: AppDatabase,
  userId: string,
  size: number,
  config: Parameters<typeof getEffectiveQuota>[2],
): Promise<void> {
  const quota = await getEffectiveQuota(db, userId, config);
  if (size > quota.maxAssetBytes)
    throw new AppError(`An asset can be at most ${quota.maxAssetBytes} bytes`, 413, "ASSET_TOO_LARGE");
  const usage = await getUsage(db, userId);
  if (usage.storageBytes + size > quota.maxStorageBytes)
    throw new AppError(`This upload would exceed the storage quota of ${quota.maxStorageBytes} bytes`, 409, "STORAGE_QUOTA_EXCEEDED");
}

// ─── Packages ───

export async function listPackagesInNamespace(db: AppDatabase, namespaceId: string): Promise<RegistryPackage[]> {
  return await db.select().from(registryPackages).where(eq(registryPackages.namespaceId, namespaceId)).orderBy(asc(registryPackages.slug)).all();
}

export interface CreatePackageInput {
  readonly slug: string;
  readonly name: string;
  readonly visibility?: "public" | "private" | undefined;
  readonly description?: string | undefined;
  readonly requireSignature?: boolean | undefined;
}

/**
 * Create a package in the actor's own namespace and make them its owner,
 * assigning the namespace when this is their first package. The caller
 * validates the slug and the name.
 */
export async function createPackage(
  ctx: PolicyContext,
  config: Parameters<typeof getEffectiveQuota>[2],
  input: CreatePackageInput,
): Promise<{ namespace: RegistryNamespace; namespaceAssigned: boolean; package: RegistryPackage }> {
  const { db } = ctx;
  const { namespace, assigned: namespaceAssigned } = await ensureNamespace(db, ctx.actor.id);
  if (namespace.status !== "active" && ctx.actor.role !== "admin")
    throw namespaceSuspended();

  const quota = await getEffectiveQuota(db, ctx.actor.id, config);
  const id = nanoid();
  try {
    // Count and insert in one transaction, so two concurrent creates cannot
    // both pass the limit.
    await db.transaction(async (tx) => {
      const held = await tx.select({ n: count() }).from(registryPackages).where(eq(registryPackages.namespaceId, namespace.id)).get();
      if ((held?.n ?? 0) >= quota.maxPackages)
        throw new AppError(`You can own at most ${quota.maxPackages} packages`, 409, "PACKAGE_QUOTA_EXCEEDED");
      await tx.insert(registryPackages).values({
        id,
        namespaceId: namespace.id,
        slug: input.slug,
        name: input.name,
        visibility: input.visibility ?? "public",
        description: input.description ?? null,
        requireSignature: input.requireSignature ?? false,
      }).run();
    });
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new AppError(`Package ${namespace.slug}/${input.slug} already exists`, 409, "PACKAGE_EXISTS");
    throw err;
  }

  // Without its owner tuple the package would be unreachable to everyone
  // but an administrator, so a failed grant takes the row back out.
  try {
    await packageAccess.grant(ctx, { subject: userSubject(namespace.ownerUserId), relation: "owner", objectId: id });
  }
  catch (err) {
    await db.delete(registryPackages).where(eq(registryPackages.id, id)).run();
    throw err;
  }

  const pkg = (await db.select().from(registryPackages).where(eq(registryPackages.id, id)).get())!;
  return { namespace, namespaceAssigned, package: pkg };
}

/** Everything of a package that can change. The slug cannot. */
export interface UpdatePackageInput {
  readonly name?: string | undefined;
  readonly visibility?: "public" | "private" | undefined;
  readonly description?: string | null | undefined;
  readonly requireSignature?: boolean | undefined;
}

export async function updatePackage(db: AppDatabase, id: string, changes: UpdatePackageInput): Promise<RegistryPackage> {
  await db.update(registryPackages).set({
    ...(changes.name !== undefined && { name: changes.name }),
    ...(changes.visibility !== undefined && { visibility: changes.visibility }),
    ...(changes.description !== undefined && { description: changes.description }),
    ...(changes.requireSignature !== undefined && { requireSignature: changes.requireSignature }),
  }).where(eq(registryPackages.id, id)).run();
  return (await db.select().from(registryPackages).where(eq(registryPackages.id, id)).get())!;
}

export function versionPrefix(packageId: string, versionId: string): string {
  return `pkg/${packageId}/${versionId}/`;
}

/** Where the bytes of an asset live: `pkg/<package_id>/<version_id>/<asset_name>`. */
export function assetBlobKey(packageId: string, versionId: string, assetName: string): string {
  return `${versionPrefix(packageId, versionId)}${assetName}`;
}

/** A multipart upload as the blob store knows it. */
export interface StoredUpload {
  /** The key the finished object goes to. */
  readonly key: string;
  readonly r2UploadId: string;
}

/** The multipart uploads in flight under a package, or under one version. */
export async function inFlightUploads(db: AppDatabase, scope: { packageId: string } | { versionId: string }): Promise<StoredUpload[]> {
  const rows = await db
    .select({ packageId: registryVersions.packageId, versionId: registryUploads.versionId, assetName: registryUploads.assetName, r2UploadId: registryUploads.r2UploadId })
    .from(registryUploads)
    .innerJoin(registryVersions, eq(registryVersions.id, registryUploads.versionId))
    .where("versionId" in scope ? eq(registryUploads.versionId, scope.versionId) : eq(registryVersions.packageId, scope.packageId))
    .all();
  return rows.map(row => ({ key: assetBlobKey(row.packageId, row.versionId, row.assetName), r2UploadId: row.r2UploadId }));
}

/**
 * Discard the parts the store holds for each upload. Neither `deletePrefix`
 * nor the cascade that removes the rows does it, so every path that drops
 * upload rows calls this for them.
 *
 * Best effort: an upload the store no longer knows cannot be told from one
 * it failed to abort, and neither may keep a row, and the quota it reserves,
 * from going away.
 */
export async function abortUploadsInStore(store: BlobStore, uploads: readonly StoredUpload[]): Promise<void> {
  for (const upload of uploads)
    await store.abortMultipart(upload.key, upload.r2UploadId).catch(() => {});
}

/** Remove the stored bytes of a package: its assets and the parts of its unfinished uploads. */
export async function deletePackageBlobs(db: AppDatabase, config: BlobStoreConfig, packageId: string): Promise<void> {
  const store = getActiveBlobStore(config);
  await abortUploadsInStore(store, await inFlightUploads(db, { packageId }));
  await store.deletePrefix(`pkg/${packageId}/`);
}

/**
 * Record the ids of the package's versions that were ever published — all of
 * them, or the one named — as retired, ahead of their deletion.
 */
export async function retireVersions(tx: Parameters<Parameters<AppDatabase["transaction"]>[0]>[0], packageId: string, versionId?: string): Promise<void> {
  const rows = await tx
    .select({ namespaceId: registryPackages.namespaceId, packageSlug: registryPackages.slug, version: registryVersions.version })
    .from(registryVersions)
    .innerJoin(registryPackages, eq(registryPackages.id, registryVersions.packageId))
    .where(and(
      eq(registryVersions.packageId, packageId),
      ne(registryVersions.status, "draft"),
      versionId === undefined ? undefined : eq(registryVersions.id, versionId),
    ))
    .all();
  // Stays well below the 100 bound parameters a Durable Object query takes.
  for (let i = 0; i < rows.length; i += 25)
    await tx.insert(registryRetiredVersions).values(rows.slice(i, i + 25)).onConflictDoNothing().run();
}

/** Delete a package with everything that hangs off it, its stored bytes and its policy tuples. */
export async function deletePackage(db: AppDatabase, id: string, config: BlobStoreConfig): Promise<void> {
  await deletePackageBlobs(db, config, id);
  await db.transaction(async (tx) => {
    await retireVersions(tx, id);
    // Versions, assets, channels, uploads and token grants cascade.
    await tx.delete(registryPackages).where(eq(registryPackages.id, id)).run();
  });
  await packageAccess.cascadeDelete(db, id);
}
