# File Module

Centralised blob storage for the whole app. Owns the bytes; every other
module references files by id. Built for **pluggable storage backends**
and **content-addressable deduplication**.

The module ships schema, the local storage driver, content dedupe,
refcount, async + sync GC, the presigned-download protocol, file routes,
and the permission-hook contract. The `item` module registers the
`item_attachment` hook so item attachments resolve permissions through
the `item` policy namespace. Disk quota is enforced via a single
`SELECT SUM(size) FROM files`.

## File layout

```text
apps/api/src/modules/file/
  schema.ts                  # files + file_references
  file.service.ts            # upload / addReference / release* / read helpers
  file.routes.ts             # GET /api/files/:id/metadata + /content
  file.backup.ts             # backup contribution
  gc.ts                      # async sweep over ref_count=0 candidates
  permission.ts              # consumer permission hook registry
  index.ts                   # boot wiring (initFileModule) + re-exports
  storage/
    types.ts                 # FileStorageDriver + PresignOptions
    registry.ts              # registerDriver / setActiveDriver / getActiveDriver
    key.ts                   # sha→storage_key derivation
    local.ts                 # built-in `local` driver
  file.test.ts
```

## Database

### `files`

| Column           | Type    | Notes                                                                                                              |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`             | text PK | ULID; same convention as `items.id`. Sort `id DESC` for newest-first.                                              |
| `sha256`         | text    | Lowercase hex (64 chars). Content key.                                                                              |
| `size`           | integer | Bytes.                                                                                                              |
| `mimetype`       | text    | Declared + magic-byte verified at upload.                                                                            |
| `storage_driver` | text    | `'local'` (built-in). Downstream projects register `s3` / `azure-blob` / etc.                                       |
| `storage_key`    | text    | Driver-internal address. Local driver maps to `<root>/<ab>/<cd>/<sha>`.                                              |
| `ref_count`      | integer | Materialised count of `file_references` rows. Async GC sweeps `ref_count = 0`.                                       |
| `uploaded_by`    | text FK | First uploader; informational. `users.id ON DELETE CASCADE`.                                                         |

Indexes: `UNIQUE(sha256, storage_driver)` — enables dedupe per backend;
`(sha256)`, `(storage_driver)`, partial `(id) WHERE ref_count = 0`.

There is **no** `created_at` column. The ULID prefix carries the upload
millisecond.

### `file_references`

The reverse table that doubles as the **attachment registry** for every
consumer. The file module's GC scans this table to maintain `ref_count`;
consumers query it directly to "list attachments on this owner". There is
**no separate `item_attachments` table** — for items, the attachment is
just a row here with `owner_type = 'item_attachment'`, `owner_id =
<item.id>`.

| Column        | Type    | Notes                                                                                                             |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`          | text PK | 8-char nanoid. External attachment id (URL surface).                                                              |
| `file_id`     | text FK | `files.id ON DELETE RESTRICT`. Releases go through `FileService`, not raw FK cascade.                              |
| `owner_type`  | text    | Discriminator. Currently `'item_attachment'` (item-level) and `'item_comment_attachment'` (per-comment); future: `'user_avatar'`, …                                              |
| `owner_id`    | text    | Consumer-side primary key. For `item_attachment`, this is `items.id`.                                              |
| `filename`    | text    | Per-reference display filename. Same blob can appear under different names on different owners.                    |
| `metadata`    | text    | Opaque JSON ('{}' default) — consumer-controlled per-reference extras.                                              |
| `created_by`  | text FK | `users.id`.                                                                                                       |
| `created_at`  | text    | ISO.                                                                                                              |

Indexes: `UNIQUE(owner_type, owner_id, file_id)` — same blob can only
appear once on any given owner; `(owner_type, owner_id)`, `(file_id)`.

## Storage drivers

A driver implements the `FileStorageDriver` interface in
`storage/types.ts`:

```ts
interface FileStorageDriver {
  readonly name: string;
  put(key, data: ArrayBufferLike): Promise<void>;
  getStream(key): Promise<ReadableStream<Uint8Array>>;
  delete(key): Promise<void>;
  exists(key): Promise<boolean>;
  presignDownload?(key, opts: PresignOptions): Promise<string>;
}
```

Drivers register themselves via `registerDriver(...)` and the active one
is selected at boot from `Config.FILE_STORAGE_DRIVER`. Downstream
projects add an S3 / Azure / GCS driver in their own code — no fork of
`apps/api/src/modules/file/` required.

The built-in `local` driver:

- `storage_key` shape: `<ab>/<cd>/<sha>` (two-level fanout keeps any one
  directory below ~4 000 entries even at 100 M uploads).
- Two-phase writes (`tmp → rename`) so a crash between write and DB
  insert leaves a sweepable `.tmp` rather than an orphan at the final
  name.
- 0o700 directory perms (cleartext blob tree is readable only by the
  runtime user — matters when DB encryption is on).
- No `presignDownload` — downloads always stream through the API.

## Service surface

All methods take `db: AppDatabase` as the first argument.

| Method                                                                                  | What it does                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uploadAndReference({ file, ownerType, ownerId, uploadedBy, metadata? })`               | Magic-byte sniff, size + quota check, sha256, find-or-create `files`, write `file_references`. Returns `{ file, reference, deduped }`. Atomic in one tx.   |
| `addReference({ fileId, ownerType, ownerId, filename?, metadata?, createdBy })`         | Adds a second reference to an existing `files` row (no upload). Bumps `ref_count`.                                                                          |
| `releaseReference({ referenceId })`                                                     | Drops one reference. `ref_count = 0` triggers immediate blob delete in sync mode; async mode waits for the sweeper. Idempotent.                              |
| `releaseAllByOwner(ownerType, ownerId)`                                                 | Drops every reference for a single owner. Used when the parent resource is hard-deleted.                                                                     |
| `getFileById(id)` / `getReferenceById(id)`                                              | Lookups; no permission check (caller's responsibility).                                                                                                     |
| `listReferencesByOwner(ownerType, ownerId)`                                             | "All attachments on this owner" — `(owner_type, owner_id)`-indexed.                                                                                          |
| `buildDownloadResponse(file, ref, { inline })`                                          | Streams the body or 302s to a presigned URL (when the driver supports presign + `FILE_PRESIGN_ENABLED=true`). MIME-safety: script-bearing types forced to octet-stream. |
| `totalStoredBytes()`                                                                    | `SUM(files.size)` — drives the global upload quota.                                                                                                          |
| `runFileGcOnce(limit)`                                                                  | One sweeper pass; collects up to `limit` `ref_count = 0` blobs. Called from the periodic timer and from tests / admin tools.                                  |

`FileService` performs **no** permission checks of its own. Consumer
routes resolve "can this actor upload / read / delete?" against their
own model and call the service.

## Routes

`POST /files` is intentionally **not exposed**. Every upload comes
through the parent resource's route (e.g. `POST /api/items/:id/attachments`)
so per-resource permission stays at the consumer boundary.

The file module ships two read endpoints:

| Method | Path                                          | Description                                                                                       |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/api/files/:id/metadata?ref=<refId>`         | Returns `{ id, size, mimetype, filename, ownerType, ownerId, createdAt }` after permission check. |
| GET    | `/api/files/:id/content?ref=<refId>[&inline=true]` | Streams or 302-presigns. Inline-safe MIME logic mirrors the existing attachment routes.        |

Both require `?ref=<reference_id>` so the route can resolve the consumer
relationship and run that consumer's permission hook before serving.

## Permission hooks

`mod-file` does not know what an item / avatar / signature is. Each
consumer registers a hook keyed on `owner_type`:

```ts
import { registerFilePermissionHook } from "@/modules/file";

registerFilePermissionHook("item_attachment", {
  async canRead(db, actor, ref) { /* ... */ },
  async canDelete(db, actor, ref) { /* ... */ },
});
```

When no hook is registered for an `owner_type`, the file routes return
404 (so the existence of an unclaimed `owner_type` is not leaked).

The `item` module's hook (`apps/api/src/modules/item/attachment.permission.ts`)
delegates to the `policy` engine:

- `canRead`  → `check('item', ref.owner_id, 'viewer', 'user', actor.id)`
- `canDelete`→ `check('item', ref.owner_id, 'editor', 'user', actor.id)`

Admin bypass lives in the hook (not in `mod-file`).

## Garbage collection

`releaseReference` only marks the file as a candidate (`ref_count--`).
Actual blob removal happens in one of two ways:

- **`FILE_GC_MODE=async`** (default) — `gc.ts` runs every
  `FILE_GC_INTERVAL_SECONDS` (default 3600), batches up to 500 rows per
  pass, deletes the blob from the driver, then drops the `files` row.
  Drift across `ref_count` and `file_references` is reconciled at the
  same time. This is the right default for remote backends that bill
  per-delete.
- **`FILE_GC_MODE=sync`** — the foreground request also calls
  `driver.delete(...)`. Used in tests and local-only deployments. Opt-in.

The partial index `(id) WHERE ref_count = 0` keeps the candidate scan
cheap even when the `files` table grows large.

## Presigned downloads

When the active driver implements `presignDownload` AND
`FILE_PRESIGN_ENABLED=true` (default), `GET /api/files/:id/content`
returns `302 Location: <signed-url>` instead of streaming. The signed
URL is short-lived (`FILE_PRESIGN_TTL_SECONDS=300`), and the API
process never sees the bytes.

Permission is enforced at signing time via the consumer hook — re-issue
requires the hook to pass again. The short TTL is what makes this safe;
a leaked URL is dead in minutes.

`FILE_PRESIGN_ENABLED=false` forces every download through the API
(easier audit log, simpler firewalling). The built-in `local` driver
doesn't support presign and always streams.

## Configuration

| Env var                       | Default                | Notes                                                                            |
| ----------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `FILE_STORAGE_DRIVER`         | `local`                | Active driver name. Built-in: `local`. Others must `registerDriver` at boot.     |
| `FILE_STORAGE_LOCAL_ROOT`     | `data/uploads/files`   | Local-driver root. Resolved against project root when relative.                  |
| `FILE_GC_MODE`                | `async`                | `async` (sweeper) or `sync` (foreground delete).                                  |
| `FILE_GC_INTERVAL_SECONDS`    | `3600`                 | Sweeper interval. `0` disables the periodic sweep (manual only).                  |
| `FILE_PRESIGN_ENABLED`        | `true`                 | Presign downloads when the driver supports it.                                    |
| `FILE_PRESIGN_TTL_SECONDS`    | `300`                  | Signed-URL lifetime.                                                              |
| `MAX_UPLOAD_BYTES`            | `10485760` (10 MiB)    | Per-file size cap. Existing global setting; the file module honours it.            |
| `MAX_ATTACHMENTS_PER_RESOURCE`| `20`                   | Per-owner reference cap.                                                          |
| `UPLOADS_TOTAL_BYTES`         | `0` (unlimited)        | Global disk quota — `SUM(files.size)`.                                            |

## Recipe — wire up a new file consumer

1. Pick an `owner_type` (kebab-style snake_case is conventional: `user_avatar`, `signature_image`).
2. Register a permission hook at module load:

   ```ts
   import { registerFilePermissionHook } from "@/modules/file";
   registerFilePermissionHook("user_avatar", { canRead, canDelete });
   ```

3. On upload, call `FileService.uploadAndReference({ ownerType: "user_avatar", ownerId: <user.id>, ... })`.
4. On read, list references for the owner: `FileService.listReferencesByOwner("user_avatar", userId)`.
5. On delete (single), `FileService.releaseReference({ referenceId })`.
6. On cascade (parent removed), `FileService.releaseAllByOwner("user_avatar", userId)`.
7. Download URL: `GET /api/files/:fileId/content?ref=<referenceId>` — the registered hook gates access.

## What `mod-file` deliberately does NOT do (v1)

- **Pluggable backends beyond `local`** — the interface is stable; S3 /
  Azure / GCS land as separate driver files in downstream projects.
- **Image transforms / thumbnails / EXIF stripping**.
- **Virus / malware scanning**. A future `onBeforeStore` hook can plug ClamAV.
- **Block-level dedupe / compression**. Content-level dedupe via sha256 is plenty.
- **Streaming upload + hash** — the current 10 MiB per-file cap keeps memory bounded; streaming is a follow-up.
- **`POST /files` public route**. Uploads route through parent resources.

## See also

- [`item.md`](./item.md) — the first consumer; registers the `item_attachment` hook.
- [`policy.md`](./policy.md) — what the `item_attachment` hook delegates to.
