import type { Context } from "hono";
import type { RegistryNamespace, RegistryPackage } from "./access";
import type { EffectiveQuota, Usage } from "./registry.service";
import type { ChannelPointer, RegistryAsset, VersionWithAssets } from "./release.service";
import type { AppEnv } from "@/shared/lib/types";
import { z } from "zod";
import { getClientIp } from "@/shared/lib/client-ip";

// Wire shapes shared by the module's route files. Field names follow the
// plan's column names (`key_id`, `require_signature`), so a field reads the
// same in a request body and in a response.

// `slug` is the namespace's public id, the `:ns` path segment.
export const namespaceSchema = z.object({
  slug: z.string(),
  status: z.enum(["active", "suspended"]),
  created_at: z.string(),
});

export const packageSchema = z.object({
  id: z.string(),
  namespace: z.string(),
  slug: z.string(),
  name: z.string(),
  visibility: z.enum(["public", "private"]),
  description: z.string().nullable(),
  require_signature: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const limitsSchema = z.object({
  max_packages: z.number(),
  max_storage_bytes: z.number(),
  max_asset_bytes: z.number(),
});

export const usageSchema = z.object({
  packages: z.number(),
  storage_bytes: z.number(),
});

export const grantLevelSchema = z.enum(["read", "write", "admin"]);

/** Either one level for every package the owner has, or a level per package. */
export const grantsSchema = z.union([
  z.strictObject({ all: grantLevelSchema }),
  z.array(z.strictObject({ package: z.string(), access: grantLevelSchema }))
    .max(200)
    .refine(list => new Set(list.map(g => g.package)).size === list.length, "A package is listed more than once"),
]);

export const tokenSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  prefix: z.string(),
  grants: grantsSchema,
  expires_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  created_at: z.string(),
});

// `sig`, `key_id` and `alg` are null together, for an unsigned asset.
export const assetSchema = z.object({
  name: z.string(),
  size: z.number(),
  sha256: z.string(),
  sig: z.string().nullable(),
  key_id: z.string().nullable(),
  alg: z.string().nullable(),
  run: z.string().nullable(),
  exec: z.string().nullable(),
  created_at: z.string(),
});

export const versionSchema = z.object({
  id: z.string(),
  version: z.string(),
  status: z.enum(["draft", "published", "yanked"]),
  notes: z.string().nullable(),
  published_at: z.string().nullable(),
  created_at: z.string(),
  assets: z.array(assetSchema),
});

// `version` is the version string the pointer resolves to.
export const channelSchema = z.object({
  name: z.string(),
  version: z.string(),
  updated_at: z.string(),
});

// `expires` is Unix seconds, as in the manifest; null when the publisher stamped none.
export const manifestSignatureSchema = z.object({
  key_id: z.string(),
  expires: z.number().nullable(),
  status: z.enum(["live", "stale", "expired", "revoked"]),
  updated_at: z.string(),
});

/** Reports the message of one of the validators in `validate.ts` as an issue of the field. */
export function check(error: (value: string) => string | undefined) {
  return (value: string, ctx: z.RefinementCtx) => {
    const message = error(value);
    if (message !== undefined)
      ctx.addIssue({ code: "custom", message });
  };
}

export function namespaceView(ns: RegistryNamespace): z.infer<typeof namespaceSchema> {
  return { slug: ns.slug, status: ns.status, created_at: ns.createdAt };
}

export function packageView(namespace: RegistryNamespace, pkg: RegistryPackage): z.infer<typeof packageSchema> {
  return {
    id: pkg.id,
    namespace: namespace.slug,
    slug: pkg.slug,
    name: pkg.name,
    visibility: pkg.visibility,
    description: pkg.description,
    require_signature: pkg.requireSignature,
    created_at: pkg.createdAt,
    updated_at: pkg.updatedAt,
  };
}

export function limitsView(quota: EffectiveQuota): z.infer<typeof limitsSchema> {
  return { max_packages: quota.maxPackages, max_storage_bytes: quota.maxStorageBytes, max_asset_bytes: quota.maxAssetBytes };
}

export function usageView(usage: Usage): z.infer<typeof usageSchema> {
  return { packages: usage.packages, storage_bytes: usage.storageBytes };
}

export function assetView(asset: RegistryAsset): z.infer<typeof assetSchema> {
  return {
    name: asset.name,
    size: asset.size,
    sha256: asset.sha256,
    sig: asset.sig,
    key_id: asset.keyId,
    alg: asset.alg,
    run: asset.run,
    exec: asset.exec,
    created_at: asset.createdAt,
  };
}

export function versionView(version: VersionWithAssets): z.infer<typeof versionSchema> {
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    notes: version.notes,
    published_at: version.publishedAt,
    created_at: version.createdAt,
    assets: version.assets.map(assetView),
  };
}

export function channelView(pointer: ChannelPointer): z.infer<typeof channelSchema> {
  return { name: pointer.name, version: pointer.version, updated_at: pointer.updatedAt };
}

export function auditMeta(c: Context<AppEnv>) {
  const actor = c.get("user")!;
  return {
    actorId: actor.id,
    actorName: actor.name,
    ip: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? "unknown",
    result: "success" as const,
  };
}
