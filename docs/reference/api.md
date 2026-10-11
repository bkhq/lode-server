# API

> Examples below omit any `BASE_PATH` prefix. When `BASE_PATH=/app` is set,
> the API mounts under `/app/api/...`; with `BASE_PATH` unset (default)
> the API is at `/api/...`.

This document is the narrative API surface — request bodies, response
shapes, access rules. The flat per-route index is generated as
[`api-routes.md`](api-routes.md) (CI fails if it drifts from the Hono
routes table); the tables below are hand-maintained alongside it.

## Response shape

Most JSON endpoints return:

```json
{
  "success": true,
  "data": {}
}
```

Paginated endpoints add `meta`:

```json
{
  "success": true,
  "data": [],
  "meta": { "total": 0, "page": 1, "limit": 20 }
}
```

Errors use the shared error handler:

```json
{
  "success": false,
  "error": { "code": "NOT_FOUND", "message": "Resource not found" }
}
```

## Access levels

| Level         | Meaning                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Public        | No session required.                                                                                      |
| Setup         | Available before the encrypted database is unlocked.                                                      |
| Authenticated | Requires a valid session cookie.                                                                          |
| Admin         | Requires a valid session and `user.role === "admin"`.                                                     |
| API Token     | A personal API token (`Authorization: Bearer pat_…`) may call the route instead of a session, within its scopes. On registry routes the token additionally needs a package grant at the level shown (`read` < `write` < `admin`). |
| Service Token | Requires a scoped bearer (`SERVICE_TOKEN_METRICS` for `/api/metrics`, `SERVICE_TOKEN_BACKUP` for `/api/backup/export-via-token`). For non-interactive tooling (scrapers, backup). |

Every "Authenticated" / "Admin" route is mounted under `protectedRoutes`,
which itself wraps a `requireUnlocked` guard — they're unreachable until
the database is decrypted.

## System and setup

| Method | Path                                       | Access        | Description                                                                                                                            |
| ------ | ------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                              | Public        | **Liveness** probe. Always returns `200 {status:"ok"}`. Use this for `livenessProbe` / Docker `HEALTHCHECK`.                              |
| GET    | `/api/health/ready`                        | Public        | **Readiness** probe. Returns `200 {status:"ready"}` when the DB is unlocked and reachable; `503 {status:"locked"\|"no_db"\|"db_unavailable"}` otherwise. Use this for `readinessProbe` / load-balancer pool membership. |
| GET    | `/api/encryption/status`                   | Public        | Encryption init + lock state. Trimmed payload — no `kdfSalt` / `encryptedDek` / challenge leak.                                          |
| POST   | `/api/encryption/init`                     | Setup         | First-time encrypted database initialization. Gated by bootstrap token (single-use, written to `<data dir>/bootstrap-token.txt`).        |
| POST   | `/api/encryption/unlock-challenge`         | Public, rate-limited | Returns `{challenge, encryptedDek, kdfSalt}` — the bundle the SPA needs to perform an unlock attempt.                              |
| POST   | `/api/encryption/unlock`                   | Public, rate-limited | Unlocks the encrypted database with the challenge response.                                                                       |
| GET    | `/api/system/version`                      | Admin         | Build provenance (commit hash, build time). Same content as `app --version` in the standalone binary.                                    |
| GET    | `/api/system/upload-limits`                | Authenticated | `{ maxFileSize, maxAttachmentsPerResource, totalQuota }`. Frontend reads this to render client-side hints.                              |
| GET    | `/api/metrics`                             | Service Token | Prometheus text exposition. Returns 503 when `SERVICE_TOKEN_METRICS` is unset.                                                                   |

## Account

### Authentication

| Method | Path                                       | Access        | Description                                                       |
| ------ | ------------------------------------------ | ------------- | ----------------------------------------------------------------- |
| GET    | `/api/account/auth/mode`                   | Public        | Reports the active login mode (`oauth` or `single-user`) so the SPA picks the right form. |
| GET    | `/api/account/auth/login`                  | Public        | Starts OAuth login.                                                |
| GET    | `/api/account/auth/callback`               | Public        | Handles OAuth callback and creates a local session.                |
| POST   | `/api/account/auth/login-local`            | Public, rate-limited | Single-user login (`username` + `password`). Active only when `SINGLE_USER_MODE=true`. |
| POST   | `/api/account/auth/logout`                 | Authenticated | Deletes the local session.                                         |
| GET    | `/api/account/auth/logout-url`             | Public        | Returns the configured upstream logout URL.                         |
| POST   | `/api/account/auth/totp/verify`            | Public, rate-limited | Completes the login-time TOTP challenge.                    |

### Current user

| Method | Path                                                | Access        | Description                                                |
| ------ | --------------------------------------------------- | ------------- | ---------------------------------------------------------- |
| GET    | `/api/account/me`                                   | Authenticated | Current user profile with groups.                          |
| GET    | `/api/account/me/groups`                            | Authenticated | Current user's groups.                                     |
| GET    | `/api/account/me/preferences/:key`                  | Authenticated | Reads one current-user preference.                         |
| PUT    | `/api/account/me/preferences/:key`                  | Authenticated | Writes one current-user preference.                        |
| GET    | `/api/account/me/totp`                              | Authenticated | Lists current-user TOTP devices.                            |
| POST   | `/api/account/me/totp`                              | Authenticated | Creates a TOTP setup.                                      |
| POST   | `/api/account/me/totp/:deviceId/confirm`            | Authenticated, rate-limited | Confirms a newly created TOTP device.        |
| DELETE | `/api/account/me/totp/:deviceId`                    | Authenticated | Deletes a current-user TOTP device.                         |
| POST   | `/api/account/me/totp/verify`                       | Authenticated, rate-limited | Verifies a current-user TOTP code for step-up flows. |

### Users and groups

| Method | Path                                       | Access        | Description                                                                                            |
| ------ | ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/api/account/visible-users`               | Authenticated | Active user directory exposed to every signed-in caller, for assignment and sharing pickers.            |
| GET    | `/api/account/users`                       | Admin         | Paginated user list.                                                                                    |
| GET    | `/api/account/users/:id`                   | Admin         | User detail.                                                                                            |
| PATCH  | `/api/account/users/:id`                   | Admin         | Updates role, status, or profile fields.                                                                |
| GET    | `/api/account/users/:id/groups`            | Admin         | Groups for a user.                                                                                      |
| GET    | `/api/account/groups`                      | Admin         | Group list.                                                                                             |
| POST   | `/api/account/groups`                      | Admin         | Creates a group.                                                                                        |
| GET    | `/api/account/groups/:id`                  | Admin         | Group detail.                                                                                           |
| PATCH  | `/api/account/groups/:id`                  | Admin         | Updates a group.                                                                                        |
| DELETE | `/api/account/groups/:id`                  | Admin         | Deletes a group.                                                                                        |
| GET    | `/api/account/groups/:id/members`          | Admin         | Group members.                                                                                          |
| POST   | `/api/account/groups/:id/members`          | Admin         | Adds a user to a group.                                                                                 |
| DELETE | `/api/account/groups/:id/members/:userId`  | Admin         | Removes a user from a group.                                                                            |

## Policy (Zanzibar tuples)

All policy routes are admin-only.

| Method | Path                                                            | Description                                                  |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/api/policy/tuples`                                            | Lists relation tuples.                                       |
| POST   | `/api/policy/tuples`                                            | Creates a relation tuple.                                    |
| PATCH  | `/api/policy/tuples/:id`                                        | Replaces a tuple's relation (delete + insert).                |
| DELETE | `/api/policy/tuples/:id`                                        | Deletes a relation tuple.                                    |
| POST   | `/api/policy/tuples/batch`                                      | Batch create + delete of relation tuples.                     |
| POST   | `/api/policy/check`                                             | Zanzibar permission check.                                   |
| POST   | `/api/policy/expand`                                            | Expand a relation tree.                                      |
| GET    | `/api/policy/users/:id/access`                                  | Relation tuples where the user is the subject.                |
| GET    | `/api/policy/groups/:id/access`                                 | Relation tuples where the group is the subject.               |
| GET    | `/api/policy/manifest`                                          | Permission manifest (resources, actions, namespaces) — drives the admin UI. |
| GET    | `/api/policy/entities`                                          | Lists users / groups / resource_groups for the policy UI.     |
| GET    | `/api/policy/resource-groups`                                   | Lists resource groups.                                       |
| POST   | `/api/policy/resource-groups`                                   | Creates a resource group.                                    |
| PATCH  | `/api/policy/resource-groups/:id`                               | Renames a resource group.                                    |
| DELETE | `/api/policy/resource-groups/:id`                               | Deletes a resource group.                                    |
| GET    | `/api/policy/resource-groups/:id/members`                       | Lists resource group members.                                |
| POST   | `/api/policy/resource-groups/:id/members`                       | Adds a resource group member.                                |
| DELETE | `/api/policy/resource-groups/:id/members/:tupleId`              | Removes a resource group member.                              |

## Items, files, and content sub-types

Items, the `file` module, and content sub-types form one architectural
layer. See [`modules/item.md`](../modules/item.md) and
[`modules/file.md`](../modules/file.md) for the design rationale. The `item`
module mounts no routes of its own, and the template's reference sub-types
(`issue` / `document`) were removed in this fork, so the file read endpoints
below are the only public API surface of this layer today.

### Files (low-level)

Uploads are always issued through a parent resource route (e.g.
`POST /api/<sub-type>/:id/attachments`) — the consumer route owns the
permission boundary. The two endpoints below are the read surface for
content that has already been uploaded; both require a `ref=<reference id>`
query parameter so the registered permission hook can resolve the consumer
context. The active permission hook for `item_attachment` references
delegates to the `policy` engine.

| Method | Path                                       | Access        | Description                                                                                                |
| ------ | ------------------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/api/files/:id/metadata?ref=<refId>`      | Authenticated | `{ id, size, mimetype, filename, ownerType, ownerId, createdAt }` if the actor can read the reference's owner. |
| GET    | `/api/files/:id/content?ref=<refId>`       | Authenticated | Streams or 302-presigns. `inline=true` for inline-safe types. Presigning kicks in when the active driver supports it AND `FILE_PRESIGN_ENABLED=true`. |

## Settings

All settings routes require admin access.

| Method | Path                                       | Description                                              |
| ------ | ------------------------------------------ | -------------------------------------------------------- |
| GET    | `/api/settings`                            | Lists settings, with sensitive values masked.            |
| GET    | `/api/settings/:key`                       | Reads one setting.                                       |
| PUT    | `/api/settings/:key`                       | Creates or updates one setting.                          |
| DELETE | `/api/settings/:key`                       | Deletes one setting.                                     |

## Audit

All audit routes require admin access.

| Method | Path                                       | Description                                              |
| ------ | ------------------------------------------ | -------------------------------------------------------- |
| GET    | `/api/audit`                               | Lists audit events.                                      |
| GET    | `/api/audit/:id`                           | Audit event detail.                                      |

## Encryption administration

Admin-only after the full app is unlocked.

| Method | Path                                       | Description                                                                                          |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| POST   | `/api/encryption/challenge`                | Creates an ephemeral challenge for sensitive encryption operations.                                  |
| GET    | `/api/encryption/meta`                     | Returns encrypted key metadata for admins.                                                            |
| POST   | `/api/encryption/rotate-dek`               | Rotates the data encryption key. **Gated by `ENABLE_EXPERIMENTAL_DEK_ROTATION`** — returns 501 when off. |
| POST   | `/api/encryption/change-master`            | Changes the master public key.                                                                       |

## Backup

| Method | Path                                       | Access        | Description                                                                                            |
| ------ | ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/api/backup/modules`                      | Admin         | Lists exportable backup modules (with `name` + `deps`).                                                  |
| POST   | `/api/backup/export`                       | Admin         | Exports selected modules as JSON.                                                                       |
| POST   | `/api/backup/export-via-token`             | Service Token | Same payload as `/backup/export`, gated by `SERVICE_TOKEN_BACKUP` instead of session — for backup tooling.       |
| POST   | `/api/backup/import`                       | Admin         | Imports a JSON backup file.                                                                             |

## Cron jobs

All cron routes require admin access. See [`modules/cron.md`](../modules/cron.md) for action registration, audit codes, and lifecycle.

| Method | Path                                       | Description                                                                                              |
| ------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| GET    | `/api/cron/actions`                        | Lists registered actions, supported cron formats, a human-readable help string, and `schedulerEnabled` (false when the API was started with `CRON_ENABLED=false` — admins can still write jobs; ticks are paused). |
| GET    | `/api/cron/jobs`                           | Cursor-paginated job list. `?deleted=true\|false\|only` toggles soft-deleted visibility; `?cursor` + `?limit` page. |
| POST   | `/api/cron/jobs`                           | Create. Body: `{ name, cron, action, config?, maxConsecutiveFailures? }`. `maxConsecutiveFailures` (integer 0..100, default 3) sets the per-job retry policy — see [`modules/cron.md` § Retry policy](../modules/cron.md#retry-policy). Errors: `INVALID_CRON` / `JOB_NAME_CONFLICT` / `INVALID_ACTION_CONFIG`. |
| DELETE | `/api/cron/jobs/:id`                       | Soft delete (sets `is_deleted=true`, `enabled=false`, detaches from Baker). `:id` accepts nanoid or `name`. |
| GET    | `/api/cron/jobs/:id/logs`                  | Cursor-paginated run history. `?status=running\|success\|failed` filters.                                |
| POST   | `/api/cron/jobs/:id/trigger`               | Manual run. Returns the freshly-written log row. Does not block on overlapping scheduled ticks — see [`modules/cron.md`](../modules/cron.md) for the rationale. |
| POST   | `/api/cron/jobs/:id/pause`                 | Disable: `enabled=false` + `baker.pause(...)`.                                                            |
| POST   | `/api/cron/jobs/:id/resume`                | Re-enable: `enabled=true` + `scheduler.syncJob(...)`.                                                     |

## Registry

The lode release registry. See [`modules/registry.md`](../modules/registry.md)
for the model, the upload flows, the error codes and the audit actions.
`:ns` is the caller's system-assigned namespace id, `:pkg` a package slug.

"Session" below means a signed-in session only — a token is refused with 403.
"Token (level)" means the route also accepts a personal API token whose grant
on the package is at least that level; a session needs the same level on the
package (its owner and platform administrators have every level). A private
package the caller cannot read answers 404 on every route.

| Method | Path                                                        | Access                         | Description |
| ------ | ----------------------------------------------------------- | ------------------------------ | ----------- |
| GET    | `/api/registry/namespace`                                   | Session                        | `{ namespace: { slug, status, created_at } }`. Assigned by the system on first use (8 characters, `[a-z][a-z0-9]{7}`); there is no claim or rename route. |
| GET    | `/api/registry/keys`                                        | Session                        | The caller's signing keys, revoked ones included. |
| POST   | `/api/registry/keys`                                        | Session                        | Register an ed25519 public key. Body: `{ public_key, name }`. Errors: `INVALID_PUBLIC_KEY` (400), `KEY_EXISTS` (409). |
| DELETE | `/api/registry/keys/:id`                                    | Session                        | Revoke (final). |
| GET    | `/api/registry/packages`                                    | Session, Token (read)          | The caller's packages; with a token, the packages it has a grant on. |
| POST   | `/api/registry/packages`                                    | Session                        | Create. Body: `{ slug, name, visibility?, description?, require_signature? }`. `slug` is permanent, the `:pkg` segment and the manifest `name`. Errors: `PACKAGE_EXISTS`, `PACKAGE_QUOTA_EXCEEDED` (409). |
| GET    | `/api/registry/packages/:ns/:pkg`                           | Session, Token (read)          | Package metadata. Public packages are readable by every signed-in user. |
| PATCH  | `/api/registry/packages/:ns/:pkg`                           | Session, Token (admin)         | Change `name`, `visibility`, `description`, `require_signature`. |
| DELETE | `/api/registry/packages/:ns/:pkg`                           | Session (owner or admin)       | Delete the package and everything under it, stored bytes included. |
| GET    | `/api/registry/quota`                                       | Session                        | `{ limits: { max_packages, max_storage_bytes, max_asset_bytes }, usage: { packages, storage_bytes } }`. |
| GET    | `/api/registry/tokens`                                      | Session                        | The caller's personal tokens with `grants`, expiry and last use. |
| POST   | `/api/registry/tokens`                                      | Session                        | Create. Body: `{ name, expires_at?, grants }` where `grants` is `{ all: <level> }` or `[{ package: "<ns>/<pkg>", access: <level> }]`. The secret is returned once, in `token`. Error: `INVALID_GRANT` (422). |
| PUT    | `/api/registry/tokens/:id`                                  | Session                        | Replace the grants. Body: `{ grants }`. The secret is not reissued. |
| DELETE | `/api/registry/tokens/:id`                                  | Session                        | Revoke. |
| GET    | `/api/registry/packages/:ns/:pkg/versions`                  | Session, Token (read)          | `{ versions, channels }` — every version with its assets, drafts and yanked ones included. |
| POST   | `/api/registry/packages/:ns/:pkg/versions`                  | Session, Token (write)         | Create a draft. Body: `{ version, notes? }`. Errors: `VERSION_EXISTS` (409), `VERSION_RETIRED` (409). |
| GET    | `/api/registry/packages/:ns/:pkg/versions/:ver`             | Session, Token (read)          | `{ version, channels }`. |
| DELETE | `/api/registry/packages/:ns/:pkg/versions/:ver`             | Session, Token (write) for a draft; Session (owner or admin) otherwise | Delete a version; the id of a published or yanked one is retired. Error: `VERSION_IN_CHANNEL` (409). |
| PUT    | `/api/registry/packages/:ns/:pkg/versions/:ver/assets/:asset` | Session, Token (write)       | Single-request upload, up to 95 MiB: raw body, `Content-Length` required, query `sha256` (lowercase hex) and optional `sig`, `run`, `exec`. 201 new, 200 replaced. Errors: 411 `LENGTH_REQUIRED`, 413 `SINGLE_REQUEST_TOO_LARGE` / `ASSET_TOO_LARGE`, 409 `STORAGE_QUOTA_EXCEEDED` / `VERSION_NOT_DRAFT` / `VERSION_BUSY`, 400 `INVALID_SIGNATURE` / `SIGNATURE_REQUIRED`, 422 `DIGEST_MISMATCH`. |
| DELETE | `/api/registry/packages/:ns/:pkg/versions/:ver/assets/:asset` | Session, Token (write)       | Remove an asset from a draft. |
| POST   | `/api/registry/packages/:ns/:pkg/versions/:ver/uploads`     | Session, Token (write)         | Start a multipart upload. Body: `{ asset, size, sha256, sig?, run?, exec? }` → 201 `{ uploadId, partSize, partCount }` (`partSize` is 67108864). Checked like the single-request upload. |
| PUT    | `/api/registry/uploads/:uploadId/parts/:n`                  | Session, Token (write)         | Upload part `n`: raw body of exactly that part's size. Errors: 422 `INVALID_PART_SIZE` / `INVALID_PART_NUMBER` / `PART_REJECTED`, 409 `UPLOAD_EXPIRED`. |
| POST   | `/api/registry/uploads/:uploadId/complete`                  | Session, Token (write)         | Assemble, verify the whole-object digest, create the asset. Errors: 409 `UPLOAD_INCOMPLETE` / `UPLOAD_EXPIRED` / `UPLOAD_UNUSABLE` / `VERSION_NOT_DRAFT`, 422 `DIGEST_MISMATCH`. |
| DELETE | `/api/registry/uploads/:uploadId`                           | Session, Token (write)         | Abort. |
| POST   | `/api/registry/packages/:ns/:pkg/versions/:ver/publish`     | Session, Token (write)         | Body: `{ channel }`. Publishes the draft and moves the pointer in one transaction. Errors: `VERSION_EMPTY`, `VERSION_NOT_DRAFT` (409). |
| PUT    | `/api/registry/packages/:ns/:pkg/channels/:channel`         | Session, Token (write)         | Body: `{ version }`. Promote or roll back a pointer. Error: `VERSION_NOT_PUBLISHED` (409). |
| POST   | `/api/registry/packages/:ns/:pkg/versions/:ver/yank`        | Session, Token (admin)         | Hide a published version from the feed. Error: `VERSION_IN_CHANNEL` (409). |
| POST   | `/api/registry/packages/:ns/:pkg/versions/:ver/restore`     | Session, Token (admin)         | Put a yanked version back. Error: `VERSION_NOT_YANKED` (409). |

### Registry administration

All require an admin session; no token reaches them. An administrator acts on
any package through the routes above.

| Method | Path                                                | Description |
| ------ | --------------------------------------------------- | ----------- |
| GET    | `/api/registry/admin/namespaces`                    | Every namespace with `owner`, `packages` and `storage_bytes`. |
| POST   | `/api/registry/admin/namespaces/:slug/suspend`      | Suspend: the feed answers 404, the owner is read-only (`NAMESPACE_SUSPENDED`, 403), the owner's tokens are refused. |
| POST   | `/api/registry/admin/namespaces/:slug/restore`      | Restore a suspended namespace. |
| GET    | `/api/registry/admin/packages`                      | Every package with `owner` and `storage_bytes`. |
| GET    | `/api/registry/admin/users/:userId/quota`           | `{ user_id, override, limits, usage }`. |
| PUT    | `/api/registry/admin/users/:userId/quota`           | Replace the override. Body: `{ max_packages?, max_storage_bytes?, max_asset_bytes? }`; omitted or null falls back to the platform default. |
| GET    | `/api/registry/admin/tokens`                        | Any user's tokens with grants; `?user_id=` narrows. |
| DELETE | `/api/registry/admin/tokens/:id`                    | Revoke any token. |

## Registry read feed

The lode-facing feed is served at `/r`, outside `/api` (under `BASE_PATH`
when one is set), through the raw-app builder: no session, cookie, CSRF,
CORS or policy middleware, only the per-client raw rate limit
(`RAW_API_RATE_LIMIT_PER_MINUTE`). It is read-only; any other method or path
under `/r` answers a JSON 404. Because it is not under `/api`, it is absent
from the generated [`api-routes.md`](api-routes.md).

| Method | Path                           | Access                              | Description |
| ------ | ------------------------------ | ----------------------------------- | ----------- |
| GET    | `/r/:ns/:pkg/manifest.json`    | Public, or read token (private)     | The generated `lode/v1` manifest: `name` is the package slug, `channels.<c>.latest`, `versions.<v>` with optional `notes` and `assets[]` (`name`, absolute same-host `url`, `sha256`, `size`, and `sig` / `key_id` / `alg` / `run` / `exec` only when the asset has them). Published versions only, newest first, capped at `REGISTRY_MANIFEST_MAX_VERSIONS` plus every channel target. |
| GET    | `/r/:ns/:pkg/:ver/:asset`      | Public, or read token (private)     | The asset bytes, streamed from the blob store: `Content-Type: application/octet-stream`, `Content-Length`. Only assets of published versions; a draft's or a yanked version's answer 404. |

- **Access.** A public package is served anonymously. A private one needs
  `Authorization: Bearer pat_…`, a personal API token holding a `read` grant
  (or higher) on the package; a session cookie is never looked at. A missing
  or ungranted token, an unknown namespace, package, version or asset, and
  anything in a suspended namespace all answer the same
  `404 { "success": false, "error": { "code": "NOT_FOUND", "message": "Not found" } }`.
- **Caching.** A public manifest carries a strong `ETag` (SHA-256 of the
  body) and `Cache-Control: public, max-age=60`, and answers a matching
  `If-None-Match` with 304. A public asset is
  `Cache-Control: public, max-age=31536000, immutable`. Every answer for a
  private package is `Cache-Control: private, no-store`, without an `ETag`.
- **URLs.** Asset urls are `<origin><BASE_PATH>/r/<ns>/<pkg>/<ver>/<asset>`,
  the origin being `APP_URL` (required in production) or, outside
  production, the request's own host.

## Implemented module layout

```text
apps/api/src/modules/
  account/
    auth/
    users/
    groups/
  audit/
  backup/
  cron/
  encryption/
  file/            # blob storage; pluggable drivers + content dedupe
  item/            # base for content sub-types
  policy/
  registry/        # lode release registry; blob/ holds its own storage seam
  settings/
  system/
```
