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
// for an unsigned asset; `run` / `exec` are lode's optional launch overrides,
// `runtime` its optional runtime as JSON (`RuntimeSpec`).
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
  runtime: text("runtime"),
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

// The package's manifest commits: complete `lode/v1` manifests their
// publisher signed (`sig` over the catalog, `commit_sig` over the commit),
// stored as uploaded but for the asset urls, which the feed fills in. `id` is
// the commit id, the sha256 of the commit message. The highest `generation`
// is the head the feed serves; one generation per package, so of two commits
// built on the same parent only one lands. `summary` is JSON: the channels,
// versions, and the versions added and dropped against the parent.
export const registryCommits = sqliteTable("registry_commits", {
  packageId: text("package_id").notNull().references(() => registryPackages.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  parent: text("parent"),
  generation: integer("generation").notNull(),
  created: text("created").notNull(),
  keyId: text("key_id").notNull(),
  manifest: text("manifest").notNull(),
  summary: text("summary").notNull(),
  uploadedAt: text("uploaded_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  primaryKey({ columns: [t.packageId, t.id] }),
  uniqueIndex("idx_registry_commits_pkg_generation").on(t.packageId, t.generation),
]);

// The package's delegation, one per package: a registered key (`root_key_id`,
// the one its signature verified under) lets the sub-key `key_id` sign for the
// package during `[not_before, not_after)` (Unix seconds). `key`, `issuer` and
// `sig` are served as the publisher sent them; `public_key` is the sub-key as
// unpadded base64url.
export const registryDelegations = sqliteTable("registry_delegations", {
  packageId: text("package_id").primaryKey().references(() => registryPackages.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  keyId: text("key_id").notNull(),
  publicKey: text("public_key").notNull(),
  notBefore: integer("not_before").notNull(),
  notAfter: integer("not_after").notNull(),
  issuer: text("issuer"),
  sig: text("sig").notNull(),
  rootKeyId: text("root_key_id").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// The package's revocation list, one per package, as the publisher signed it:
// `revoked` is a JSON array of sub-key ids, `delegation` the signer's
// delegation as JSON when a sub-key signed it. Only ever replaced by a newer
// list that keeps every id.
export const registryRevocationLists = sqliteTable("registry_revocation_lists", {
  packageId: text("package_id").primaryKey().references(() => registryPackages.id, { onDelete: "cascade" }),
  issuedAt: integer("issued_at").notNull(),
  revoked: text("revoked").notNull(),
  keyId: text("key_id").notNull(),
  delegation: text("delegation"),
  sig: text("sig").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// What hosts report over OTLP (`/r/otlp`), one row per reporting instance:
// the latest snapshot, overwritten by every export. `instance_id` is the
// resource's `service.instance.id` (else `host.name`); `attributes` and
// `metrics` are JSON. `interval_seconds` is the instance's own report
// interval, for telling an offline instance. Not backed up.
export const registryInstances = sqliteTable("registry_instances", {
  packageId: text("package_id").notNull().references(() => registryPackages.id, { onDelete: "cascade" }),
  instanceId: text("instance_id").notNull(),
  version: text("version"),
  status: text("status"),
  hostName: text("host_name"),
  osType: text("os_type"),
  hostArch: text("host_arch"),
  lodeVersion: text("lode_version"),
  intervalSeconds: integer("interval_seconds"),
  attributes: text("attributes").notNull().default("{}"),
  metrics: text("metrics").notNull().default("{}"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, t => [
  primaryKey({ columns: [t.packageId, t.instanceId] }),
  index("idx_registry_instances_last_seen").on(t.lastSeenAt),
]);

// Events reported as OTLP log records, newest kept for the retention period.
// `attributes` is JSON. Not backed up.
export const registryInstanceEvents = sqliteTable("registry_instance_events", {
  id: text("id").primaryKey(),
  packageId: text("package_id").notNull().references(() => registryPackages.id, { onDelete: "cascade" }),
  instanceId: text("instance_id").notNull(),
  name: text("name").notNull(),
  version: text("version"),
  body: text("body"),
  attributes: text("attributes").notNull().default("{}"),
  at: text("at").notNull(),
}, t => [
  index("idx_registry_instance_events_pkg_at").on(t.packageId, t.at),
  index("idx_registry_instance_events_at").on(t.at),
]);

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
  runtime: text("runtime"),
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
