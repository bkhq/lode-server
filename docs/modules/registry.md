# Registry Module

A multi-user release registry for [lode](https://github.com/bkhq/lode).
Every user gets a namespace and publishes packages into it; operators point
`lode.toml` at the package's manifest URL and lode bootstraps and updates
from it. The module owns the whole of it: namespaces, signing keys,
packages, versions and assets, channel pointers, token grants, quotas, the
platform-administration API, the asset blob store and the lode-facing read
feed.

The contract it implements is
[the plan](../plan/20261009-2241-lode-registry-server.md); where the
implementation departs from the plan's text, the section
[Deviations from the plan](#deviations-from-the-plan) says how.

> Paths below omit `BASE_PATH`. The management API is under `/api/registry`,
> the read feed under `/r`.

## Concepts

| Term | Meaning |
|---|---|
| Namespace | The first segment of every package URL. One per user, **assigned by the system** the first time it is needed: 8 characters, `[a-z][a-z0-9]{7}`. Never chosen, never renamed. Read with `GET /api/registry/namespace`; there is no claim route. |
| Package | Created with `{ slug, name }`. `slug` — lowercase letters, digits and `-`, not starting with `-`, at most 128 characters, unique within its namespace, immutable — is the `:pkg` path segment **and the manifest `name`**, so an operator's `lode.toml` sets `[global].app` to the package slug. `name` is free display text (1–100 characters, editable, not unique). |
| Version | `draft` → `published` → `yanked` (and back to `published`). Version ids follow lode's id rule: `[A-Za-z0-9._-]`, no leading `.` or `-`, at most 128 characters. |
| Asset | One file of a version, addressed by filename (lode's `[update].asset`). Mutable while the version is a draft, immutable afterwards. |
| Channel | A named pointer (`stable`, `beta`, …) at a published version: the manifest's `channels.<name>.latest`. |
| Token grant | Narrows a personal API token (`pat_…`) to packages. A grant names a package as `<namespace id>/<package slug>`. |

Publishing is draft-first: create a draft, upload the assets into it, then
`publish` flips the version to `published` and moves the channel pointer in
one transaction. A lode client polling mid-release sees either the old
pointer or the new one with every asset in place.

The server never holds a private key. Publishers sign locally with
`lode-cli sign`; the registry verifies the signature at upload and serves it
inline in the manifest.

## File layout

```text
apps/api/src/modules/registry/
  index.ts              # registrations: policy namespace, backup contribution, token scopes; re-exports
  schema.ts             # the fifteen registry_* tables
  wire.ts               # snake_case wire shapes and view functions shared by the route files
  validate.ts           # lode's id and command-override rules, the package slug rule
  access.ts             # `package` policy resource, requirePackageAccess / requireUploadAccess, token grants, read-token check
  registry.routes.ts    # namespace, keys, packages, quota; mounts the routers below
  registry.service.ts   # namespace assignment, quotas and usage, package CRUD, blob key layout
  key.service.ts        # public key parsing, key_id derivation, register / revoke
  release.routes.ts     # versions, single-request upload, publish, channels, yank / restore
  release.service.ts    # drafts, upload admission, signature check, asset re-sign, in-flight claims, publish, channels
  delegation.routes.ts  # delegation, revocation list, asset re-sign
  delegation.service.ts # delegation and revocation-list checks, the package's signing keys
  upload.routes.ts      # multipart: start, part, complete, abort
  upload.service.ts     # multipart flow, completion digest, expired-upload sweep pass
  upload.sweep.ts       # schedules the sweep on the platform scheduler
  token.routes.ts       # tokens with grants (session only)
  token.service.ts      # grant resolution, scope derivation
  admin.routes.ts       # /registry/admin (admin session only)
  admin.service.ts      # cross-user lists, namespace status, quota overrides
  feed.routes.ts        # the read feed: manifest.json, revocations.json and asset download; mounts /r/otlp
  observe.otlp.ts       # OTLP/HTTP JSON decoding: resource attributes, gauge/sum points, log records
  observe.service.ts    # instances and events: upsert, caps, listing, retention pass
  observe.routes.ts     # /r/otlp/v1/{metrics,logs} ingest; instances and events listing
  observe.retention.ts  # schedules the retention pass on the platform scheduler
  feed.service.ts       # lode/v1 manifest generation
  signature.ts          # lode's signed messages (artifact, manifest, delegation, revocation list), base64 forms, ed25519 verification (WebCrypto)
  registry.backup.ts    # backup contribution
  blob/                 # BlobStore seam: local driver (Bun), R2 driver (Workers), digest helper
  testdata/             # signature vectors produced by the real lode-cli 0.3.3
  spike/                # M2 workerd measurements (not part of the app)
  *.test.ts             # unit tests next to the code
```

## Lifecycle

- **Import time** (`index.ts`): registers the `package` policy namespace
  (`owner` ⊃ `maintainer` ⊃ `reader`), the backup contribution and the three
  token scopes `packages:read` / `packages:write` / `packages:admin`.
- **Mount** (`registryRoutes()`, from `routes/protected.ts`): when
  `REGISTRY_BLOB_DRIVER` is not `local`, the blob store is resolved
  immediately, so `r2` without the `PACKAGES` bucket binding fails the boot
  instead of the first upload.
- **Boot** (`buildFullApp`): `startRegistryUploadSweep` schedules
  `registry-upload-sweep` on the platform scheduler (timers on Bun, the
  Durable Object alarm on Workers) every
  `REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS`; the first pass runs 30 s after
  boot. `stopRegistryUploadSweep` runs at shutdown before the database
  closes. `startObserveRetentionSweep` schedules
  `registry-observe-retention` hourly the same way (first pass 30 s after
  boot; off when `REGISTRY_OBSERVE_RETENTION_DAYS` is 0).
- **Read feed**: mounted by `buildFullApp` at `/r` on the origin root (outside `BASE_PATH`) as a second
  app from the raw-app builder. A locked deployment (`buildLockedApp`) does
  not mount it.

## Database

All tables are in `schema.ts`; they are part of the single initial migration, `0000_init`.
Times are ISO 8601 text.

| Table | Key columns | Notes |
|---|---|---|
| `registry_namespaces` | `id`, `slug`, `owner_user_id`, `status` (`active` / `suspended`), `created_at` | Unique on `lower(slug)` and on `owner_user_id` (one namespace per user). `slug` is the public id; the internal `id` never leaves the server. |
| `registry_packages` | `id`, `namespace_id`, `slug`, `name`, `visibility` (`public` / `private`), `description`, `require_signature`, `created_at`, `updated_at` | Unique `(namespace_id, slug)`. |
| `registry_keys` | `id`, `package_id`, `key_id`, `alg` (`ed25519`), `public_key` (unpadded base64url), `name`, `revoked_at`, `created_at` | A package's signing keys. Unique `(package_id, key_id)`: the same key may be registered for several packages. `key_id` is derived by the server: the first 16 hex characters of SHA-256 over the raw key. A revoked key keeps its row. |
| `registry_versions` | `id`, `package_id`, `version`, `status` (`draft` / `published` / `yanked`), `notes`, `published_at`, `created_at` | Unique `(package_id, version)`. |
| `registry_assets` | `id`, `version_id`, `name`, `size`, `sha256`, `sig`, `key_id`, `alg`, `run`, `exec`, `runtime` (JSON), `blob_key`, `created_at` | Unique `(version_id, name)`. `sig` / `key_id` / `alg` are null together for an unsigned asset. `runtime` is the release's runtime (see [Release runtime](#release-runtime)), null when it has none. |
| `registry_channels` | `package_id`, `name`, `version_id`, `updated_at` | Primary key `(package_id, name)`. |
| `registry_manifest_signatures` | `package_id` (PK), `key_id`, `sig`, `expires` (Unix seconds), `expires_sig`, `catalog_sha256`, `updated_at` | The publisher's signature over the generated manifest, at most one per package. `expires` / `expires_sig` are null together. `catalog_sha256` is the digest of the canonical catalog it was verified over. |
| `registry_commits` | `package_id`, `id` (PK together), `parent`, `generation`, `created`, `key_id`, `manifest` (JSON), `summary` (JSON), `uploaded_at` | Publisher-signed manifests (migration `0005_commits`); see [Manifest commits](#manifest-commits). Unique `(package_id, generation)`: the head is the highest generation. `summary` holds the channels, versions and the versions added and dropped against the parent. |
| `registry_delegations` | `package_id` (PK), `key`, `key_id`, `public_key`, `not_before`, `not_after` (Unix seconds), `issuer`, `sig`, `root_key_id`, `updated_at` | The package's delegation, at most one: the sub-key `key_id` (raw key in `public_key`, unpadded base64url) may sign for the package during `[not_before, not_after)`. `root_key_id` is the registered key the signature verified under. `key`, `issuer` and `sig` are served as sent. |
| `registry_revocation_lists` | `package_id` (PK), `issued_at` (Unix seconds), `revoked` (JSON array of key ids), `key_id`, `delegation` (JSON, signer's delegation), `sig`, `updated_at` | The package's revocation list as the publisher signed it, at most one. Only replaced by a newer list that keeps every id. |
| `registry_retired_versions` | `namespace_id`, `package_slug`, `version`, `retired_at` | Primary key on the first three. The id of every version that was published and then deleted, alone or with its package. Not tied to the package row, so it holds for a package created again under the slug. |
| `registry_uploads` | `id`, `version_id`, `asset_name`, `size`, `sha256`, `sig`, `key_id`, `alg`, `run`, `exec`, `runtime`, `r2_upload_id`, `parts` (JSON), `expires_at`, `created_at` | In-flight multipart uploads. The row is also the quota reservation. |
| `registry_token_grants` | `token_id`, `package_id` (null = every package of the owner), `access` (`read` / `write` / `admin`) | Unique `(token_id, package_id)`, plus a partial unique index on `token_id WHERE package_id IS NULL`. |
| `registry_quotas` | `user_id` (PK), `max_packages`, `max_storage_bytes`, `max_asset_bytes`, `updated_at` | Per-user overrides; a null column or no row means the platform default. |
| `registry_instances` | `package_id`, `instance_id` (PK together), `version`, `status`, `host_name`, `os_type`, `host_arch`, `lode_version`, `interval_seconds`, `attributes` (JSON), `metrics` (JSON), `first_seen_at`, `last_seen_at` | The latest snapshot of each host reporting for the package over OTLP (migration `0004_observability`). At most `REGISTRY_OBSERVE_MAX_INSTANCES` per package. |
| `registry_instance_events` | `id`, `package_id`, `instance_id`, `name`, `version`, `body`, `attributes` (JSON), `at` | Reported log records. Indexed on `(package_id, at)` and `at`. |

Foreign keys: deleting a package cascades to its signing keys, versions,
assets, channels, manifest signature, commits, delegation, revocation list, uploads, token grants, instances and events; deleting an `api_tokens` row cascades to
its grants. Nothing cascades from `users` or from a namespace.
`registry_channels.version_id` has no cascade, so a version a channel points
at cannot be deleted from under it.

**Backup.** The `registry` contribution (deps `users`, `policies`) covers
twelve of the fifteen tables. `registry_instances` and
`registry_instance_events` are reported telemetry and are left out;
`registry_token_grants` is excluded too: `api_tokens`
is in no backup contribution, and a restore of `users` cascades the tokens
away, so a restored grant would fail the foreign key check and abort the
import. A restore therefore drops per-package grants — it fails closed: the
tokens are gone with them. Asset bytes are not part of a database backup.

## Access model

Two mechanisms apply to every request under `/api/registry/packages/:ns/:pkg`:

1. **Policy.** The module binds `GET` / `PATCH` / `DELETE`
   `/registry/packages/:ns/:pkg` to the `package` policy resource
   (`package:read` → `reader`, `package:release` → `maintainer`,
   `package:manage` and `package:delete` → `owner`). v1 writes only the
   `owner` tuple, at package creation. A platform administrator
   (`role === "admin"`) passes every check; the metadata of a public package
   is readable by every signed-in user.
2. **`requirePackageAccess(c, level)`**, called by every handler, resolves
   `:ns/:pkg` and checks the caller at `read` / `write` / `admin` / `owner`.

| Caller | Sees | May do |
|---|---|---|
| Owner (session) | own packages | everything |
| Other signed-in user | public packages: `GET` 200; private: 404 on every method | nothing — writes on a public package answer 403 |
| Administrator (session) | every package | everything, through the same routes |
| Token | packages its grants cover | what the grant level allows — never `owner` |

A private package the caller cannot read answers **404**, like a missing
one, so slugs cannot be found by probing.

### Tokens: scopes and grants

There is one kind of token, the template's personal API token
(`Authorization: Bearer pat_…`). Two checks apply to a token request:

- the template's **scope** check decides which routes a token may call;
- the registry's **grant** check decides on which packages.

A token's `packages:*` scopes are derived from its grants whenever the
grants are saved (`read` → `packages:read`; `write` adds `packages:write`;
`admin` adds `packages:admin`), so a user only ever configures packages.

`grants` is either `{ "all": "<level>" }` — every package in the token
owner's namespace, future ones included — or a list of
`{ "package": "<namespace id>/<package slug>", "access": "<level>" }`
(at most 200, no package twice). A token with no grant reaches no package.

| Grant level | Routes it opens on the granted package |
|---|---|
| `read` | `GET /registry/packages` (the granted ones), `GET …/:ns/:pkg`, `GET …/versions`, `GET …/versions/:ver`, `GET …/keys`, `GET …/manifest-signature`; the read feed of a private package |
| `write` | plus: create a draft, upload and delete draft assets, the multipart routes, publish, move a channel pointer, delete a **draft** version, register the package's signing keys, so a release pipeline can register the public half of its own key, and store or remove the manifest signature |
| `admin` | plus: `PATCH` the package (name, visibility, description, `require_signature`), yank, restore |

Never open to a token, whatever its grants: creating and deleting packages,
deleting a published or yanked version, revoking a signing key, token
management, the namespace, the quota, and everything under `/registry/admin`.

A token that may register keys can make the registry accept signatures from
a key of its choosing. That is accepted: the registry's check exists to catch
a broken release at upload, and the defence against a stolen token is the
operator's pinned `trusted_keys` under `require_signature = "enforce"`, which
a newly registered key is not part of. Keys belong to one package, so such a
token reaches only the packages it has a `write` grant on.

The signed message names the package slug, so a token with a `write` grant
on one package cannot publish there an asset the key signed for another.

A grant can only name a package the token's owner may manage. It is removed
with the package, and the token is refused on every registry route while its
owner's namespace is suspended (403 `NAMESPACE_SUSPENDED`) and stops working
altogether when the owner is disabled.

## Routes

Access levels: **Session** = signed-in session only (a token gets 403);
**Session / token(level)** = a session with that level on the package, or a
token whose grant gives it; **Admin** = session of a platform administrator.

### Management — `/api/registry`

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/namespace` | Session | The caller's namespace `{ namespace: { slug, status, created_at } }`; assigned on the first call. |
| GET | `/packages/:ns/:pkg/keys` | Anyone who can read the package | The package's signing keys, revoked ones included. The console fills `trusted_keys` of the generated `lode.toml` from it. |
| POST | `/packages/:ns/:pkg/keys` | Owner, administrator, or a token with a `write` grant | Register an ed25519 public key `{ public_key, name }`. Accepts the bare base64 key or lode's `[ed25519:][<key_id>:]<key>` forms. 400 `INVALID_PUBLIC_KEY`, 409 `KEY_EXISTS`. |
| DELETE | `/packages/:ns/:pkg/keys/:id` | Owner or administrator, session only | Revoke. Final: the key cannot be registered for this package again. |
| GET | `/packages/:ns/:pkg/manifest-signature` | Anyone who can read the package | `{ key_id, expires, status, updated_at }` or `null`. `status` is `live`, `stale`, `expired` or `revoked`; see [Manifest signature](#manifest-signature). |
| PUT | `/packages/:ns/:pkg/manifest-signature` | Session / token(write) | Store the publisher's signature over the current manifest `{ key_id, sig, expires?, expires_sig? }`, replacing an earlier one. 400 `UNKNOWN_KEY`, 400 `MANIFEST_EXPIRED`, 409 `MANIFEST_CHANGED`, 409 `PACKAGE_USES_COMMITS`. |
| DELETE | `/packages/:ns/:pkg/manifest-signature` | Session / token(write) | Remove it: `{ removed }`. The manifest is served unsigned. |
| GET | `/packages/:ns/:pkg/commits` | Anyone who can read the package | The manifest commits, newest first (at most 100): `id`, `parent`, `generation`, `created`, `key_id`, `channels`, `versions`, `added`, `dropped`, `uploaded_at`, `head`. See [Manifest commits](#manifest-commits). |
| GET | `/packages/:ns/:pkg/commits/head` | Anyone who can read the package | `{ commit, generation, manifest }`: what the next commit builds on. Without commits, `commit: null`, `generation: 0` and the generated manifest. |
| POST | `/packages/:ns/:pkg/commits` | Session / token(write) | Upload a signed manifest commit. 201 new, 200 stored already. 400 `INVALID_COMMIT`, 400 `INVALID_SIGNATURE`, 409 `COMMIT_CONFLICT`. |
| GET | `/packages/:ns/:pkg/delegation` | Anyone who can read the package | `{ key_id, root_key_id, issuer, not_before, not_after, status, updated_at }` or `null`. `status` is `live`, `pending`, `expired` or `revoked`; see [Delegated signing](#delegated-signing). |
| PUT | `/packages/:ns/:pkg/delegation` | Session / token(write) | Store the delegation `lode-cli delegate` writes `{ key, name, not_before, not_after, issuer?, sig }`, replacing an earlier one. 400 `INVALID_DELEGATION`, 400 `DELEGATION_EXPIRED`, 400 `KEY_REVOKED`, 409 `KEY_REGISTERED`. |
| DELETE | `/packages/:ns/:pkg/delegation` | Session / token(write) | Remove it: `{ removed }`. |
| GET | `/packages/:ns/:pkg/revocations` | Anyone who can read the package | `{ issued_at, revoked, key_id, updated_at }` or `null`. |
| PUT | `/packages/:ns/:pkg/revocations` | Session / token(write) | Store the list `lode-cli revoke` writes. 400 `INVALID_SIGNATURE`, 400 `REVOCATIONS_SHRINK`, 400 `REVOCATIONS_FUTURE`, 409 `REVOCATIONS_OUTDATED`. No `DELETE`. |
| GET | `/packages/:ns/:pkg/instances` | Anyone who can read the package | The hosts that reported to `/r/otlp`, most recently seen first: `instance_id`, `version`, `status`, `host_name`, `os_type`, `host_arch`, `lode_version`, `interval_seconds`, `online`, `attributes`, `metrics`, `first_seen_at`, `last_seen_at`. See [Observability](#observability). |
| GET | `/packages/:ns/:pkg/events` | Anyone who can read the package | Reported events, newest first, 100 per page; `?before=<at>` pages back. |
| GET | `/packages` | Session / token(read) | The caller's packages; with a token, the packages it has a grant on. |
| POST | `/packages` | Session | Create `{ slug, name, visibility?, description?, require_signature? }`. 409 `PACKAGE_EXISTS`, 409 `PACKAGE_QUOTA_EXCEEDED`. |
| GET | `/packages/:ns/:pkg` | Session / token(read) | Package metadata. |
| PATCH | `/packages/:ns/:pkg` | Session / token(admin) | Change `name`, `visibility`, `description`, `require_signature`. A `slug` in the body is a 422. |
| DELETE | `/packages/:ns/:pkg` | Session (owner or admin) | Delete the package with its versions, assets, channels, uploads, grants and stored bytes. |
| GET | `/quota` | Session | `{ limits, usage }` of the caller. |
| GET | `/tokens` | Session | Every personal token of the caller with its grants, expiry and last use; never a secret. |
| POST | `/tokens` | Session | Create `{ name, expires_at?, grants }`; the secret is returned once, in `token`. 422 `INVALID_GRANT`. |
| PUT | `/tokens/:id` | Session | Replace the grants, and rename when `name` is given: `{ grants, name? }`; the secret stays. |
| DELETE | `/tokens/:id` | Session | Revoke the token and its grants. |
| GET | `/packages/:ns/:pkg/versions` | Session / token(read) | `{ versions, channels }`: every version with its assets, drafts and yanked included. |
| POST | `/packages/:ns/:pkg/versions` | Session / token(write) | Create a draft `{ version, notes? }`. 409 `VERSION_EXISTS`, 409 `VERSION_RETIRED`. |
| GET | `/packages/:ns/:pkg/versions/:ver` | Session / token(read) | `{ version, channels }`. |
| DELETE | `/packages/:ns/:pkg/versions/:ver` | draft: Session / token(write); published or yanked: Session (owner or admin) | Delete the version and its stored bytes. The id of a published or yanked version is retired: its assets were served as immutable, so it cannot be created again, also not after the package is deleted and created anew. 409 `VERSION_IN_CHANNEL` while a channel points at it, 409 `VERSION_IN_COMMIT` while the head commit lists it. |
| PUT | `/packages/:ns/:pkg/versions/:ver/assets/:asset` | Session / token(write) | Single-request upload, see [Uploads](#uploads). 201 new, 200 replaced. |
| DELETE | `/packages/:ns/:pkg/versions/:ver/assets/:asset` | Session / token(write) | Remove an asset from a draft. |
| PUT | `/packages/:ns/:pkg/versions/:ver/assets/:asset/signature` | Session / token(write) | `{ sig }` — replace the asset's signature, in any version state. 400 `INVALID_SIGNATURE`. |
| POST | `/packages/:ns/:pkg/versions/:ver/uploads` | Session / token(write) | Start a multipart upload. |
| PUT | `/uploads/:uploadId/parts/:n` | Session / token(write) | Upload one part. |
| POST | `/uploads/:uploadId/complete` | Session / token(write) | Assemble, verify, create the asset. |
| DELETE | `/uploads/:uploadId` | Session / token(write) | Abort. |
| POST | `/packages/:ns/:pkg/versions/:ver/publish` | Session / token(write) | `{ channel }` — publish the draft and move the pointer. 409 `VERSION_EMPTY`, `VERSION_NOT_DRAFT`, `PACKAGE_USES_COMMITS`. |
| PUT | `/packages/:ns/:pkg/channels/:channel` | Session / token(write) | `{ version }` — promote or roll back. The target must be published (409 `VERSION_NOT_PUBLISHED`). 409 `PACKAGE_USES_COMMITS`. |
| POST | `/packages/:ns/:pkg/versions/:ver/yank` | Session / token(admin) | Hide a published version. 409 `VERSION_IN_CHANNEL` while a channel points at it. On a package with commits it is an emergency stop: channels are not checked, the version stays in the manifest and its assets stop downloading. |
| POST | `/packages/:ns/:pkg/versions/:ver/restore` | Session / token(admin) | Put a yanked version back. 409 `VERSION_NOT_YANKED`. |

### Administration — `/api/registry/admin`

Admin session only; no token scope lists these routes.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/namespaces` | Every namespace with owner, package count and storage. |
| POST | `/admin/namespaces/:slug/suspend` | Suspend: the feed answers 404, the owner is read-only, the owner's tokens are refused. |
| POST | `/admin/namespaces/:slug/restore` | Back in service. |
| GET | `/admin/packages` | Every package across users with owner and storage. |
| GET | `/admin/users/:userId/quota` | `{ user_id, override, limits, usage }`. |
| PUT | `/admin/users/:userId/quota` | Replace the override `{ max_packages?, max_storage_bytes?, max_asset_bytes? }`; a limit left out or null falls back to the platform default. |
| GET | `/admin/tokens` | Any user's tokens with grants; `?user_id=` narrows. |
| DELETE | `/admin/tokens/:id` | Revoke any token. |

There are no admin package routes. An administrator acts on any package —
settings, pointers, yank, version and package deletion — through the
ordinary `/registry/packages/:ns/:pkg` routes.

### Read feed — `/r`

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/r/:ns/:pkg/manifest.json` | Public, or token(read) for a private package | The head [manifest commit](#manifest-commits), or the generated `lode/v1` manifest while the package has none. |
| GET | `/r/:ns/:pkg/revocations.json` | Public, or token(read) for a private package | The package's `lode-revocations/v1` list, as signed; 404 while there is none. |
| GET | `/r/:ns/:pkg/:ver/:asset` | Public, or token(read) for a private package | The asset bytes, streamed from the blob store. |
| POST | `/r/otlp/v1/metrics` | Token with a grant on the package | OTLP/HTTP JSON metrics export; see [Observability](#observability). |
| POST | `/r/otlp/v1/logs` | Token with a grant on the package | OTLP/HTTP JSON logs export, stored as events. |

- The feed has no session, CSRF, CORS or policy middleware. Access is
  checked in the handler: a public package is anonymous; a private one needs
  `Authorization: Bearer pat_…` with a grant on the package. A session
  cookie is never consulted.
- Everything it refuses — unknown namespace, package, version or asset, a
  private package without a granted token, a suspended namespace, a draft or
  yanked version — is the **identical** JSON 404
  `{ "success": false, "error": { "code": "NOT_FOUND", "message": "Not found" } }`.
- Manifest: `name` is the package slug; published versions only, newest
  first, capped at `REGISTRY_MANIFEST_MAX_VERSIONS` plus the target of every
  channel; `notes` when the version has it; per asset `name`, an absolute
  same-host `url`, `sha256`, `size`, and `sig` / `key_id` / `alg` / `run` /
  `exec` only when present. The catalog signature and the delegation only
  while live (see [Manifest signature](#manifest-signature) and
  [Delegated signing](#delegated-signing)).
- Caching: a public manifest carries a strong `ETag` and
  `Cache-Control: public, max-age=60` and answers `If-None-Match` with 304; a
  public asset is `public, max-age=31536000, immutable`; everything of a
  private package is `private, no-store` without an `ETag`.
- Because asset urls are on the manifest's host, lode sends the operator's
  `[http].headers` on both fetches.

Operator side:

```toml
[global]
app = "<package slug>"

[update]
manifest = "https://<host>/r/<namespace>/<package slug>/manifest.json"
asset    = "<asset filename>"

[trust]
require_signature = "enforce"
trusted_keys = ["<key_id>:<base64url-pubkey>"]

# private package only
[http]
headers = ["Authorization: Bearer ${LODE_REGISTRY_TOKEN}"]
```

## Quotas

Platform defaults come from configuration; a `registry_quotas` row overrides
them for one user. `max_asset_bytes` is capped at 500 MiB whatever the
override says.

| Limit | Default | Refusal |
|---|---|---|
| Packages per user | 50 | 409 `PACKAGE_QUOTA_EXCEEDED` (count and insert in one transaction) |
| Storage per user | 10 GiB | 409 `STORAGE_QUOTA_EXCEEDED` |
| Single asset | 500 MiB | 413 `ASSET_TOO_LARGE` |

Usage is the sum of stored asset sizes plus the declared sizes of multipart
uploads in flight. Both are checked from the declared size when an upload
starts, before any byte is read, and are charged to the **package owner**
even when an administrator uploads.

## Blob storage and uploads

### BlobStore

A seam inside the module (`blob/types.ts`), independent of the `file`
module: `put` / `get` / `delete` / `deletePrefix` and `createMultipart` /
`putPart` / `completeMultipart` / `abortMultipart`. Bodies are streams in
both directions; nothing is buffered.

| Driver | Target | Behaviour |
|---|---|---|
| `local` | Bun (development, tests, self-hosting) | Under `REGISTRY_BLOB_LOCAL_ROOT`: `objects/<key>`, `tmp/<uuid>`, `multipart/<uploadId>/<n>-<sha256>`. Hashes and counts while writing to a temp file, then renames. |
| `r2` | Cloudflare Workers | The `PACKAGES` bucket binding. `bucket.put(key, body, { sha256 })` makes R2 verify the digest; multipart uses R2's multipart API. |

Key layout: `pkg/<package_id>/<version_id>/<asset_name>`. No
content-addressed dedup; deletion is a key or prefix delete.

### Uploads

**Single request** —
`PUT /api/registry/packages/:ns/:pkg/versions/:ver/assets/:asset?sha256=…[&sig=…][&run=…][&exec=…]`
with the raw bytes as the body, up to 95 MiB.

Order of checks, all before the body is read: access, parameters (422),
`Content-Length` (411 `LENGTH_REQUIRED`), the version is a draft (409
`VERSION_NOT_DRAFT`), the 95 MiB cap (413 `SINGLE_REQUEST_TOO_LARGE`), the
owner's asset limit and storage quota, the signature. The body then goes to
the store untouched; bytes that do not match the declared `sha256` and
length are 422 `DIGEST_MISMATCH` and nothing is stored.

**Multipart** — for anything above 95 MiB, up to the asset limit:

1. `POST …/versions/:ver/uploads` with
   `{ asset, size, sha256, sig?, run?, exec? }` →
   201 `{ uploadId, partSize, partCount }`. Everything is validated here,
   signature included. `partSize` is fixed by the server: 64 MiB
   (67108864). The declared size is reserved against the quota.
2. `PUT /uploads/:uploadId/parts/:n` — raw body, `Content-Length` required
   and exactly the size of that part (422 `INVALID_PART_SIZE`; part numbers
   are `1..partCount`, 422 `INVALID_PART_NUMBER`). Any order, in parallel;
   re-sending a part replaces it.
3. `POST /uploads/:uploadId/complete` — assembles the parts, reads the
   object back through SHA-256 and compares it with the digest declared at
   start. Only after a match does the asset row exist. A mismatch is 422
   `DIGEST_MISMATCH`: object and upload are gone. 409 `UPLOAD_INCOMPLETE`
   while a part is missing (the upload stays open).
4. `DELETE /uploads/:uploadId` — abort; parts and reservation go.

An upload not completed within `REGISTRY_UPLOAD_TTL_SECONDS` answers 409
`UPLOAD_EXPIRED` to the next part or completion and is removed by the
sweep. Other codes: 409 `UPLOAD_UNUSABLE` (the store no longer accepts the
parts), 422 `PART_REJECTED` (a part body did not arrive whole), 409
`VERSION_BUSY` (another operation holds the version or asset).

While an upload streams, its asset — and for publish and version deletion,
the whole version — is claimed in process memory, so a publish cannot land
between an upload's checks and its write.

An upload the server refuses before taking the body has that body read to
its end and discarded, so the client's connection stays usable.

## Signature verification

- Signing keys belong to a package. Its owner, an administrator, or a token
  holding a `write` grant on it registers ed25519 public keys (what
  `lode-cli publish` does when it is given a key, and `scripts/publish.sh`
  when `LODE_SIGNING_KEY` is set). ECDSA keys
  are refused.
- When an upload carries `sig`, the server rebuilds lode's message
  `lode.artifact.v2\n{app}\n{name}\n{version}\n{sha256}\n{run}\n{exec}` (no
  trailing newline) and requires it to verify under one of the **package's**
  signing keys — its active registered keys, and the sub-key of its live
  delegation; otherwise 400 `INVALID_SIGNATURE`. A signature is never stored
  unverified. `app` is the **package slug** — the manifest `name`, an
  operator's `[global].app`, what `lode-cli sign --app` takes — so an asset
  signed for one package is refused in another that trusts the same key.
  `name` is the **asset filename** (what `lode-cli sign` signs: the basename
  of the file), `sha256` is lowercase hex, an absent or empty
  `run` / `exec` is the empty string.
- The check happens at upload for the single-request path and at **start**
  for multipart; completion refuses the upload (400 `INVALID_SIGNATURE`) when
  that key stopped being a signing key in between. The key it verified under is stored and
  served as `key_id` / `alg`.
- `require_signature` on a package refuses an unsigned upload (400
  `SIGNATURE_REQUIRED`). It defaults to off; an unsigned asset is then served
  without `sig`, and lode installs it only under `require_signature = "off"`
  (or `auto` with no trusted keys).
- Revoking a key stops new uploads verifying under it. Signatures already
  stored stay in the manifest; `PUT …/assets/:asset/signature` replaces one.

Byte compatibility with lode is pinned twice: by unit tests over vectors
from the real `lode-cli sign` and `lode-cli manifest-sign` (`testdata/`), and
by the live e2e scenarios in which lode itself verifies a registry-served
signature.

### Manifest signature

lode can also require the manifest itself to be signed
(`[trust].require_manifest = "signed"`). lode 0.3.0 and older also offer
`"fresh"`, which requires a signed, unexpired expiry as well; later releases
treat `"fresh"` as `"signed"`.
The registry holds no private key, so the signature comes from the
publisher, over the manifest the registry generates:

1. The publisher downloads `/r/<ns>/<pkg>/manifest.json`, runs
   `lode-cli manifest-sign` on it and sends the resulting `key_id`, `sig`
   and, with `--expires-in`, `expires` and `expires_sig` to
   `PUT …/manifest-signature`. `scripts/sign-manifest.sh` does the three
   steps, and signs a manifest its key has not signed before only when the
   channels equal its `--expect` arguments.
2. The registry rebuilds the canonical catalog from the database
   (`canonicalCatalog` in `signature.ts`: `channel\t{name}\t{latest}` lines
   sorted by channel, then per version, sorted by id, `version\t{id}` and its
   `asset\t{name}\t{sha256}\t{run}\t{exec}` lines in manifest order) and
   verifies both signatures over `lode.manifest.v1\n{name}\n{key_id}\n{catalog}`
   and `lode.manifest-expiry.v1\n{name}\n{key_id}\n{expires}\n{catalog}`
   under the named key, which must be a signing key of the package (an
   active registered key, or the sub-key of the live delegation). Nothing
   unverified is stored. A signature that does not verify is a 409
   `MANIFEST_CHANGED`: a wrong signature and a manifest that changed since
   the download look the same, and the remedy — download again, sign again —
   is the same.
3. The feed attaches the stored fields only while the signature is **live**:
   the catalog it serves has the stored `catalog_sha256`, the key is still
   active, and the expiry has not passed. In every other state the manifest
   goes out unsigned, exactly as for a package that never signed.

| `status` | Meaning | Manifest |
|---|---|---|
| `live` | Matches the catalog, key active, not expired | signed |
| `stale` | The catalog changed: a publish, a channel move, a yank or a restore | unsigned |
| `expired` | `expires` has passed | unsigned |
| `revoked` | The key was revoked, or it is a sub-key whose delegation is no longer live | unsigned |

Why unsigned rather than the old signature: lode rejects a manifest whose
signature does not verify, and enforces an `expires` whenever the field is
present, under every policy. Serving a stale or lapsed signature would stop
every host; serving none stops only the hosts that asked for a signed
manifest, and they resume when the publisher signs again.

Consequences:

- Between a release step and the next signature the manifest is unsigned.
  Sign right after every publish, channel move, yank and restore.
- `REGISTRY_MANIFEST_MAX_VERSIONS` decides which versions the manifest
  lists; changing it makes every stored signature stale.
- The asset `url`, `size` and `notes` are not signed, so the origin a request
  arrives on does not matter.
- A public manifest is cached for 60 seconds: a host can see a signature up
  to a minute after it lapsed, and refuses that one response. Keep expiries
  in days.

### Manifest commits

A package can instead serve manifests its publisher builds and signs
completely. `lode-cli publish --key`, `lode-cli yank` and `lode-cli channel`
read the head (`GET …/commits/head`), apply their change, sign and upload the
result (`POST …/commits`). The first commit takes over the generated manifest;
from then on the package uses commits only.

A commit is a `lode/v1` manifest with `parent`, `generation`, `created` and
`commit_sig`. `commit_sig` signs
`lode.manifest-commit.v1\n{name}\n{key_id}\n{generation}\n{parent}\n{created}\n{catalog}`
(`parent` empty for generation 1), and the sha256 hex of that message is the
commit id. `sig` is the ordinary catalog signature, so lode releases without
commit support still verify it. The registry stores a commit only when:

- `parent` is the head's id and `generation` the head's plus one (the first
  commit: generation 1, no parent); otherwise 409 `COMMIT_CONFLICT`, and
  `lode-cli` builds again on the new head, up to five times;
- `name` is the package slug and both signatures verify under a signing key
  of the package (400 `INVALID_COMMIT`, 400 `INVALID_SIGNATURE`);
- every listed version exists with exactly the listed assets, each with its
  stored `sha256`, `run`, `exec` and runtime (400 `INVALID_COMMIT`).

The same commit uploaded again answers 200 with the stored one. A commit
publishes the drafts it lists and points `registry_channels` at its channels.
It never yanks the versions it drops: their assets stay downloadable, so
hosts still running them keep working.

The feed serves the head with the asset `url`s filled in, each asset's
`sig` / `key_id` / `alg` from its stored row and the live delegation attached.
The catalog does not cover asset signatures, so `PUT …/assets/:asset/signature`
takes effect at once. A commit is never stale and carries no expiry, so a lode
0.3.0 or older on `require_manifest = "fresh"` refuses it; lodes that write
commits treat `"fresh"` as `"signed"`. lode
records the generation and id per manifest `name` (`commits.json`) and refuses
an older generation, or the same generation with another id, so a registry
cannot roll hosts back to an earlier commit. Fixing a bad release is a new
commit: move the channel, or publish a fixed version.

Once a package has a commit, publishing a draft, moving a channel and
`PUT …/manifest-signature` answer 409 `PACKAGE_USES_COMMITS`, and deleting a
version the head lists answers 409 `VERSION_IN_COMMIT`. Yank is kept as an
emergency stop: it stops a version's downloads without a new commit, and
restore lifts the stop. The package's Commits tab lists the history.

### Release runtime

An asset can name the runtime its release runs on: `runtime`, `version`,
`version_check`, `download` and `sha256` (`lode-cli publish --asset-runtime …`;
upload query or multipart start fields `runtime`, `runtime_version`,
`runtime_version_check`, `runtime_download`, `runtime_sha256`). A signed asset
with a runtime is verified over `lode.artifact.v3`, the v2 message followed by
`\n{runtime}\n{version}\n{version_check}\n{sha256}` (`download` is not
signed), and the catalog's asset line carries the same four fields after a
tab. The manifest serves it as the asset's `runtime`.

### Delegated signing

lode 0.1.0 lets a root key stay offline: it signs a **delegation** for a
sub-key, scoped to one manifest `name` and a window, and the sub-key signs the
catalog, its expiry and the assets. The delegation is not part of any signed
message; the manifest carries it as the top-level `delegation`. Hosts trust
the root only. lode 0.0.3 and older reject sub-key signatures.

The package's registered keys are its roots. `PUT …/delegation` takes the JSON
`lode-cli delegate --app <slug>` writes and stores it once:

- `name` is the package slug and `key` an ed25519 key
  (`[ed25519:][<key_id>:]<base64>`), else 400 `INVALID_DELEGATION`;
- an active registered key verifies `sig` over
  `lode.delegation.v1\n{name}\ned25519\n{sub_key_base64url}\n{not_before}\n{not_after}`
  (`issuer` first, then every key), else 400 `INVALID_DELEGATION`;
- `not_after` lies ahead (400 `DELEGATION_EXPIRED`) and after `not_before`;
- the sub-key is not on the revocation list (400 `KEY_REVOKED`) and is not, and
  never was, a registered key of the package (409 `KEY_REGISTERED`).

| `status` | Meaning | Manifest | Sub-key signs |
|---|---|---|---|
| `live` | Within `[not_before, not_after)`, root active, sub-key not revoked | `delegation` served | yes |
| `pending` | `not_before` lies ahead | — | no |
| `expired` | `not_after` has passed | — | no |
| `revoked` | The root key was revoked, or the revocation list names the sub-key | — | no |

While it is live, the sub-key counts as a signing key of the package for
uploads, the multipart completion check, the manifest signature and asset
re-signs. Registering the sub-key as a key answers 409 `KEY_EXISTS`, so
`lode-cli publish --key-env <sub-key>` goes on without making it a root.

**Revocation list.** `PUT …/revocations` takes the list `lode-cli revoke`
writes and serves it at `/r/<ns>/<pkg>/revocations.json`, the URL a host sets
as `[trust].revocation_url`. It is verified as lode verifies it: `sig` over
`lode.revocations.v1\n{key_id}\n{issued_at}` and the sorted, deduplicated ids,
one per line, under an active registered key or a sub-key with its own valid
`delegation` for the slug that the stored list does not revoke. Hosts merge
lists grow-only and ignore one not newer than theirs, so the registry requires
a later `issued_at` (409 `REVOCATIONS_OUTDATED`), at most an hour ahead of its
clock (400 `REVOCATIONS_FUTURE`), and every stored id (400
`REVOCATIONS_SHRINK`). Ids are 16 lowercase hex characters. A revoked sub-key
stops signing here at once and its delegation is no longer served.

**Rotation.** One delegation per manifest: renew it for the same sub-key with
a new window. Moving to a new sub-key leaves assets signed by the old one
failing on `enforce` hosts; `PUT …/versions/:ver/assets/:asset/signature`
replaces the signature of an asset in any version state, verified like an
upload's over the stored digest and overrides. `sig` is not in the catalog,
so a manifest signature stays live.

## Observability

`/r/otlp` is an OpenTelemetry OTLP/HTTP endpoint: any exporter whose base
endpoint is `https://<host>/r/otlp` posts to `/v1/metrics` and `/v1/logs`.
lode's `[report]` block and a stock OpenTelemetry SDK or collector are
configured the same way; nothing in the request names lode-server.

- **Encoding.** JSON only (`Content-Type: application/json`), optionally
  `Content-Encoding: gzip`. At most 1 MiB on the wire and 4 MiB inflated
  (413). Protobuf and other encodings answer 415.
- **Auth.** `Authorization: Bearer pat_…` is required, also for a public
  package (401 otherwise). The token's owner must not be suspended.
- **Matching.** Each resource in the export is matched on its own:
  `service.name` is the package slug, looked up in the namespace
  `service.namespace` names, else in the token owner's namespace. The token
  needs a grant of any level on that package. The instance is
  `service.instance.id`, else `host.name`.
- **Partial success.** A resource that matches no granted package, names no
  instance, or would be a new instance past `REGISTRY_OBSERVE_MAX_INSTANCES`
  is dropped and counted in the OTLP `partialSuccess`
  (`rejectedDataPoints` / `rejectedLogRecords`); the answer is still 200, as
  OTLP specifies. An export with nothing dropped answers `{}`.
- **Metrics.** A metrics export refreshes the instance: `service.version`,
  `host.name`, `os.type`, `host.arch`, `lode.version`,
  `lode.report.interval`, the resource attributes (4 KiB), and the latest
  gauge and sum points by metric name (16 KiB). `status` is the `status`
  attribute of the `lode.app.status` point whose value is 1.
- **Logs.** Each log record becomes an event named by its `eventName`, else
  its `event.name` attribute, else `log`; at most 100 per resource and
  export. The instance is refreshed as well.
- **Online.** An instance is `online` until it reports the status `stopped`
  or has been silent for three of its report intervals
  (`lode.report.interval`, default 300 s).
- **Retention.** Events older than `REGISTRY_OBSERVE_RETENTION_DAYS`, and
  instances not seen for as long, are deleted by the hourly retention pass.
- **Rate limit.** The endpoint shares the raw per-IP bucket
  (`RAW_API_RATE_LIMIT_PER_MINUTE`) with the read feed.

The console shows a package's instances, the versions online, and recent
events on its **Observability** tab.

## Auditing

Every mutation writes an audit entry (`audit()`), with the acting user as
actor. `detail.owner_user_id` names the owner of the package acted on — it
differs from the actor for an administrator's action — and
`detail.token_id` is set when the request came with a token.

| Action | Resource | When |
|---|---|---|
| `registry.namespace.assigned` | `registry_namespace` | first `GET /namespace` or first package |
| `registry.namespace.suspended` / `.restored` | `registry_namespace` | admin, only on a real change |
| `registry.key.registered` / `.revoked` | `registry_key` | |
| `registry.package.created` / `.updated` / `.deleted` | `package` | `resourceName` is `<ns>/<slug>` |
| `registry.version.created` / `.published` / `.yanked` / `.restored` / `.deleted` | `registry_version` | `resourceName` is `<ns>/<slug>@<version>` |
| `registry.asset.uploaded` / `.deleted` | `registry_asset` | `<ns>/<slug>@<version>/<asset>`; detail has `size`, `sha256`, `key_id`, `replaced`, and `multipart` / `upload_id` for a multipart completion |
| `registry.channel.updated` | `registry_channel` | `<ns>/<slug>#<channel>` |
| `registry.manifest.signed` / `.unsigned` | `registry_package` | `<ns>/<slug>`; detail has `key_id` and `expires` |
| `registry.commit.created` | `registry_commit` | `#<generation>`; detail has `generation`, `parent` and `key_id` |
| `registry.delegation.set` / `.removed` | `registry_package` | detail has the sub-key `key_id`, `root_key_id` and `not_after` |
| `registry.revocations.published` | `registry_package` | detail has `issued_at`, `key_id` and `revoked` |
| `registry.asset.resigned` | `registry_asset` | detail has `key_id` and `previous_key_id` |
| `registry.upload.started` / `.aborted` | `registry_upload` | single parts are not audited |
| `registry.token.created` / `.grants_replaced` / `.revoked` | `api_token` | never the secret; `.grants_replaced` adds `name` / `previous_name` on a rename |
| `registry.quota.updated` | `registry_quota` | admin |

The expired-upload sweep writes no audit entries (it logs a count).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `REGISTRY_MAX_PACKAGES_PER_USER` | `50` | Platform default package count per user. |
| `REGISTRY_MAX_STORAGE_BYTES_PER_USER` | `10737418240` (10 GiB) | Platform default storage per user, uploads in flight included. |
| `REGISTRY_MAX_ASSET_BYTES` | `524288000` (500 MiB) | Largest asset; 500 MiB is also the ceiling, a larger value is refused at boot. |
| `REGISTRY_BLOB_DRIVER` | `local` | `local` or `r2`. `apps/api/wrangler.toml` sets `r2`. |
| `REGISTRY_BLOB_LOCAL_ROOT` | `data/uploads/packages` | Root of the `local` driver, anchored to `DATA_DIR`. |
| `REGISTRY_UPLOAD_TTL_SECONDS` | `86400` (24 h) | Lifetime of an unfinished multipart upload. |
| `REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS` | `3600` (1 h) | How often expired uploads are swept; `0` disables. |
| `REGISTRY_MANIFEST_MAX_VERSIONS` | `50` | Published versions listed in a manifest, plus every channel target. |
| `REGISTRY_OBSERVE_RETENTION_DAYS` | `30` | Days reported events and silent instances are kept; `0` keeps them forever. |
| `REGISTRY_OBSERVE_MAX_INSTANCES` | `1000` | Instances tracked per package; reports from further new instances are dropped. |

Related, owned by the template:

- `RAW_API_RATE_LIMIT_PER_MINUTE` (default 120, per IP) also bounds the read
  feed; the two share one bucket.
- `APP_URL` is the origin of the asset urls in a manifest (required in
  production).
- `MAX_UPLOAD_BYTES` (default 10 MiB) is, **on the Bun target**, the cap
  `Bun.serve` puts on every request body. A Bun deployment that takes
  registry uploads has to raise it to at least the single-request limit
  (99614720 for 95 MiB; 67108864 covers multipart parts only) — see
  [Known limitations](#known-limitations). The Workers target is not
  affected.

## End-to-end coverage

`tests/e2e/modules/registry/`, run by `bun run test:e2e` in phase B against
the live API (encrypted database, dex login) with the `local` blob driver.
`helpers.ts` holds the shared request helpers.

| File | Asserts |
|---|---|
| `namespace.test.ts` | The namespace is an 8-character id, stable per user, different between users; no write route; session only. |
| `keys.test.ts` | Registration under the derived `key_id` (lode's `<key_id>:<key>` form accepted), duplicate and revoked-then-re-registered 409, malformed and ECDSA keys 400, the same key on a second package, per-package isolation, a `read` token lists, a `write` token registers and never revokes. |
| `packages.test.ts` | `{ slug, name }` CRUD, slug validation and immutability, uniqueness per namespace only, cross-user matrix (public 200 / write 403, private 404, administrator passes), quota view. |
| `tokens.test.ts` | Grants by `<namespace>/<slug>`; what `read`, `write` and `admin` each open and refuse; session-only routes refuse every token; `PUT` grants without reissuing the secret; the "all" grant covers later packages and stops at the owner's namespace; `INVALID_GRANT`; revocation. |
| `versions.test.ts` | Draft → single-request upload (201 / 200 on replace) → publish; immutability after publish; refusals (missing / uppercase / wrong digest, empty body, 411 without `Content-Length`, bad names); signature accepted and every tampering refused, `SIGNATURE_REQUIRED`, revoked key; channel pointers, yank / restore, version deletion rules. |
| `uploads.test.ts` | One real multipart upload of an asset generated at 64 MiB + 1 MiB in two parts with a write-granted token: start contract, quota reservation, part size and number checks, `UPLOAD_INCOMPLETE`, completion, download through the feed with the same digest; `DIGEST_MISMATCH` on completion; start validation, restart, abort, and the 404 an outsider gets for any upload id. |
| `admin.test.ts` | 401 / 403 matrix (non-admin, tokens); namespace and package lists with owner and storage; takedown of a user's package through the ordinary routes; quota override bounding packages, asset size and storage; namespace suspension (feed 404, owner read-only, tokens refused) and restore; token list and revocation. |
| `feed.test.ts` (unit, `apps/api`) | Also covers the manifest signature: served while live, dropped when stale, expired or revoked, every refusal of `PUT`, and what a read token, a write token and another user may do. |
| `feed.test.ts` | Exact `lode/v1` manifest of a public package, `ETag` / 304 / cache headers, asset bytes, drafts and yanked versions not served, the identical 404 body for every refusal, private package only with a read-granted token, read-only. |
| `audit.test.ts` | Entries for package, version, asset, publish and token mutations, with the acting user, `owner_user_id` and `token_id`. |
| `delegation.test.ts` (unit, `apps/api`) | Delegation, revocation list and asset re-sign: lode's own vectors through the API, every refusal, the status transitions, the effect on uploads, the manifest and key registration, token access. |
| `lode.test.ts` | The real `lode` / `lode-cli` 0.1.0 binaries against the live feed — see below. |
| `publish.test.ts` | `lode-cli publish` and `scripts/publish.sh`, each run as a subprocess with a write-granted token: draft → upload → publish, one asset of about 96 MiB through the multipart path, re-run into an existing draft, refusals, and signing with `lode-cli` when a binary is available. |

### Real-client suite (`lode.test.ts`)

Runs the actual lode supervisor and asserts on its exit status, its log
output and the files it installs. Six scenarios:

1. **Signed, `require_signature = "enforce"`, pinned `trusted_keys`** — key
   from `lode-cli keygen`, registered with the registry; assets signed with
   `lode-cli sign` and uploaded with a write-granted token; lode bootstraps
   1.0.0 and auto-updates to 2.0.0. An operator pinning a different key is
   refused.
2. **Unsigned, `require_signature = "off"`** — bootstrap and auto-update.
3. **Rollback** — after `PUT channels/stable` points `latest` back from
   2.0.0 to 1.0.0, the running supervisor stays on 2.0.0 and
   `lode-cli update` exits 1 with lode's downgrade-floor refusal.
4. **Private package** — bootstrap with `[http].headers` carrying a
   read-granted token; without the header lode exits 1 on the feed's 404.
5. **Publisher-signed manifest** — a host on `require_manifest = "fresh"`
   refuses to install while the manifest is unsigned, installs after
   `scripts/sign-manifest.sh` ran, refuses again after a publish that was not
   signed again, and installs once it is.
6. **Delegated signing** — a host that trusts only the root key, with
   `require_manifest = "fresh"` and `revocation_url`, installs a release
   published by `lode-cli publish` with a delegated sub-key and signed by
   `scripts/sign-manifest.sh` with it; after `lode-cli revoke` the next host
   refuses it; once a new sub-key re-signs the asset and the manifest, a host
   installs it again. Skipped with a message when `E2E_LODE_BIN` points at a
   binary older than 0.1.0.

The lode binary is static and runs directly on the test host; the API is
reached on loopback, where lode allows plain http. It is located in this
order: `E2E_LODE_BIN`; `tests/e2e/.cache/lode-v0.1.0/lode` from an earlier run;
extraction from the local image `bkhq/lode:v0.1.0-mini`
(`docker pull docker.io/bkhq/lode:v0.1.0-mini` once — the container is created,
never started, and removed). With none of them the suite is **skipped with a
message**, it does not fail. Operator data dirs and the publisher's private
key live in a per-run directory under `tests/e2e/.cache/` and are removed
afterwards.

The orchestrator (`tests/e2e/run.ts`) sets two variables for this module on
the API it spawns: `REGISTRY_BLOB_LOCAL_ROOT` (inside the per-run data dir)
and `MAX_UPLOAD_BYTES` (100 MiB, so the Bun server accepts a 64 MiB part).

Also covered outside this directory: unit tests next to the code
(`*.test.ts`, including multipart on the local store and the R2 driver
against a fake bucket), and the Workers smoke suite (`bun run test:workers`),
which uploads to R2 on workerd — one signed single-request asset and one
multipart asset in two parts, with the completion digest checked — publishes
and reads both back through `/r`. Its opt-in `--large` and `--refused-body`
checks are for a deployed Worker
([deployment guide](../develop/deployment.md#verification)).

## Deviations from the plan

What the implementation does that the plan's text does not say, or says
differently. The identity model above (system-assigned namespaces, package
slug + display name) is the plan as amended on 2026-10-10 and is not a
deviation.

**Routes beyond the plan's API table.** `GET /namespace`, `GET /quota`,
`GET …/versions`, `GET …/versions/:ver`,
`DELETE …/versions/:ver/assets/:asset` (drafts only) and
`POST …/versions/:ver/restore`.

**Version deletion.** The plan's table says "drafts only".
`DELETE …/versions/:ver` deletes a draft with a `write` grant; a published
or yanked version can be deleted too, but only from a session of the owner
or a platform administrator — never with a token — and only while no channel
points at it.

**Administration.** There are no admin package routes. Platform
administrators act on packages through the ordinary
`/registry/packages/:ns/:pkg` routes; `/registry/admin` carries namespaces
(list, suspend, restore), the cross-user package list, quota overrides and
tokens.

**Configuration.** Defaults: 50 packages, 10 GiB storage, 500 MiB asset
ceiling, upload TTL 24 h, sweep interval 1 h, manifest cap 50, public
manifest `max-age` 60 s (a constant). Five variables beyond the plan's
three: `REGISTRY_BLOB_DRIVER`, `REGISTRY_BLOB_LOCAL_ROOT`,
`REGISTRY_UPLOAD_TTL_SECONDS`, `REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS`,
`REGISTRY_MANIFEST_MAX_VERSIONS`.

**Wire format and status codes.** Fields are snake_case, following the
plan's column names — except the multipart start contract, which keeps the
plan's camelCase (`{ uploadId, partSize, partCount }`). Validation failures
are 422; quota refusals are 409 (`PACKAGE_QUOTA_EXCEEDED`,
`STORAGE_QUOTA_EXCEEDED`); uploads answer 411 without `Content-Length` and
413 above a size limit (`SINGLE_REQUEST_TOO_LARGE`, `ASSET_TOO_LARGE`); a
body that does not match its declaration is 422 `DIGEST_MISMATCH` on both
drivers (R2 does not report why it refused a put); signature and key
problems are 400 (`INVALID_SIGNATURE`, `SIGNATURE_REQUIRED`,
`INVALID_PUBLIC_KEY`); state conflicts are 409 with a `VERSION_*`
(`VERSION_EXISTS`, `VERSION_RETIRED`, `VERSION_NOT_DRAFT`, `VERSION_EMPTY`,
`VERSION_NOT_PUBLISHED`, `VERSION_NOT_YANKED`, `VERSION_IN_CHANNEL`,
`VERSION_BUSY`) or `UPLOAD_*` (`UPLOAD_INCOMPLETE`, `UPLOAD_EXPIRED`,
`UPLOAD_UNUSABLE`) code.

**404 instead of 403.** On `/api/registry`, a private package the caller
cannot read answers 404 on every method (a public package of another user:
`GET` 200, writes 403). An upload id answers 404 whenever the caller has no
part in its package, public or not; only a token of the package's own side
whose grant is too low is told so with a 403.

**Tokens.**
- `PUT /tokens/:id` writes `api_tokens.scopes` from the registry module, in
  one transaction with the grants: the template's tokens service has no
  update. Scopes outside `packages:*` are kept. The `api_tokens` table
  itself is unchanged.
- A request carrying `Authorization: Bearer pat_…` is treated as a token
  request inside the registry even when it also carries a session cookie;
  the grants can only narrow what the caller may do.
- `GET /tokens` lists all of the caller's personal tokens, including ones
  created on the template's token tab without grants.
- 422 `INVALID_GRANT` does not distinguish a missing package from someone
  else's, so a grant cannot be used to probe.

**Backup.** Ten of eleven tables; `registry_token_grants` is excluded and a
restore drops per-package grants (see [Database](#database)).

**Schema additions.** `registry_assets.alg`; `key_id` and `alg` on
`registry_uploads` (a finished upload writes its asset row from them);
`created_at` / `updated_at` where a row has a lifetime; the partial unique
index that keeps the all-packages grant single per token; a 128-character
cap on ids (lode has none); key revocation is final (the row stays, the key
cannot be re-registered).

**Signature.** The message is lode's `lode.artifact.v2` . Its `app` is the package slug, its `name` the asset filename; `sha256` is
accepted in lowercase only; an empty `run` / `exec` equals an absent one. A
signature is verified against the package's active keys at upload
(single-request) or at multipart start; completion only checks that the key
is still active.

**Uploads.**
- A per-version in-process claim (409 `VERSION_BUSY`) serialises uploads
  against publish and delete. It relies on one process owning the database:
  the single Durable Object on Workers, the server process on Bun.
- Re-uploading an asset name is quota-checked at its full size, although
  the bytes it replaces are freed.
- Starting a multipart upload for an asset name that has one in flight
  aborts the earlier one **before** the quota check — and it stays aborted
  when the new start is then refused.
- Store aborts in cleanup paths (delete, restart, sweep) are best effort.
- The sweep writes no audit entries.
- A refused upload body is drained, not cancelled: with a cancel, workerd
  dropped the client's next request on the connection.

**Read feed.** It keeps the outer app's browser security headers (the raw
API does not); it shares the raw API's rate-limit bucket; yanked versions
are not downloadable; versions dropped from the manifest by the cap stay
downloadable; `notes` is included in the manifest; it is not mounted while
the deployment is locked.

**Template-surface edits beyond the one-line registry entries**, each
approved during the workstream: `TAGS.Registry` in `shared/lib/openapi.ts`;
the `REGISTRY_BLOB_LOCAL_ROOT` anchoring in `config.ts`;
`REGISTRY_BLOB_DRIVER = "r2"` in `wrangler.toml`; upload-sweep start / stop
in `app.ts` / `index.ts`; the `/r` mount in `app.ts`; forced test-fixture
updates in `account/auth/auth.routes.test.ts`,
`shared/middleware/creation-rate-limit.test.ts` and `app.test.ts`; and two
environment entries in `tests/e2e/run.ts` (`REGISTRY_BLOB_LOCAL_ROOT`,
`MAX_UPLOAD_BYTES`).

## Known limitations

- **Single-request uploads do not reserve quota while in flight.**
  Concurrent uploads may overshoot the storage quota by up to 95 MiB each.
  Multipart uploads reserve.
- **Multipart on R2 awaits the deployed run.** It is unit-tested and
  exercised live by the e2e suite on the local store, and on R2 / workerd it
  is covered by `bun run test:workers` (a 65 MiB asset in two parts,
  completion digest both ways, read back through `/r`). What stays open is
  the run against a deployed Worker: the 500 MiB completion digest (at most
  4.2 s CPU) was only ever measured on local workerd, which enforces no
  limits. The check is `smoke.ts --large` — see
  [the deployment guide](../develop/deployment.md#verification).
- **Unverified on the real Cloudflare edge:** body draining on refused
  uploads (`smoke.ts --refused-body`), and Durable Object responsiveness
  during a 500 MiB completion (`--large`).
- **A refusal outside the upload routes does not drain the request body.**
  Only the upload routes read a refused body to its end. A refusal from
  anywhere else — a 429 from the creation rate limiter, for example, or
  `POST /uploads/:id/complete` sent with a JSON body while a part is missing
  — leaves the body unread, and on local workerd the client's next request
  on that connection can then fail with a 500 "Network connection lost".
  Seen during the smoke work; unverified on the real edge.
- **Bun target: request-body cap.** `Bun.serve` refuses a body above
  `MAX_UPLOAD_BYTES` + 64 KiB (10 MiB by default) with a 413 before the app
  sees the request, so with default settings a single-request upload above
  10 MiB and every full 64 MiB part fail. The cap is set in
  `apps/api/src/index.ts` from the attachment limit and does not know about
  the registry; raise `MAX_UPLOAD_BYTES` on a Bun deployment. Found by the
  first live multipart run.
- **Bun target: no `Content-Length` on asset `GET`.** Bun sends a streamed
  response body chunked, so the header the handler sets reaches the client
  only on `HEAD`. Workers sends it on `GET` too (asserted by the smoke
  suite). lode does not need it.
- **`/r` is missing from the generated OpenAPI document and
  `api-routes.md`:** the generator and the docs module only walk `/api`. The
  feed is described by hand in
  [`reference/api.md`](../reference/api.md#registry-read-feed).
- **Admin lists are unpaginated.**

## Deferred

- Back up `api_tokens` together with `registry_token_grants`.
- Expose the token id on the auth context, replacing the registry's re-read
  of the `Authorization` header.
- List `/r` in the OpenAPI document.
- Pagination for the admin lists.
- Derive the Bun server's request-body cap from the registry's upload
  limits, and send `Content-Length` on streamed downloads there.
- Drain the request body in the shared refusal path, not only in the upload
  routes.
- Typecheck the repository-level `tests/` directory in `bun run check`.
- Everything under *Deferred* in
  [the plan](../plan/20261009-2241-lode-registry-server.md#deferred-not-part-of-this-approval).

## Out of scope

Not built in this module's API milestones (M1–M3): the web UI (M4). The M5
items exist now: `lode-cli publish` (in lode) and `scripts/publish.sh`, with the CI example in
`examples/publish/`, the [publisher](../guides/publisher.md) and
[operator](../guides/operator.md) guides, and the Cloudflare deployment
procedure in [`develop/deployment.md`](../develop/deployment.md#cloudflare-workers)
— the deployment itself is still the owner's to perform. Not built at all:
ECDSA keys;
organization namespaces and per-package maintainers (the `maintainer` and
`reader` relations are declared, nothing grants them); any change to
`bkhq/lode`.

## See also

- [The plan](../plan/20261009-2241-lode-registry-server.md)
- [`reference/api.md`](../reference/api.md) — route tables;
  [`reference/api-routes.md`](../reference/api-routes.md) — generated index
- [`reference/database.md`](../reference/database.md#registry)
- [`develop/runtime.md`](../develop/runtime.md) — the Workers target
- `apps/api/src/modules/registry/spike/README.md` — the M2 measurements
