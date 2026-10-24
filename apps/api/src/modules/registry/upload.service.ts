import type { PackageRequest, RegistryUpload, UploadRequest } from "./access";
import type { BlobPart, BlobStoreConfig } from "./blob";
import type { getEffectiveQuota } from "./registry.service";
import type { AssetDeclaration, RegistryAsset } from "./release.service";
import type { AppDatabase } from "@/db";
import { and, asc, eq, lte } from "drizzle-orm";
import { AppError, NotFoundError } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";
import { BlobMultipartError, BlobPutError, getActiveBlobStore, sha256OfBlob } from "./blob";
import { signingKeys } from "./delegation.service";
import { abortUploadsInStore, assetBlobKey } from "./registry.service";
import { admitUpload, claim, notDraft, requireDraft, storedRuntime } from "./release.service";
import { registryAssets, registryUploads, registryVersions } from "./schema";

type UploadConfig = BlobStoreConfig & Parameters<typeof getEffectiveQuota>[2] & { REGISTRY_UPLOAD_TTL_SECONDS: number };

/**
 * Size of every part but the last: 64 MiB, so a part request stays under the
 * Workers body cap on any plan and a 500 MiB asset is 8 parts. Fixed by the
 * server; R2 would refuse non-final parts under 5 MiB.
 */
export const MULTIPART_PART_SIZE = 64 * 1024 * 1024;

let partSize = MULTIPART_PART_SIZE;

/** Test-only: a part size small enough for fast tests on the local store; undefined restores the real one. */
export function __setPartSizeForTests(size: number | undefined): void {
  partSize = size ?? MULTIPART_PART_SIZE;
}

function partCountOf(size: number): number {
  return Math.ceil(size / partSize);
}

function partsOf(upload: Pick<RegistryUpload, "parts">): BlobPart[] {
  return JSON.parse(upload.parts) as BlobPart[];
}

function unusable(): AppError {
  return new AppError("The stored parts of this upload are no longer usable: start the upload again", 409, "UPLOAD_UNUSABLE");
}

function expired(upload: Pick<RegistryUpload, "expiresAt">): boolean {
  return Date.parse(upload.expiresAt) <= Date.now();
}

// The sweep would have removed it; a request that gets there first does the
// same, so an upload past its time never grows or completes.
function uploadExpired(): AppError {
  return new AppError("This upload has expired and was discarded: start it again", 409, "UPLOAD_EXPIRED");
}

async function isActiveKey(db: AppDatabase, packageId: string, keyId: string): Promise<boolean> {
  return (await signingKeys(db, packageId)).some(key => key.keyId === keyId);
}

export interface StartedUpload {
  readonly upload: RegistryUpload;
  readonly partSize: number;
  readonly partCount: number;
}

/**
 * Open a multipart upload for one asset of a draft. The declared size is
 * held against the owner's quota from here on: the `registry_uploads` row is
 * the reservation.
 *
 * An upload of the same asset name still in flight is given up first, so
 * that its reservation does not count against the one replacing it. That
 * holds even when the new start is then refused.
 */
export async function startUpload(db: AppDatabase, config: UploadConfig, target: PackageRequest, input: AssetDeclaration): Promise<StartedUpload> {
  const { package: pkg } = target;
  const version = await requireDraft(db, pkg.id, input.version);
  const store = getActiveBlobStore(config);
  const key = assetBlobKey(pkg.id, version.id, input.name);
  const release = claim(version.id, input.name);
  try {
    // The version was read before the claim.
    await requireDraft(db, pkg.id, input.version);

    const sameName = and(eq(registryUploads.versionId, version.id), eq(registryUploads.assetName, input.name));
    const previous = await db.select().from(registryUploads).where(sameName).all();
    await abortUploadsInStore(store, previous.map(upload => ({ key, r2UploadId: upload.r2UploadId })));
    await db.delete(registryUploads).where(sameName).run();

    const signed = await admitUpload(db, config, target, input);

    const { uploadId: r2UploadId } = await store.createMultipart(key);
    try {
      const upload = await db.insert(registryUploads).values({
        id: nanoid(),
        versionId: version.id,
        assetName: input.name,
        size: input.size,
        sha256: input.sha256,
        sig: signed && input.sig,
        keyId: signed?.keyId ?? null,
        alg: signed?.alg ?? null,
        run: input.run,
        exec: input.exec,
        runtime: storedRuntime(input.runtime),
        r2UploadId,
        expiresAt: new Date(Date.now() + config.REGISTRY_UPLOAD_TTL_SECONDS * 1000).toISOString(),
      }).returning().get();
      return { upload, partSize, partCount: partCountOf(input.size) };
    }
    catch (err) {
      await abortUploadsInStore(store, [{ key, r2UploadId }]);
      throw err;
    }
  }
  finally {
    release();
  }
}

/**
 * Store part `n` of an upload from a request body of `size` bytes, replacing
 * an earlier upload of the same part. Everything is checked before the body
 * is touched; the body then goes to the blob store as is. An upload past
 * its `expires_at` is given up instead.
 */
export async function putUploadPart(db: AppDatabase, config: BlobStoreConfig, target: UploadRequest, n: number, size: number, body: ReadableStream<Uint8Array>): Promise<void> {
  const { upload, version, package: pkg } = target;
  if (expired(upload)) {
    await abortUpload(db, config, target);
    throw uploadExpired();
  }
  if (version.status !== "draft")
    throw notDraft(version.version);
  const count = partCountOf(upload.size);
  if (n < 1 || n > count)
    throw new AppError(`This upload has parts 1 to ${count}`, 422, "INVALID_PART_NUMBER");
  // Every part is full but the last, which is the remainder.
  const expected = n < count ? partSize : upload.size - (count - 1) * partSize;
  if (size !== expected)
    throw new AppError(`Part ${n} of this upload must be exactly ${expected} bytes`, 422, "INVALID_PART_SIZE");

  let etag: string;
  try {
    ({ etag } = await getActiveBlobStore(config).putPart(assetBlobKey(pkg.id, version.id, upload.assetName), upload.r2UploadId, n, body, size));
  }
  catch (err) {
    // Nothing was stored, and an earlier upload of this part still counts.
    if (err instanceof BlobPutError)
      throw new AppError("The part was not stored: its body did not arrive whole or does not match Content-Length", 422, "PART_REJECTED");
    if (err instanceof BlobMultipartError)
      throw unusable();
    throw err;
  }

  // Parts arrive in parallel: the list is read and written in one transaction.
  const recorded = await db.transaction(async (tx) => {
    const current = await tx.select({ parts: registryUploads.parts }).from(registryUploads).where(eq(registryUploads.id, upload.id)).get();
    if (!current)
      return false;
    const parts = [...partsOf(current).filter(part => part.partNumber !== n), { partNumber: n, etag }].sort((a, b) => a.partNumber - b.partNumber);
    await tx.update(registryUploads).set({ parts: JSON.stringify(parts) }).where(eq(registryUploads.id, upload.id)).run();
    return true;
  });
  // Aborted or completed while the part was streaming.
  if (!recorded)
    throw new NotFoundError("Upload");
}

/**
 * Assemble the parts into the asset and verify it.
 *
 * The store checks parts one by one, never the assembled object, so the
 * object is read back through SHA-256 and compared with the digest declared
 * at start. Only after a match does the asset row appear, in one transaction
 * with the removal of the upload row; anything else deletes the object and
 * the upload. An asset of the same name is replaced, as the single-request
 * upload does.
 */
export async function completeUpload(db: AppDatabase, config: BlobStoreConfig, target: UploadRequest): Promise<{ asset: RegistryAsset; replaced: boolean }> {
  const { version, package: pkg } = target;
  const store = getActiveBlobStore(config);
  const key = assetBlobKey(pkg.id, version.id, target.upload.assetName);
  const thisUpload = eq(registryUploads.id, target.upload.id);
  const release = claim(version.id, target.upload.assetName);
  try {
    // Both were read before the claim.
    const upload = await db.select().from(registryUploads).where(thisUpload).get();
    if (!upload)
      throw new NotFoundError("Upload");
    if (expired(upload)) {
      await abortUploadsInStore(store, [{ key, r2UploadId: upload.r2UploadId }]);
      await db.delete(registryUploads).where(thisUpload).run();
      throw uploadExpired();
    }
    const current = await db.select({ status: registryVersions.status }).from(registryVersions).where(eq(registryVersions.id, version.id)).get();
    // Assembling would replace the bytes of a published asset of that name.
    if (current?.status !== "draft") {
      await abortUploadsInStore(store, [{ key, r2UploadId: upload.r2UploadId }]);
      await db.delete(registryUploads).where(thisUpload).run();
      throw notDraft(version.version);
    }
    // The signature was checked at start; its key may have been revoked, or its delegation lapsed, since.
    if (upload.keyId !== null && !(await isActiveKey(db, pkg.id, upload.keyId))) {
      await abortUploadsInStore(store, [{ key, r2UploadId: upload.r2UploadId }]);
      await db.delete(registryUploads).where(thisUpload).run();
      throw new AppError("The key this upload was signed with is no longer a signing key of the package", 400, "INVALID_SIGNATURE");
    }

    const parts = partsOf(upload);
    const count = partCountOf(upload.size);
    if (parts.length !== count) {
      const missing = Array.from({ length: count }, (_, i) => i + 1).filter(n => !parts.some(part => part.partNumber === n));
      throw new AppError(`Not every part was uploaded; missing: ${missing.join(", ")}`, 409, "UPLOAD_INCOMPLETE");
    }

    try {
      await store.completeMultipart(key, upload.r2UploadId, parts);
    }
    catch (err) {
      // Nothing was assembled, and an asset of that name is still intact.
      if (err instanceof BlobMultipartError) {
        await abortUploadsInStore(store, [{ key, r2UploadId: upload.r2UploadId }]);
        await db.delete(registryUploads).where(thisUpload).run();
        throw unusable();
      }
      throw err;
    }

    // From here the bytes at the key are the new, unverified ones: whatever
    // goes wrong, they go, with any row of that name, rather than be served.
    const sameName = and(eq(registryAssets.versionId, version.id), eq(registryAssets.name, upload.assetName));
    try {
      // No object at all counts as a mismatch.
      if (await sha256OfBlob(store, key) !== upload.sha256)
        throw new AppError("The assembled parts do not match the sha256 declared when the upload started", 422, "DIGEST_MISMATCH");

      return await db.transaction(async (tx) => {
        const now = await tx.select({ status: registryVersions.status }).from(registryVersions).where(eq(registryVersions.id, version.id)).get();
        if (now?.status !== "draft")
          throw notDraft(version.version);
        const replaced = await tx.delete(registryAssets).where(sameName).returning({ id: registryAssets.id }).get();
        const asset = await tx.insert(registryAssets).values({
          id: nanoid(),
          versionId: version.id,
          name: upload.assetName,
          size: upload.size,
          sha256: upload.sha256,
          sig: upload.sig,
          keyId: upload.keyId,
          alg: upload.alg,
          run: upload.run,
          exec: upload.exec,
          runtime: upload.runtime,
          blobKey: key,
        }).returning().get();
        await tx.delete(registryUploads).where(thisUpload).run();
        return { asset, replaced: replaced !== undefined };
      });
    }
    catch (err) {
      await store.delete(key);
      await db.delete(registryAssets).where(sameName).run();
      await db.delete(registryUploads).where(thisUpload).run();
      throw err;
    }
  }
  finally {
    release();
  }
}

/** Give an upload up: its parts and its quota reservation go. */
export async function abortUpload(db: AppDatabase, config: BlobStoreConfig, target: UploadRequest): Promise<void> {
  const { upload, version, package: pkg } = target;
  const release = claim(version.id, upload.assetName);
  try {
    await abortUploadsInStore(getActiveBlobStore(config), [{ key: assetBlobKey(pkg.id, version.id, upload.assetName), r2UploadId: upload.r2UploadId }]);
    await db.delete(registryUploads).where(eq(registryUploads.id, upload.id)).run();
  }
  finally {
    release();
  }
}

const SWEEP_BATCH = 500;

/**
 * One pass of the expired-upload sweep: abort up to `limit` uploads whose
 * `expires_at` has passed and remove their rows, which frees the quota they
 * reserved. Returns how many went. `now` is a parameter for the tests.
 */
export async function runUploadSweepOnce(db: AppDatabase, config: BlobStoreConfig, now: Date = new Date(), limit = SWEEP_BATCH): Promise<number> {
  const expired = await db
    .select({ id: registryUploads.id, packageId: registryVersions.packageId, versionId: registryUploads.versionId, assetName: registryUploads.assetName, r2UploadId: registryUploads.r2UploadId })
    .from(registryUploads)
    .innerJoin(registryVersions, eq(registryVersions.id, registryUploads.versionId))
    .where(lte(registryUploads.expiresAt, now.toISOString()))
    .orderBy(asc(registryUploads.expiresAt))
    .limit(limit)
    .all();
  const store = getActiveBlobStore(config);
  let swept = 0;
  for (const upload of expired) {
    let release: () => void;
    try {
      release = claim(upload.versionId, upload.assetName);
    }
    catch {
      // Being completed or replaced right now; the next pass sees what is left.
      continue;
    }
    try {
      await abortUploadsInStore(store, [{ key: assetBlobKey(upload.packageId, upload.versionId, upload.assetName), r2UploadId: upload.r2UploadId }]);
      await db.delete(registryUploads).where(eq(registryUploads.id, upload.id)).run();
      swept++;
    }
    finally {
      release();
    }
  }
  return swept;
}
