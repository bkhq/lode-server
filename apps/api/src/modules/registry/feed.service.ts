import type { RegistryPackage } from "./access";
import type { RegistryAsset, RegistryVersion } from "./release.service";
import type { AppDatabase } from "@/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { registryAssets, registryChannels, registryVersions } from "./schema";

/** One asset of a `lode/v1` manifest. Optional fields are left out when absent, never null. */
export interface ManifestAsset {
  name: string;
  url: string;
  sha256: string;
  size: number;
  sig?: string;
  key_id?: string;
  alg?: string;
  run?: string;
  exec?: string;
}

/**
 * The `lode/v1` manifest as lode's `manifest.rs` reads it. The top-level
 * `key_id` / `sig` and `expires` / `expires_sig` are the publisher's
 * signature over the catalog; `buildManifest` never sets them, see
 * `withManifestSignature`.
 */
export interface Manifest {
  schema: "lode/v1";
  name: string;
  key_id?: string;
  sig?: string;
  /** Unix seconds. */
  expires?: number;
  expires_sig?: string;
  channels: Record<string, { latest: string }>;
  versions: Record<string, { notes?: string; assets: ManifestAsset[] }>;
}

// Stays well below the 100 bound parameters a Durable Object query takes.
const ID_CHUNK = 50;

const newestFirst = [desc(registryVersions.publishedAt), desc(registryVersions.createdAt), desc(registryVersions.id)];

/**
 * Generate the manifest of a package: its published versions, newest first,
 * capped at `maxVersions` — plus the target of every channel, however old,
 * since a channel must resolve. Drafts and yanked versions never appear.
 *
 * `assetBase` is the absolute URL of the package in the feed, without a
 * trailing slash; asset urls are `<assetBase>/<version>/<asset>`.
 */
export async function buildManifest(db: AppDatabase, pkg: RegistryPackage, opts: { maxVersions: number; assetBase: string }): Promise<Manifest> {
  const published = and(eq(registryVersions.packageId, pkg.id), eq(registryVersions.status, "published"));
  const newest = await db.select().from(registryVersions).where(published).orderBy(...newestFirst).limit(opts.maxVersions).all();
  // Only a published version can be a channel target, and one cannot be
  // yanked while a channel points at it; the filter is a second guard.
  const pointers = await db
    .select({ name: registryChannels.name, version: registryVersions })
    .from(registryChannels)
    .innerJoin(registryVersions, eq(registryVersions.id, registryChannels.versionId))
    .where(and(eq(registryChannels.packageId, pkg.id), eq(registryVersions.status, "published")))
    .orderBy(asc(registryChannels.name))
    .all();

  const versions = new Map<string, RegistryVersion>(newest.map(version => [version.id, version]));
  for (const pointer of pointers)
    versions.set(pointer.version.id, pointer.version);

  const assets = new Map<string, RegistryAsset[]>();
  const ids = [...versions.keys()];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const rows = await db.select().from(registryAssets).where(inArray(registryAssets.versionId, ids.slice(i, i + ID_CHUNK))).orderBy(asc(registryAssets.name)).all();
    for (const row of rows)
      assets.set(row.versionId, [...(assets.get(row.versionId) ?? []), row]);
  }

  const manifest: Manifest = { schema: "lode/v1", name: pkg.slug, channels: {}, versions: {} };
  for (const pointer of pointers)
    manifest.channels[pointer.name] = { latest: pointer.version.version };
  for (const version of versions.values()) {
    manifest.versions[version.version] = {
      ...(version.notes !== null && { notes: version.notes }),
      assets: (assets.get(version.id) ?? []).map(asset => ({
        name: asset.name,
        url: `${opts.assetBase}/${encodeURIComponent(version.version)}/${encodeURIComponent(asset.name)}`,
        sha256: asset.sha256,
        size: asset.size,
        ...(asset.sig !== null && { sig: asset.sig }),
        ...(asset.keyId !== null && { key_id: asset.keyId }),
        ...(asset.alg !== null && { alg: asset.alg }),
        ...(asset.run !== null && { run: asset.run }),
        ...(asset.exec !== null && { exec: asset.exec }),
      })),
    };
  }
  return manifest;
}

/** The asset `name` of the published version `version`, or undefined: a draft's or a yanked version's asset is not served. */
export async function findPublishedAsset(db: AppDatabase, packageId: string, version: string, name: string): Promise<RegistryAsset | undefined> {
  const row = await db
    .select({ asset: registryAssets })
    .from(registryAssets)
    .innerJoin(registryVersions, eq(registryVersions.id, registryAssets.versionId))
    .where(and(
      eq(registryVersions.packageId, packageId),
      eq(registryVersions.version, version),
      eq(registryVersions.status, "published"),
      eq(registryAssets.name, name),
    ))
    .get();
  return row?.asset;
}
