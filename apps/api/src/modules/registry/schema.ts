import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { apiTokens } from "@/modules/account/tokens/schema";
import { users } from "@/modules/account/users/schema";

// A namespace is the first segment of every package URL
// (`/r/<slug>/<package>/…`). `slug` is its public id: assigned by the system
// when the user first needs one, never chosen and never changed, so the URLs
// operators put in `lode.toml` survive the IdP renaming the user.
//
// `owner_user_id` is unique because v1 gives a user exactly one namespace.
export const registryNamespaces = sqliteTable("registry_namespaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  // A suspended namespace is not served.
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_registry_namespaces_slug").on(sql`lower(${t.slug})`),
  uniqueIndex("idx_registry_namespaces_owner").on(t.ownerUserId),
]);

// Identified by `(namespace, slug)`: two users may use the same slug.
export const registryPackages = sqliteTable("registry_packages", {
  id: text("id").primaryKey(),
  namespaceId: text("namespace_id").notNull().references(() => registryNamespaces.id),
  // The `:pkg` URL segment and the manifest `name`; fixed at creation.
  slug: text("slug").notNull(),
  // Free-text display name; not unique.
  name: text("name").notNull(),
  visibility: text("visibility", { enum: ["public", "private"] }).notNull().default("public"),
  description: text("description"),
  requireSignature: integer("require_signature", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_registry_packages_ns_slug").on(t.namespaceId, t.slug),
]);

// A package's signing keys: the public keys its upload signatures are checked
// against. `key_id` is lode's id, derived from the key, which is stored as
// unpadded base64url. A revoked key keeps its row so its id cannot be
// registered again by accident; `revoked_at` takes it out of verification.
export const registryKeys = sqliteTable("registry_keys", {
  id: text("id").primaryKey(),
  packageId: text("package_id").notNull().references(() => registryPackages.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  alg: text("alg", { enum: ["ed25519"] }).notNull().default("ed25519"),
  publicKey: text("public_key").notNull(),
  name: text("name").notNull(),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_registry_keys_package_key").on(t.packageId, t.keyId),
]);

// Everything below hangs off a package and goes with it: deleting a package
// cascades to its versions, assets, channels, uploads and token grants.

export const registryVersions = sqliteTable("registry_versions", {
  id: text("id").primaryKey(),
  packageId: text("package_id").notNull().references(() => registryPackages.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  status: text("status", { enum: ["draft", "published", "yanked"] }).notNull().default("draft"),
  notes: text("notes"),
  publishedAt: text("published_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_registry_versions_pkg_version").on(t.packageId, t.version),
]);

// Immutable once the version is published. `sig` / `key_id` / `alg` are null
// for an unsigned asset; `run` / `exec` are lode's optional launch overrides.
export const registryAssets = sqliteTable("registry_assets", {
  id: text("id").primaryKey(),
  versionId: text("version_id").notNull().references(() => registryVersions.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  sig: text("sig"),
  keyId: text("key_id"),
  alg: text("alg"),
  run: text("run"),
  exec: text("exec"),
  blobKey: text("blob_key").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_registry_assets_version_name").on(t.versionId, t.name),
]);

// `version_id` has no cascade of its own: a version a channel points at
// cannot be deleted from under it. Deleting the package removes both.
export const registryChannels = sqliteTable("registry_channels", {
  packageId: text("package_id").notNull().references(() => registryPackages.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  versionId: text("version_id").notNull().references(() => registryVersions.id),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  primaryKey({ columns: [t.packageId, t.name] }),
  index("idx_registry_channels_version").on(t.versionId),
]);

// The ids of versions that were published and then deleted, with their
// version alone or with the whole package. Keyed by namespace and package
// slug so the row outlives the package: the id stays taken for whatever is
// created at that address later, since its assets were served as immutable.
export const registryRetiredVersions = sqliteTable("registry_retired_versions", {
  namespaceId: text("namespace_id").notNull().references(() => registryNamespaces.id),
  packageSlug: text("package_slug").notNull(),
  version: text("version").notNull(),
  retiredAt: text("retired_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  primaryKey({ columns: [t.namespaceId, t.packageSlug, t.version] }),
]);

// The publisher's signature over the generated manifest, one per package:
// lode's top-level `key_id` / `sig`, and `expires` (Unix seconds) with its
// `expires_sig` when the publisher stamped one. `catalog_sha256` is the
// digest of the canonical catalog the signatures were verified over; the
// signature is served only while the manifest still has that catalog.
export const registryManifestSignatures = sqliteTable("registry_manifest_signatures", {
  packageId: text("package_id").primaryKey().references(() => registryPackages.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(),
  sig: text("sig").notNull(),
  expires: integer("expires"),
  expiresSig: text("expires_sig"),
  catalogSha256: text("catalog_sha256").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// In-flight multipart uploads: removed on completion, aborted by a sweep
// after `expires_at`. Everything the finished asset row needs is recorded
// when the upload starts. `parts` is a JSON array.
export const registryUploads = sqliteTable("registry_uploads", {
  id: text("id").primaryKey(),
  versionId: text("version_id").notNull().references(() => registryVersions.id, { onDelete: "cascade" }),
  assetName: text("asset_name").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  sig: text("sig"),
  keyId: text("key_id"),
  alg: text("alg"),
  run: text("run"),
  exec: text("exec"),
  r2UploadId: text("r2_upload_id").notNull(),
  parts: text("parts").notNull().default("[]"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  index("idx_registry_uploads_version").on(t.versionId),
  index("idx_registry_uploads_expires").on(t.expiresAt),
]);

// Narrows a personal API token to packages. `package_id` NULL means every
// package the token's owner has, including future ones. SQLite treats NULLs
// as distinct under UNIQUE, so the "all packages" row gets a partial index
// of its own to stay single per token.
export const registryTokenGrants = sqliteTable("registry_token_grants", {
  tokenId: text("token_id").notNull().references(() => apiTokens.id, { onDelete: "cascade" }),
  packageId: text("package_id").references(() => registryPackages.id, { onDelete: "cascade" }),
  access: text("access", { enum: ["read", "write", "admin"] }).notNull(),
}, t => [
  uniqueIndex("idx_registry_token_grants_token_pkg").on(t.tokenId, t.packageId),
  uniqueIndex("idx_registry_token_grants_token_all").on(t.tokenId).where(sql`package_id IS NULL`),
  index("idx_registry_token_grants_pkg").on(t.packageId),
]);

// Per-user overrides set by an administrator. No row, or a NULL column,
// means the platform default from configuration.
export const registryQuotas = sqliteTable("registry_quotas", {
  userId: text("user_id").primaryKey().references(() => users.id),
  maxPackages: integer("max_packages"),
  maxStorageBytes: integer("max_storage_bytes"),
  maxAssetBytes: integer("max_asset_bytes"),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
});
