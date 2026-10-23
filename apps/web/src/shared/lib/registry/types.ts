// Wire shapes of the registry API (`/api/registry`), field for field as the
// server's zod schemas declare them. The wire format is snake_case.

export interface Namespace {
  readonly slug: string;
  readonly status: "active" | "suspended";
  readonly created_at: string;
}

export interface RegistryPackage {
  readonly id: string;
  readonly namespace: string;
  readonly slug: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly description: string | null;
  readonly require_signature: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface Limits {
  readonly max_packages: number;
  readonly max_storage_bytes: number;
  readonly max_asset_bytes: number;
}

export interface Usage {
  readonly packages: number;
  readonly storage_bytes: number;
}

export interface Quota {
  readonly limits: Limits;
  readonly usage: Usage;
}

export type GrantLevel = "read" | "write" | "admin";

/** `package` is `<namespace id>/<package slug>`. */
export interface PackageGrant {
  readonly package: string;
  readonly access: GrantLevel;
}

/** Either one level for every package the owner has, or a level per package. */
export type Grants = { readonly all: GrantLevel } | readonly PackageGrant[];

export interface RegistryToken {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly prefix: string;
  readonly grants: Grants;
  readonly expires_at: string | null;
  readonly last_used_at: string | null;
  readonly created_at: string;
}

/** `token` is the secret; the server returns it once, at creation. */
export interface CreatedToken extends RegistryToken {
  readonly token: string;
}

export interface SigningKey {
  readonly id: string;
  readonly key_id: string;
  readonly alg: "ed25519";
  readonly public_key: string;
  readonly name: string;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

// A host that reported to `/r/otlp` for the package, with its latest snapshot.
export interface Instance {
  readonly instance_id: string;
  readonly version: string | null;
  readonly status: string | null;
  readonly host_name: string | null;
  readonly os_type: string | null;
  readonly host_arch: string | null;
  readonly lode_version: string | null;
  readonly interval_seconds: number;
  readonly online: boolean;
  readonly attributes: Record<string, unknown>;
  readonly metrics: Record<string, unknown>;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

// A log record a host reported to `/r/otlp/v1/logs`.
export interface InstanceEvent {
  readonly id: string;
  readonly instance_id: string;
  readonly name: string;
  readonly version: string | null;
  readonly body: string | null;
  readonly attributes: Record<string, unknown>;
  readonly at: string;
}

// The publisher's signature over the manifest. `expires` is Unix seconds.
export interface ManifestSignature {
  readonly key_id: string;
  readonly expires: number | null;
  readonly status: "live" | "stale" | "expired" | "revoked";
  readonly updated_at: string;
}

// The delegation that lets the sub-key `key_id` sign for the package; the
// window is Unix seconds.
export interface Delegation {
  readonly key_id: string;
  readonly root_key_id: string;
  readonly issuer: string | null;
  readonly not_before: number;
  readonly not_after: number;
  readonly status: "live" | "pending" | "expired" | "revoked";
  readonly updated_at: string;
}

// The package's revocation list. `issued_at` is Unix seconds.
export interface RevocationList {
  readonly issued_at: number;
  readonly revoked: readonly string[];
  readonly key_id: string;
  readonly updated_at: string;
}

// `sig`, `key_id` and `alg` are null together, for an unsigned asset.
export interface Asset {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly sig: string | null;
  readonly key_id: string | null;
  readonly alg: string | null;
  readonly run: string | null;
  readonly exec: string | null;
  readonly created_at: string;
}

export interface Version {
  readonly id: string;
  readonly version: string;
  readonly status: "draft" | "published" | "yanked";
  readonly notes: string | null;
  readonly published_at: string | null;
  readonly created_at: string;
  readonly assets: readonly Asset[];
}

/** `version` is the version string the pointer resolves to. */
export interface Channel {
  readonly name: string;
  readonly version: string;
  readonly updated_at: string;
}

export interface VersionsResponse {
  readonly versions: readonly Version[];
  readonly channels: readonly Channel[];
}

export interface VersionResponse {
  readonly version: Version;
  readonly channels: readonly Channel[];
}

export interface Owner {
  readonly id: string;
  readonly username: string;
  readonly name: string;
}

export interface AdminNamespace extends Namespace {
  readonly owner: Owner;
  readonly packages: number;
  readonly storage_bytes: number;
}

export interface AdminPackage extends RegistryPackage {
  readonly owner: Owner;
  readonly storage_bytes: number;
}

/** A null limit falls back to the platform default. */
export interface QuotaOverride {
  readonly max_packages: number | null;
  readonly max_storage_bytes: number | null;
  readonly max_asset_bytes: number | null;
}

export interface UserQuota extends Quota {
  readonly user_id: string;
  readonly override: QuotaOverride;
}

// ─── Request bodies ───

export interface RegisterKeyInput {
  readonly public_key: string;
  readonly name: string;
}

export interface CreatePackageInput {
  readonly slug: string;
  readonly name: string;
  readonly visibility?: RegistryPackage["visibility"];
  readonly description?: string;
  readonly require_signature?: boolean;
}

export interface UpdatePackageInput {
  readonly name?: string;
  readonly visibility?: RegistryPackage["visibility"];
  readonly description?: string | null;
  readonly require_signature?: boolean;
}

export interface CreateTokenInput {
  readonly name: string;
  /** ISO 8601 with offset; omitted or null means the token does not expire. */
  readonly expires_at?: string | null;
  readonly grants: Grants;
}

export interface CreateVersionInput {
  readonly version: string;
  readonly notes?: string;
}
