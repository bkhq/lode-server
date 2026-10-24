import type { RegistryPackage } from "./access";
import type { Manifest, ManifestAsset } from "./feed.service";
import type { RegistryAsset, RegistryVersion } from "./release.service";
import type { RuntimeSpec } from "./validate";
import type { AppDatabase } from "@/db";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import { z } from "zod";
import { AppError, isUniqueViolation } from "@/shared/lib/errors";
import { signingKeys } from "./delegation.service";
import { buildManifest } from "./feed.service";
import { claim, parseRuntime } from "./release.service";
import { registryAssets, registryChannels, registryCommits, registryVersions } from "./schema";
import { canonicalCatalog, manifestCommitMessage, manifestMessage, verifyEd25519 } from "./signature";
import { idError, runtimeSpecError } from "./validate";

// A package whose publisher uploads signed manifests: every upload is a
// commit on top of the head, and the feed serves the head as it was signed.
// The registry checks a commit and stores it; it never changes one.

export type RegistryCommit = typeof registryCommits.$inferSelect;

/** What a commit holds, for listing: its channels and versions, and the versions it adds and drops against its parent. */
export interface CommitSummary {
  readonly channels: Record<string, string>;
  readonly versions: string[];
  readonly added: string[];
  readonly dropped: string[];
}

/** The manifest the next commit is built on: the head, or the generated manifest of a package without commits. */
export interface CommitBase {
  readonly commit: string | null;
  readonly generation: number;
  readonly manifest: Manifest;
}

function idSchema(kind: string) {
  return z.string().superRefine((value, ctx) => {
    const message = idError(kind, value);
    if (message !== undefined)
      ctx.addIssue({ code: "custom", message });
  });
}

const RE_SHA256 = /^[0-9a-f]{64}$/;
const optionalText = z.string().min(1).max(4096).optional();

const runtimeSchema = z.object({
  runtime: z.string().max(128),
  version: z.string().max(256).optional(),
  version_check: z.string().max(256).optional(),
  download: z.string().max(2048).optional(),
  sha256: z.string().max(64).optional(),
}).superRefine((rt, ctx) => {
  const message = runtimeSpecError(rt);
  if (message !== undefined)
    ctx.addIssue({ code: "custom", message });
});

const commitAssetSchema = z.object({
  name: idSchema("asset name"),
  sha256: z.string().regex(RE_SHA256, "sha256 must be 64 lowercase hex characters"),
  sig: z.string().min(1).max(512).optional(),
  key_id: z.string().max(64).optional(),
  alg: z.string().max(32).optional(),
  run: optionalText,
  exec: optionalText,
  runtime: runtimeSchema.optional(),
});

/** A commit as `lode-cli` uploads it. Fields the registry does not keep (asset `url` / `size`, `expires`, `delegation`) are dropped. */
export const commitBodySchema = z.object({
  schema: z.literal("lode/v1"),
  name: z.string(),
  key_id: z.string().regex(/^[0-9a-f]{16}$/, "key_id is 16 lowercase hex characters"),
  alg: z.string().max(32).optional(),
  sig: z.string().min(1).max(512),
  commit_sig: z.string().min(1).max(512),
  generation: z.number().int().positive(),
  parent: z.string().regex(RE_SHA256, "parent is a commit id: 64 lowercase hex characters").optional(),
  created: z.string().min(1).max(64),
  channels: z.record(idSchema("channel"), z.object({ latest: z.string() })),
  versions: z.record(idSchema("version"), z.object({
    notes: z.string().max(20000).optional(),
    assets: z.array(commitAssetSchema).min(1).max(100),
  })),
});

export type CommitBody = z.infer<typeof commitBodySchema>;

function invalid(message: string): AppError {
  return new AppError(message, 400, "INVALID_COMMIT");
}

function conflict(message: string): AppError {
  return new AppError(message, 409, "COMMIT_CONFLICT");
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function headCommit(db: AppDatabase, packageId: string): Promise<RegistryCommit | undefined> {
  return await db.select().from(registryCommits).where(eq(registryCommits.packageId, packageId)).orderBy(desc(registryCommits.generation)).limit(1).get();
}

/** The package's commits, newest first. */
export async function listCommits(db: AppDatabase, packageId: string, limit: number): Promise<RegistryCommit[]> {
  return await db.select().from(registryCommits).where(eq(registryCommits.packageId, packageId)).orderBy(desc(registryCommits.generation)).limit(limit).all();
}

export function commitSummary(commit: RegistryCommit): CommitSummary {
  return JSON.parse(commit.summary) as CommitSummary;
}

/** Refuse a change the head's signature would not cover: such a package changes through commits only. */
export async function assertNoCommits(db: AppDatabase, packageId: string, instead: string): Promise<void> {
  if (await headCommit(db, packageId))
    throw new AppError(`This package's manifest is a signed commit: ${instead}`, 409, "PACKAGE_USES_COMMITS");
}

export async function commitBase(db: AppDatabase, pkg: RegistryPackage, maxVersions: number): Promise<CommitBase> {
  const head = await headCommit(db, pkg.id);
  if (head)
    return { commit: head.id, generation: head.generation, manifest: await withAssetSignatures(db, pkg.id, JSON.parse(head.manifest) as Manifest) };
  return { commit: null, generation: 0, manifest: await buildManifest(db, pkg, { maxVersions, assetBase: "" }) };
}

/**
 * Set each asset's `sig` / `key_id` / `alg` from its stored row. The catalog
 * the commit signs leaves them out, so a re-signed asset is served with its
 * new signature.
 */
async function withAssetSignatures(db: AppDatabase, packageId: string, manifest: Manifest): Promise<Manifest> {
  const names = Object.keys(manifest.versions);
  if (names.length === 0)
    return manifest;
  const rows = await db
    .select({ version: registryVersions.version, name: registryAssets.name, sig: registryAssets.sig, keyId: registryAssets.keyId, alg: registryAssets.alg })
    .from(registryAssets)
    .innerJoin(registryVersions, eq(registryAssets.versionId, registryVersions.id))
    .where(and(eq(registryVersions.packageId, packageId), inArray(registryVersions.version, names)))
    .all();
  for (const [version, entry] of Object.entries(manifest.versions)) {
    for (const asset of entry.assets) {
      const row = rows.find(r => r.version === version && r.name === asset.name);
      if (!row)
        continue;
      delete asset.sig;
      delete asset.key_id;
      delete asset.alg;
      if (row.sig !== null)
        Object.assign(asset, { sig: row.sig, key_id: row.keyId, alg: row.alg });
    }
  }
  return manifest;
}

/** The head as the feed serves it: asset urls under `assetBase`, signatures as stored. */
export async function servedCommit(db: AppDatabase, head: RegistryCommit, assetBase: string): Promise<Manifest> {
  const manifest = await withAssetSignatures(db, head.packageId, JSON.parse(head.manifest) as Manifest);
  for (const [version, entry] of Object.entries(manifest.versions)) {
    for (const asset of entry.assets)
      asset.url = `${assetBase}/${encodeURIComponent(version)}/${encodeURIComponent(asset.name)}`;
  }
  return manifest;
}

function sameRuntime(a: RuntimeSpec | null | undefined, b: RuntimeSpec | null | undefined): boolean {
  const fields = (rt: RuntimeSpec | null | undefined) => rt ? [rt.runtime, rt.version, rt.version_check, rt.download, rt.sha256] : null;
  return JSON.stringify(fields(a)) === JSON.stringify(fields(b));
}

/** Why `asset` does not describe the stored `row`, or undefined when it does. */
function assetMismatch(version: string, asset: CommitBody["versions"][string]["assets"][number], row: RegistryAsset): string | undefined {
  const differs = (field: string) => `${version}/${asset.name}: its ${field} differs from the uploaded asset`;
  if (asset.sha256 !== row.sha256)
    return differs("sha256");
  if ((asset.run ?? null) !== row.run || (asset.exec ?? null) !== row.exec)
    return differs("run / exec");
  if (!sameRuntime(asset.runtime, parseRuntime(row.runtime)))
    return differs("runtime");
  return undefined;
}

/**
 * Check `body` against what the registry holds and return the manifest to
 * store (asset sizes and signatures from the stored rows, no urls) with the
 * versions it names.
 */
async function checkCommit(db: AppDatabase, pkg: RegistryPackage, body: CommitBody): Promise<{ manifest: Manifest; versions: RegistryVersion[] }> {
  if ((body.generation === 1) !== (body.parent === undefined))
    throw invalid("Generation 1 has no parent; every later generation names its parent");
  const names = Object.keys(body.versions);
  if (names.length === 0 || Object.keys(body.channels).length === 0)
    throw invalid("A manifest needs at least one channel and one version");
  for (const [channel, { latest }] of Object.entries(body.channels)) {
    if (!(latest in body.versions))
      throw invalid(`Channel ${channel} points at ${latest}, which the manifest does not have`);
  }

  const versions = await db.select().from(registryVersions).where(and(eq(registryVersions.packageId, pkg.id), inArray(registryVersions.version, names))).all();
  const rows = versions.length === 0
    ? []
    : await db.select().from(registryAssets).where(inArray(registryAssets.versionId, versions.map(v => v.id))).all();
  const manifest: Manifest = {
    schema: "lode/v1",
    name: body.name,
    key_id: body.key_id,
    ...(body.alg !== undefined && { alg: body.alg }),
    sig: body.sig,
    parent: body.parent,
    generation: body.generation,
    created: body.created,
    commit_sig: body.commit_sig,
    channels: body.channels,
    versions: {},
  };
  for (const [name, entry] of Object.entries(body.versions)) {
    const version = versions.find(v => v.version === name);
    if (!version)
      throw invalid(`Version ${name} has not been uploaded`);
    const stored = rows.filter(row => row.versionId === version.id);
    if (stored.length !== entry.assets.length || new Set(entry.assets.map(a => a.name)).size !== entry.assets.length)
      throw invalid(`Version ${name} lists other assets than were uploaded`);
    const assets: ManifestAsset[] = [];
    for (const asset of entry.assets) {
      const row = stored.find(r => r.name === asset.name);
      const mismatch = row ? assetMismatch(name, asset, row) : `${name}/${asset.name} has not been uploaded`;
      if (mismatch !== undefined)
        throw invalid(mismatch);
      assets.push({
        name: asset.name,
        url: "",
        sha256: asset.sha256,
        size: row!.size,
        ...(row!.sig !== null && { sig: row!.sig, key_id: row!.keyId!, alg: row!.alg! }),
        ...(asset.run !== undefined && { run: asset.run }),
        ...(asset.exec !== undefined && { exec: asset.exec }),
        ...(asset.runtime !== undefined && { runtime: asset.runtime }),
      });
    }
    manifest.versions[name] = { ...(entry.notes !== undefined && { notes: entry.notes }), assets };
  }
  return { manifest, versions };
}

/** The key of the package both signatures of `body` verify under, if any. */
async function verifyCommit(db: AppDatabase, packageId: string, body: CommitBody, commitMessage: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const catalogMessage = manifestMessage(body.name, body.key_id, canonicalCatalog(body));
  for (const key of await signingKeys(db, packageId)) {
    if (await verifyEd25519(key.publicKey, body.sig, catalogMessage) && await verifyEd25519(key.publicKey, body.commit_sig, commitMessage))
      return true;
  }
  return false;
}

function summarize(manifest: Manifest, parent: RegistryCommit | undefined): CommitSummary {
  const versions = Object.keys(manifest.versions).sort();
  const before = parent ? commitSummary(parent).versions : [];
  return {
    channels: Object.fromEntries(Object.entries(manifest.channels).map(([name, { latest }]) => [name, latest])),
    versions,
    added: versions.filter(v => !before.includes(v)),
    dropped: before.filter(v => !versions.includes(v)),
  };
}

/**
 * Store a commit and make it the head: its parent must be the head (409
 * `COMMIT_CONFLICT` otherwise), both signatures must verify under a signing
 * key of the package, and every version must match what was uploaded. Drafts
 * it names are published and the channel pointers follow it. A commit stored
 * already is answered as it is, with `created` false.
 */
export async function uploadCommit(db: AppDatabase, pkg: RegistryPackage, body: CommitBody): Promise<{ commit: RegistryCommit; created: boolean }> {
  const commitMessage = manifestCommitMessage(body.name, body.key_id, body.generation, body.parent ?? "", body.created, canonicalCatalog(body));
  const id = await sha256Hex(commitMessage);
  const existing = await db.select().from(registryCommits).where(and(eq(registryCommits.packageId, pkg.id), eq(registryCommits.id, id))).get();
  if (existing)
    return { commit: existing, created: false };

  if (body.name !== pkg.slug)
    throw invalid(`The manifest is for "${body.name}", not this package's slug "${pkg.slug}"`);
  const head = await headCommit(db, pkg.id);
  if ((body.parent ?? null) !== (head?.id ?? null) || body.generation !== (head?.generation ?? 0) + 1)
    throw conflict(head ? `The head is commit ${head.generation} (${head.id}); build on it` : "The package has no commits yet: the first is generation 1 without a parent");
  if (!(await verifyCommit(db, pkg.id, body, commitMessage)))
    throw new AppError("The commit's signatures do not verify under any signing key of the package", 400, "INVALID_SIGNATURE");
  const { manifest, versions } = await checkCommit(db, pkg, body);

  const drafts = versions.filter(v => v.status === "draft");
  const releases = drafts.map(v => claim(v.id));
  try {
    const row = {
      packageId: pkg.id,
      id,
      parent: body.parent ?? null,
      generation: body.generation,
      created: body.created,
      keyId: body.key_id,
      manifest: JSON.stringify(manifest),
      summary: JSON.stringify(summarize(manifest, head)),
    };
    const commit = await db.transaction(async (tx) => {
      const inserted = await tx.insert(registryCommits).values(row).returning().get();
      if (drafts.length > 0)
        await tx.update(registryVersions).set({ status: "published", publishedAt: new Date().toISOString() }).where(and(inArray(registryVersions.id, drafts.map(v => v.id)), eq(registryVersions.status, "draft"))).run();
      const channels = Object.entries(manifest.channels);
      await tx.delete(registryChannels).where(and(eq(registryChannels.packageId, pkg.id), notInArray(registryChannels.name, channels.map(([name]) => name)))).run();
      for (const [name, { latest }] of channels) {
        const versionId = versions.find(v => v.version === latest)!.id;
        await tx.insert(registryChannels).values({ packageId: pkg.id, name, versionId }).onConflictDoUpdate({ target: [registryChannels.packageId, registryChannels.name], set: { versionId, updatedAt: new Date().toISOString() } }).run();
      }
      return inserted;
    });
    return { commit, created: true };
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw conflict("Another commit landed first; build on the new head");
    throw err;
  }
  finally {
    for (const release of releases)
      release();
  }
}
