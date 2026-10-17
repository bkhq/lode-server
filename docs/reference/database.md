# Database

The API uses SQLite through Drizzle ORM. Table definitions live in each
module's own `apps/api/src/modules/<name>/schema.ts`;
`apps/api/src/db/schema.ts` is a re-export aggregator only and contains
no table definitions.

The single baseline migration `apps/api/drizzle/0000_*.sql` reflects the
shipped schema. `bun run --filter @app/api db:generate` regenerates it
from the source-of-truth schema files.

## Conventions

| Topic           | Current behavior                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Database        | SQLite (`libsql` driver, optional at-rest encryption)                                                            |
| ORM             | Drizzle ORM                                                                                                     |
| Time fields     | ISO 8601 strings (`text`)                                                                                       |
| Booleans        | SQLite integer booleans (Drizzle's `integer({ mode: "boolean" })`)                                              |
| ULIDs           | `items.id`, `files.id`, `audit_events.id` — 26-char Crockford base32 with millisecond timestamp prefix          |
| Nanoids         | `items.short_id`, `file_references.id`, `relation_tuples.id`, sub-type IDs — 8 chars from `[0-9a-z]`            |
| Soft delete     | `items.deleted_at` (NULL = live). Hard delete is a future janitor (retention policy).                            |

## Tables

### Account

#### `users`
Local account records created or updated from OAuth userinfo.

Key fields: `id`, `oauth_sub`, `username`, `name`, `email`, `avatar`,
`role`, `status`, `last_login_at`, `created_at`, `updated_at`.
Unique indexes on OAuth subject, username, email.

#### `groups`
Account groups used for membership and policy subjects.

Key fields: `id`, `name`, `description`, `created_at`, `updated_at`.

#### `sessions`
Server-side OAuth sessions.

Key fields: `id`, `user_id`, `access_token`, `refresh_token`,
`expires_at`, `created_at`, `updated_at`.

#### `pkce_challenges`
Temporary OAuth PKCE state. `state`, `code_verifier`, `redirect_uri`, `expires_at`.

#### `user_preferences`
Per-user key/value preferences. Primary key: `(user_id, key)`.

#### `user_totp_devices`
TOTP devices for users. `id`, `user_id`, `name`, `secret`, `verified`,
`last_used_timestep`, `created_at`.

#### `totp_challenges`
Login-time TOTP challenges. `id`, `user_id`, `access_token`,
`refresh_token`, `expires_in`, `redirect_uri`, `expires_at`.

#### `auth_lockouts`
Persisted per-key failure counter + lockout window. `key`, `failures`,
`locked_until` (epoch ms; NULL while tracking but not locked),
`updated_at`. Keyed by purpose: `single-user:<username-lower>` for
single-user login, `totp:<user-id>` for TOTP step-up. Persisted (not
in-memory) so brute-force counters survive restart and replicas.

### Audit

#### `audit_events`
Immutable audit log records.

`id`, `actor_id`, `actor_name`, `action`, `resource_type`, `resource_id`,
`resource_name`, `detail`, `ip`, `user_agent`, `result`, `created_at`.

`detail` is nullable (use when no structured payload makes sense); every
other column is `NOT NULL`.

### Cron

#### `cron_jobs`
Scheduler job definitions. Soft-delete via `is_deleted` so `cron_job_logs`
foreign keys remain valid for retention queries; the cron route layer
filters `is_deleted=false` by default.

| Column | Notes |
| --- | --- |
| `id` | **nanoid** (8 chars). |
| `name` | Required; unique via `idx_cron_jobs_name`. |
| `cron` | Normalised cron expression. See `apps/api/src/modules/cron/cron-format.ts` for the supported grammar. |
| `task_type` | Mirrors the registered action's `category` (e.g. `maintenance`, `network`, `system`, `custom`). Free-form text. |
| `task_config` | JSON text — `{ action: "<name>", ...action-specific }`. |
| `enabled` | Integer boolean. Toggled by pause / resume; flipped to `false` automatically after `max_consecutive_failures` consecutive failures. |
| `is_deleted` | Integer boolean. Soft-delete marker. |
| `max_consecutive_failures` | Integer, default `3`. Per-job auto-pause threshold (see [`modules/cron.md` § Retry policy](../modules/cron.md#retry-policy)). `0` disables auto-pause. |
| `created_at`, `updated_at` | ISO timestamps. |

Indexes: unique `(name)`, `(enabled)`.

#### `cron_job_logs`
One row per run. `id` is a ULID so monotonic ordering matches run
order. Cascade-deletes when the parent job is hard-deleted.

| Column | Notes |
| --- | --- |
| `id` | **ULID**. |
| `job_id` | FK → `cron_jobs.id ON DELETE CASCADE`. |
| `started_at` | ISO timestamp set when the run row is created. |
| `finished_at` | ISO timestamp set when the handler resolves / throws. NULL while the job is in `status="running"`. |
| `duration_ms` | Integer, set alongside `finished_at`. |
| `status` | `'running'` / `'success'` / `'failed'`. |
| `result` | Handler's return string on success. |
| `error` | Error message on failure. |

Indexes: `(job_id)`, `(job_id, started_at)`, `(status)`.

### Settings

#### `settings`
Runtime settings stored by key. `key`, `value`, `updated_by`, `updated_at`.

### Policy (Zanzibar)

#### `relation_tuples`
Zanzibar-style relation tuples — the **single source of truth for every
access relationship** in this codebase (issue assignee, document
viewer / editor, document parent edges, group membership, …).

`id`, `namespace`, `object_id`, `relation`, `subject_namespace`,
`subject_id`, `subject_relation`, `created_by`, `created_at`.

`subject_relation` and `created_by` are nullable (system-issued tuples
have no creator; userset-style tuples leave `subject_relation` empty).

Indexes: `(namespace, object_id, relation)`, `(subject_namespace,
subject_id, subject_relation)`, plus a unique composite on the full
six-tuple key. SQLite treats `NULL` as distinct in `UNIQUE` indexes,
so service code performs a defensive duplicate check before insert.

### Items (the content base)

#### `items`
Universal metadata for every content-style object (issue, document,
future ticket / purchase order / expense / …).

| Column        | Notes                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | **ULID** (26 chars). Timestamp prefix encodes the creation millisecond — sort `id DESC` for newest-first; no separate `created_at` column. |
| `short_id`    | **nanoid** (8 chars). Unique. The id surfaced in URLs / API payloads / audit `resource_id`.                                            |
| `type`        | Opaque sub-type discriminator (`'issue'`, `'document'`, …).                                                                                |
| `title`       | Required.                                                                                                                                |
| `status`      | Opaque text marker; sub-type defines allowed values.                                                                                       |
| `creator_id`  | FK → `users.id ON DELETE CASCADE`.                                                                                                       |
| `version`     | Integer, default 1. Optimistic-concurrency counter — bumped on every update.                                                              |
| `deleted_at`  | Soft-delete timestamp; NULL = live. Read paths must filter on this.                                                                       |
| `updated_at`  | ISO timestamp.                                                                                                                          |

Indexes: `(short_id)` unique, `(type, deleted_at)`, `(creator_id, deleted_at)`, `(type, status, deleted_at)`.

#### `item_comments`
Comments attached to any item, regardless of sub-type. Flat reply
model — a comment either replies to one other comment in the same item,
or is top-level.

| Column        | Notes                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | nanoid PK.                                                                                                                            |
| `item_id`     | FK → `items.id ON DELETE CASCADE`.                                                                                                    |
| `author_id`   | FK → `users.id ON DELETE CASCADE`.                                                                                                    |
| `reply_to_id` | FK → `item_comments.id ON DELETE SET NULL`. Single upward edge — no thread tree.                                                       |
| `content`     | Required text.                                                                                                                         |
| `is_internal` | Boolean; `1` = hidden from viewer-only actors. Replies inherit from their target so threads don't leak across the visibility boundary. |
| `created_at`, `updated_at` | ISO.                                                                                                                       |

### Files

#### `files`
Storage row per stored blob. Content-addressable: `UNIQUE(sha256,
storage_driver)` enables dedupe per backend.

| Column           | Notes                                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`             | ULID PK.                                                                                                                    |
| `sha256`         | 64-char lowercase hex content key.                                                                                          |
| `size`           | Bytes.                                                                                                                      |
| `mimetype`       | Declared + magic-byte verified at upload.                                                                                    |
| `storage_driver` | `'local'`, `'s3'`, `'azure-blob'`, … (whatever drivers register).                                                            |
| `storage_key`    | Driver-internal address (local driver uses `<ab>/<cd>/<sha>`).                                                                |
| `ref_count`      | Materialised count of `file_references` rows. The async GC sweeper picks rows where `ref_count = 0` for collection.          |
| `uploaded_by`    | FK → `users.id ON DELETE CASCADE`. First uploader; informational only.                                                       |

Indexes: `UNIQUE(sha256, storage_driver)`, `(sha256)`, `(storage_driver)`, partial `(id) WHERE ref_count = 0` for the GC.

#### `file_references`
Reverse table. **Doubles as the attachment registry** for every
consumer — no separate `*_attachments` tables.

| Column        | Notes                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`          | nanoid PK. The id surfaced as the external attachment id in URLs.                                                     |
| `file_id`     | FK → `files.id ON DELETE RESTRICT`. Releases go through `FileService`, not raw cascade.                                |
| `owner_type`  | Discriminator: `'item_attachment'` (item-level), `'item_comment_attachment'` (per-comment), … one per consumer module. |
| `owner_id`    | Consumer-side primary key. For `item_attachment` → `items.id`; for `item_comment_attachment` → `item_comments.id`.    |
| `filename`    | Per-reference display filename.                                                                                       |
| `metadata`    | Opaque JSON ('{}' default).                                                                                           |
| `created_by`  | FK → `users.id`.                                                                                                      |
| `created_at`  | ISO.                                                                                                                  |

Indexes: `UNIQUE(owner_type, owner_id, file_id)` — same blob can only
appear once per owner; `(owner_type, owner_id)`, `(file_id)`.

### Registry

Owned by the `registry` module (`apps/api/src/modules/registry/schema.ts`,
migration `0000_init`). Details and the reasoning behind
each constraint: [`modules/registry.md`](../modules/registry.md#database).

| Table                   | Key columns                                                                                                  | Notes |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | ----- |
| `registry_namespaces`   | `id`, `slug`, `owner_user_id`, `status`, `created_at`                                                          | One per user, assigned by the system. Unique on `lower(slug)` and on `owner_user_id`. `status` is `active` / `suspended`. |
| `registry_keys`         | `id`, `package_id`, `key_id`, `alg`, `public_key`, `name`, `revoked_at`, `created_at`                          | A package's signing keys (ed25519). Unique `(package_id, key_id)`; removed with the package; a revoked key keeps its row. |
| `registry_packages`     | `id`, `namespace_id`, `slug`, `name`, `visibility`, `description`, `require_signature`, `created_at`, `updated_at` | Unique `(namespace_id, slug)`. `slug` is the URL segment and the manifest `name`; `name` is display text. |
| `registry_versions`     | `id`, `package_id`, `version`, `status`, `notes`, `published_at`, `created_at`                                 | Unique `(package_id, version)`. `status` is `draft` / `published` / `yanked`. FK → package, cascade. |
| `registry_assets`       | `id`, `version_id`, `name`, `size`, `sha256`, `sig`, `key_id`, `alg`, `run`, `exec`, `blob_key`, `created_at`  | Unique `(version_id, name)`. FK → version, cascade. Bytes live in the blob store at `blob_key`. |
| `registry_channels`     | `package_id`, `name`, `version_id`, `updated_at`                                                               | PK `(package_id, name)`. FK → package cascades; FK → version does not, so a pointed-at version cannot be deleted. |
| `registry_manifest_signatures` | `package_id`, `key_id`, `sig`, `expires`, `expires_sig`, `catalog_sha256`, `updated_at` | The publisher's signature over the generated manifest, one per package (migration `0001_manifest_signatures`). FK → package, cascade. Served only while `catalog_sha256` matches the manifest. |
| `registry_delegations` | `package_id`, `key`, `key_id`, `public_key`, `not_before`, `not_after`, `issuer`, `sig`, `root_key_id`, `updated_at` | The package's delegation to a sub-key, one per package (migration `0003_delegation`). FK → package, cascade. Served and trusted only while live. |
| `registry_revocation_lists` | `package_id`, `issued_at`, `revoked`, `key_id`, `delegation`, `sig`, `updated_at` | The package's signed list of revoked sub-key ids, one per package (migration `0003_delegation`). FK → package, cascade. Replaced only by a newer list that keeps every id. |
| `registry_retired_versions` | `namespace_id`, `package_slug`, `version`, `retired_at` | Ids of versions that were published and then deleted (migration `0002_retired_versions`). PK on the first three. FK → namespace, no cascade: the row outlives the package. |
| `registry_uploads`      | `id`, `version_id`, `asset_name`, `size`, `sha256`, `sig`, `key_id`, `alg`, `run`, `exec`, `r2_upload_id`, `parts`, `expires_at`, `created_at` | In-flight multipart uploads; the row reserves quota. Removed on completion, abort or by the sweep. |
| `registry_token_grants` | `token_id`, `package_id`, `access`                                                                             | Narrows an `api_tokens` row to packages; `package_id` NULL = all of the owner's packages. Unique `(token_id, package_id)` plus a partial unique index for the NULL row. Both FKs cascade. Not in any backup. |
| `registry_quotas`       | `user_id`, `max_packages`, `max_storage_bytes`, `max_asset_bytes`, `updated_at`                                | Per-user overrides set by an administrator; NULL = platform default. |

### Shared infrastructure

Tables that no single module owns. They live in `apps/api/src/shared/schema.ts`
rather than under a module.

#### `rate_limits`
Fixed-window counters for the durable per-user limiter. `key`, `count`,
`reset_at` (epoch ms). `key` is `<resource>:<window>:<user-id>` — e.g.
`tuple:minute:u_123`, `token:hour:u_123` — so each resource carries its
own budget in each window. The row is a checkpoint of a counter held in
memory, written only when its value would change a decision (see
`creation-quota.ts`), and overwritten in place on the next window — so
cardinality is bounded by users × resources × windows and no sweep is
needed. Excluded from backups, like `auth_lockouts` — transient
security state, not user data.

## Schema scope

The current schema covers: accounts (users / groups / group memberships /
sessions / TOTP / preferences / PKCE state / auth lockouts), audit,
settings, Zanzibar tuples, items + item comments, files + file
references, the nine `registry_*` tables, and the shared `rate_limits`
counters.

Group membership lives in a dedicated `group_members` table owned by the
account module — separating it from `relation_tuples` lets a deployment
drop the policy module while keeping user-group features. The Zanzibar
engine reads `group:*#member` through that table; everything else still
hits `relation_tuples`.

A downstream project that needs additional content modules (tickets,
purchase orders, …) builds them on top of `item` — see
[`modules/item.md`](../modules/item.md) "Adding a sub-type" recipe.
