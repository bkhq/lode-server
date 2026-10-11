# 20261009-2241-lode-registry-server Multi-user lode package registry on Cloudflare Workers

- **status**: completed
- **createdAt**: 2026-10-09 22:41
- **approvedAt**: 2026-10-09 23:08
- **relatedTask**: 20261009-2241-lode-registry-server

## Context

### Goal

A hosted, multi-user release registry for [lode](https://github.com/dotns/lode): every user gets a namespace and manages their own packages, publishing from CI; a platform administrator manages users and every package; operators point `lode.toml` at it. Built on `zzci/bun-tpl`, deployed on Cloudflare Workers.

### What lode needs from a server (lode v0.3.3)

lode has two update sources; a self-hosted server is the **native manifest** source (`[update].manifest = "https://…/manifest.json"`). The client contract is read-only HTTP GET, so no lode change is required:

- `manifest.json`, schema `lode/v1`: `name`, `channels.<c>.latest`, `versions.<v>.assets[]` with `name`, `url`, `sha256`, optional `sig` / `key_id` / `alg` / `run` / `exec` / `size` / `auth` (`crates/lode-core/src/manifest.rs`, `docs/source-adapters.md` §6). Client caps the manifest at 32 MiB and an asset at 2 GiB.
- The operator selects an asset by exact filename (`[update].asset`); `format` is derived from the extension.
- Per-artifact signature over `lode.artifact.v1\n{name}\n{version}\n{sha256}\n{run}\n{exec}` (no trailing newline), ed25519 by default; `key_id` = first 16 hex of `sha256(pubkey)`; values are unpadded base64url, standard base64 accepted on input.
- The catalog signature (`lode.manifest.v1`) is optional and verify-if-present. Rollback of `latest` is guarded client-side by the downgrade floor.
- Version ids and `[runtime]` names must match `[A-Za-z0-9._-]`, no leading `.` or `-` (`idval.rs`). `run` / `exec` must be non-blank and free of control characters.
- `[http].headers` (e.g. `Authorization: Bearer …`) ride the manifest fetch and same-host asset downloads, so private packages work when assets are served from the manifest host.
- `manifest.name` must match the operator's `[global].app`.

Publishing today is a publisher-side job (`lode-cli sign` / `manifest` plus static hosting). The server replaces the hosting and catalog assembly; signing stays with the publisher.

### What bun-tpl already provides

- Bun monorepo: Hono API (`apps/api`), React 19 SPA (`apps/web`), Drizzle on SQLite, OpenAPI on every route, EN/ZH i18n, a `bun run check` gate, live e2e.
- A **Workers target** next to Bun (`docs/develop/runtime.md`): one Durable Object owns the SQLite database and runs the whole app, R2 for blobs, the SPA from the asset pipeline, `run_worker_first = ["/api/*"]`. `bun run test:workers` smoke-tests it in workerd.
- Multi-user account stack: OIDC login, sessions, TOTP, groups, **personal API tokens** (`Authorization: Bearer pat_…`) with module-registered, deny-by-default route scopes (`shared/lib/token-scopes.ts`).
- Zanzibar policy engine with module-registered namespaces, audit log, settings, backup contributions, creation quota and rate-limit middleware.
- A **raw API** (`/api/raw/*`): no CSRF, CORS, session or policy middleware, per-client rate limit only — the intended surface for other services.
- A module standard: four-file module, one-line aggregate-file entries, per-module doc and e2e (`docs/develop/module/playbook.md`), and a fork workflow that merges the upstream template forward (`docs/develop/forking.md`).

### Gaps the template does not cover

- The `file` module buffers each upload in memory (`file.arrayBuffer()`, `put(key, ArrayBufferLike)`) and defaults to a 10 MiB cap. Release assets are tens of megabytes and the Durable Object has 128 MB, so assets need a streaming blob path of their own.
- Workers cap the request body at 100 MB on Free/Pro plans (200 MB Business, 500 MB Enterprise). Assets up to 500 MiB are required, so larger uploads must be split across requests.
- The template has an `admin` role and a user-administration UI (list, disable, groups), but nothing that spans other users' content.
- Every request runs through one Durable Object. Fine at small scale; a hot download path will want an edge cache later.
- On Workers: no at-rest DB encryption, no in-process cron, PBKDF2 only. None of these are needed here.

## Proposal

### Shape

Fork bun-tpl into this repo and add one business module, `registry`. Keep the Bun target working — unit tests and local dev run on it — and treat Workers as the production target.

```text
publisher (CI)                         operator host
  lode-cli sign  ──►  PUT asset + sig     lode ──GET──► /r/<ns>/<pkg>/manifest.json
  PAT (packages:write)        │                  └─GET─► /r/<ns>/<pkg>/<ver>/<asset>
                              ▼                               ▲
                 Worker ──► Durable Object (Hono app + SQLite) ┘
                                   │
                                   └──► R2 bucket (asset bytes)
```

### Trust model

- The server never holds a private key. Publishers sign locally; the server stores the signature and serves it inline in the manifest.
- Signing is **optional**. A package has `require_signature` (default off); an asset may be uploaded unsigned and is then served without `sig`, which lode installs only under `require_signature = off`, or `auto` with no trusted keys.
- Each package has its own signing keys. When an upload carries a signature, the server rebuilds the `lode.artifact.v1` message and rejects it unless it verifies under one of the package's active keys. A signature is never stored unverified: a bad one would fail on every operator host instead of once at publish time.
- Operators still pin `trusted_keys` and set `require_signature = "enforce"`. A compromised server can then withhold or replay, but cannot forge an artifact; replay of `latest` is caught by lode's downgrade floor.
- No catalog signature is produced (it needs the publisher's key over the whole catalog). It is optional in lode; revisit only if a client-side `manifest-sign` round trip is wanted.
- v1 verifies **ed25519 only** (native WebCrypto on Workers and Bun). ECDSA keys are rejected at registration until a later milestone.

### Data model (module `registry`)

| Table | Columns (key ones) | Notes |
|---|---|---|
| `registry_namespaces` | `id`, `slug` (unique), `owner_user_id`, `status` (`active` / `suspended`), `created_at` | Assigned by the system, one per user, when first needed: 8 random characters, lowercase letters and digits, starting with a letter. Never chosen and immutable, so URLs stay stable whatever the IdP calls the user. A suspended namespace is not served. |
| `registry_keys` | `id`, `package_id`, `key_id`, `alg`, `public_key`, `name`, `revoked_at` | A package's signing keys; unique `(package_id, key_id)`; `key_id` derived server-side. |
| `registry_packages` | `id`, `namespace_id`, `slug`, `name`, `visibility` (`public` / `private`), `description`, `require_signature` (default off) | unique `(namespace_id, slug)`. `slug` is the URL segment and the manifest `name`; `name` is a free-text display name. |
| `registry_versions` | `id`, `package_id`, `version`, `status` (`draft` / `published` / `yanked`), `notes`, `published_at` | unique `(package_id, version)`. |
| `registry_assets` | `id`, `version_id`, `name`, `size`, `sha256`, `sig`, `key_id`, `run`, `exec`, `blob_key` | unique `(version_id, name)`; immutable once the version is published. |
| `registry_channels` | `package_id`, `name`, `version_id`, `updated_at` | PK `(package_id, name)`. |
| `registry_uploads` | `id`, `version_id`, `asset_name`, `size`, `sha256`, `sig`, `run`, `exec`, `r2_upload_id`, `parts` (JSON), `expires_at` | In-flight multipart uploads; removed on completion, aborted by a sweep after expiry. |
| `registry_token_grants` | `token_id` (FK `api_tokens`, cascade), `package_id` (null = every package the user owns, including future ones), `access` (`read` / `write` / `admin`) | unique `(token_id, package_id)`. Narrows a personal API token to packages; the template's `api_tokens` table is not altered. |
| `registry_quotas` | `user_id` PK, `max_packages`, `max_storage_bytes`, `max_asset_bytes` | Per-user overrides set by an administrator; absent row = platform defaults. |

A package slug allows lowercase letters, digits and `-` only, cannot start with `-`, and is unique within its namespace — two users may use the same slug. Versions and asset names are validated with lode's own rule (`[A-Za-z0-9._-]`, no leading `.` / `-`). `run` / `exec` are validated exactly as lode's `validate_command_override`.

Authorization uses a `package` policy namespace registered by the module (`owner`, `maintainer`, `reader`). v1 writes only the owner tuple; maintainer management is a later milestone. The exact registration API is confirmed against `docs/develop/module/policy-standard.md` in M1.

### Tokens and package access

There is one kind of token: the template's personal API token (`Authorization: Bearer pat_…`). The registry adds per-package access to it, so one token can serve several packages and CI needs nothing else.

- A token carries **grants**: a list of packages, each `read`, `write` or `admin`, or a single "all my packages" grant at one of those levels. Each level includes the ones before it. A token with no grant reaches no package.
- `read` — fetch the manifest and assets of a private package through `/r/…` (what an operator host puts in `[http].headers`) and read package metadata through the API.
- `write` — the release routes of that package: create and delete draft versions, upload assets (single-request and multipart), publish, move a channel pointer. It may also register and list that package's signing keys, so CI can add its own public key.
- `admin` — manage that package: description, visibility and `require_signature`, yank and restore versions. It cannot delete the package or a published version.
- Never open to tokens, whatever the grants: creating or deleting packages, deleting published versions, revoking signing keys, token management, quota and the platform-administration routes. Those need a signed-in session. A package `admin` grant is unrelated to the platform administrator role.
- Two checks apply to every token request. The template's scope check (`packages:read` / `packages:write` / `packages:admin`, deny-by-default by route) decides which routes a token may call; the registry's grant check decides which packages. The scopes are derived from the grants when the token is saved, so the user only ever configures packages.
- Multipart routes are addressed by `uploadId`; the grant check resolves the upload to its package first.
- A grant can only name a package the token's owner may manage. It is removed with the package, and a token stops working when its owner is disabled or the namespace is suspended.
- Audit entries record the token id alongside the user.

**Token page.** A dedicated page in the web UI lists the user's tokens with their grants, expiry and last use. Creating or editing a token is a package table with a read / write / admin selector per row, plus the "all my packages" switch; the secret is shown once at creation. Grants can be edited later without reissuing the secret. The template's existing token tab stays for non-registry scopes.

### Platform administration

The template's `admin` role (seeded by `DEFAULT_ADMIN`) is the platform administrator. User management — list, disable, groups — already exists and is kept. The registry adds, under `/api/registry/admin` and admin-only:

- list every namespace and package across users, with storage usage;
- act on any package as its owner would: change visibility, yank or delete versions, move channel pointers, delete the package;
- suspend or restore a namespace (its feed answers 404 while suspended);
- read and set a user's quota overrides;
- list and revoke any user's tokens.

Administrators pass every package permission check; ordinary users reach only packages in their own namespace. Each administrative action is written to the audit log with the acting admin and the target owner. Admin routes are not opened to API tokens.

### Quotas

Any signed-in user may publish. Platform defaults come from configuration — `REGISTRY_MAX_PACKAGES_PER_USER`, `REGISTRY_MAX_STORAGE_BYTES_PER_USER`, `REGISTRY_MAX_ASSET_BYTES` (default and hard ceiling 500 MiB) — and a `registry_quotas` row overrides them for one user. Usage is the sum of stored asset sizes plus the declared sizes of in-flight uploads, checked when an upload starts, so an over-quota upload is refused before any bytes are accepted.

### Draft → publish

A version is created as a **draft**, assets are uploaded into it, then one `publish` call flips it to `published` and moves the channel pointer in a single transaction. Without this, a lode client polling mid-release would see a `latest` whose asset for its platform does not exist yet and fail the update.

### API

Management — session, or a token where *Tokens and package access* allows it, under `/api/registry`:

| Method | Path | Purpose |
|---|---|---|
| `GET` `POST` | `/keys` | list / register a public key |
| `DELETE` | `/keys/:id` | revoke |
| `GET` `POST` | `/packages` | list mine / create |
| `GET` `PATCH` `DELETE` | `/packages/:ns/:pkg` | read / update visibility, description / delete |
| `GET` `POST` | `/tokens` | list my tokens with grants / create a token with grants (returns the secret once) — session only |
| `PUT` `DELETE` | `/tokens/:id` | replace a token's grants / revoke — session only |
| `POST` | `/packages/:ns/:pkg/versions` | create draft `{ version, notes }` |
| `PUT` | `/packages/:ns/:pkg/versions/:ver/assets/:asset` | single-request upload (up to 95 MiB): raw body, `Content-Length` required; `sha256`, optional `sig`, `run`, `exec` as query parameters |
| `POST` | `/packages/:ns/:pkg/versions/:ver/uploads` | start a multipart upload `{ asset, size, sha256, sig?, run?, exec? }` → `{ uploadId, partSize, partCount }` |
| `PUT` | `/uploads/:uploadId/parts/:n` | upload one part: raw body, `Content-Length` required; idempotent per part number |
| `POST` | `/uploads/:uploadId/complete` | assemble, verify the whole-object digest, create the asset |
| `DELETE` | `/uploads/:uploadId` | abort |
| `POST` | `/packages/:ns/:pkg/versions/:ver/publish` | `{ channel }` — publish and move the pointer |
| `PUT` | `/packages/:ns/:pkg/channels/:channel` | `{ version }` — promote or roll a pointer back |
| `POST` | `/packages/:ns/:pkg/versions/:ver/yank` | hide from the manifest; refused while a channel points at it |
| `DELETE` | `/packages/:ns/:pkg/versions/:ver` | drafts only |

Read feed — lode-facing, mounted through the raw-app builder at a short stable prefix, anonymous for public packages:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/r/:ns/:pkg/manifest.json` | generated `lode/v1` manifest; asset `url`s are absolute, same host |
| `GET` | `/r/:ns/:pkg/:ver/:asset` | asset bytes streamed from the blob store |

- Private packages: `Authorization: Bearer pat_…` with a `read` grant on the package, checked in the handler (the raw API has no auth middleware). Responses are `private, no-store`.
- Public: manifest `ETag` + short `max-age`; assets `immutable`.
- The manifest lists published versions only, capped at the newest N per package plus every channel target, so it stays far below lode's 32 MiB limit.
- `/r/*` is added to `run_worker_first`; otherwise the asset pipeline answers with the SPA's `index.html` and a 200.

### Asset storage

A small `BlobStore` seam inside the module, independent of the `file` module:

```ts
interface BlobStore {
  put: (key: string, body: ReadableStream<Uint8Array>, opts: { size: number, sha256: string }) => Promise<void>;
  get: (key: string) => Promise<{ body: ReadableStream<Uint8Array>, size: number } | undefined>;
  delete: (key: string) => Promise<void>;
}
```

- **R2**: `bucket.put(key, body, { sha256 })` — R2 verifies the digest and rejects a mismatch, so the Worker never hashes or buffers. Separate bucket binding `PACKAGES`, registered in `workers/entry.ts` next to the existing R2 driver.
- **Local** (Bun dev and tests): stream to a temp file while hashing, compare, rename.
- **Multipart**, for anything above the single-request limit and up to 500 MiB: the store also exposes `createMultipart` / `putPart` / `completeMultipart` / `abortMultipart`, backed by R2's multipart API (local: part files concatenated on completion). The server fixes the part size (64 MiB), so every request stays under the Workers body cap on any plan. R2 checks parts individually, not the assembled object, so on completion the server streams the object back through a SHA-256 digest and compares it with the digest declared at start; a mismatch deletes the object and fails the upload. The asset row is created only after that check, so an unverified object is never served.
- Nothing is buffered: request bodies stream to R2 and downloads stream from it, on both paths.
- Key: `pkg/<package_id>/<version_id>/<asset_name>`. No content-addressed dedup — deletion stays a plain key delete.
- Limits: see *Quotas*. Expired multipart uploads are aborted by a sweep on the template's `scheduler` seam (the Durable Object alarm on Workers).

### Publisher workflow (v1)

Publishing is driven from CI with a token granted `write` on the package (or packages) that pipeline releases, stored as a pipeline secret. No new client binary: the repo ships `scripts/publish.sh` (create draft → upload each asset, switching to multipart above the single-request limit → publish to a channel) and a GitHub Actions example that calls it. Signing is a step the workflow runs only when a key is configured. The single-request upload at its core:

```bash
sig=$(lode-cli sign "$f" --version "$VER" --key-env LODE_SIGNING_KEY | awk '/^sig:/ {print $2}')
curl -fsS -X PUT -H "Authorization: Bearer $LODE_REGISTRY_TOKEN" --data-binary "@$f" \
  "$REGISTRY/api/registry/packages/$NS/$PKG/versions/$VER/assets/$(basename "$f")?sha256=$(sha256sum "$f" | cut -d' ' -f1)&sig=$sig"
```

Operator side, shown ready to copy on the package page:

```toml
[update]
manifest = "https://<host>/r/<ns>/<pkg>/manifest.json"
asset    = "<pkg>-linux-x64.tar.gz"
[trust]
require_signature = "enforce"
trusted_keys = ["<key_id>:<base64url-pubkey>"]
```

### Web UI

Package list and detail (versions, assets, channel pointers, the `lode.toml` snippet), signing keys page, package create and settings, the token page (per-package read / write / admin grants), quota usage. API tokens already have a UI. Admin area: all packages and namespaces with owner and usage, takedown actions, namespace suspension, per-user quota editing — next to the template's existing user administration. EN/ZH locale shards.

### Milestones

| # | Deliverable | Verify |
|---|---|---|
| M0 | Import bun-tpl with history (`template` remote), rebrand, drop `document` + `issue`, wrangler names + `PACKAGES` bucket + `/r/*`, PMA docs, private repo `dotns/lode-server` | `bun run check` and `bun run test:workers` green |
| M1 | Namespaces, signing keys, package CRUD, token grants, quotas, admin API: schema + migration, services, routes, token scopes, policy namespace, audit, backup contribution | unit tests incl. user A cannot touch user B's package, admin can, a token is refused on packages it has no grant for, a `read` grant cannot publish, a `write` grant cannot change settings or yank, an `admin` grant can, no token reaches session-only routes; OpenAPI and docs gates |
| M2 | Draft versions, streaming upload (single-request and multipart), `BlobStore` (local + R2), optional signature verification, publish / channels / yank, upload sweep | workerd spike first (streamed body into R2, digest of a 500 MiB object within limits); unit tests against vectors from the real `lode-cli sign`; tampered `sha256` / `sig` / `run` rejected; over-quota refused |
| M3 | Read feed: manifest generation, asset download, private access, suspended namespaces | e2e with the real `lode` binary: bootstrap and auto-update for a signed package under `enforce` and an unsigned one under `off`, rollback-pointer refusal, private package with `[http].headers` |
| M4 | Web UI, including the admin area | web unit tests, `check:i18n`, browser walkthrough as user and as admin |
| M5 | Cloudflare deployment: bucket, IdP settings, secrets, custom domain, CI workflow, `scripts/publish.sh` + Actions example, extended workers smoke (multipart upload → manifest → download), publisher and operator guides | smoke suite against a deployed preview version; one package published from a real CI run with a `write`-granted token |

Each milestone is its own task and commit series. M1–M3 are the usable core; M4 and M5 can proceed in parallel after M3.

### Deferred (not part of this approval)

- Assets above 500 MiB; presigned direct-to-R2 uploads.
- Edge cache for public manifests and assets in the stateless Worker, purged on publish.
- Organization namespaces and per-package maintainers.
- ECDSA P-256 / P-384 keys.
- `lode-cli publish` (a change in `dotns/lode`).
- Public unauthenticated package pages, download statistics.

## Risks

- **Single Durable Object on the download path.** Every manifest poll and asset download passes through one object. Acceptable for an initial deployment (lode polls every 300 s by default); the edge cache is the planned relief, and the `/r/*` URLs do not change when it lands.
- **Large assets through one Durable Object.** A 500 MiB download or completion-time digest occupies the object for the length of the transfer. I/O is asynchronous so other requests interleave, but the digest is CPU work: M2's spike measures it against the Workers CPU limit. Fallback if it does not fit: hash each part as it arrives and verify a server-computed digest list instead, or move digesting into the stateless Worker.
- **Streaming through the Durable Object into R2.** R2 needs a known length for a stream body. The plan relies on `Content-Length` being preserved across `stub.fetch`; the same spike confirms it before anything is built on it.
- **Unsigned packages.** With signing optional, an operator who installs an unsigned package trusts the server and the publisher's account completely. The package page says so and shows the `enforce` snippet only for signed packages.
- **Signature byte-compatibility.** A one-byte difference in the canonical message makes every signature fail. Mitigated by test vectors generated with the real `lode-cli` and by the M3 end-to-end run.
- **URL contract is permanent.** Operators embed the manifest URL in `lode.toml`. The `/r/:ns/:pkg/` shape and the immutable namespace slug must be settled before the first real publish.
- **Template drift.** Dropping `document` / `issue` and adding lines to aggregate files is the fork model's expected footprint. Editing shared infra would make upstream merges expensive; the registry stays inside its module, with `workers/entry.ts`, `wrangler.toml` and the `/r` mount as the only template-surface edits.
- **Hosting other people's binaries.** Open sign-up means abuse potential: quotas, rate limits and the admin takedown path (delete, yank, suspend namespace) are in v1.
- **Opaque namespace ids.** A random 8-character namespace says nothing about the publisher, so the package page and the admin area must show the owner next to it.

## Scope

- New: `apps/api/src/modules/registry/` (schema, services, routes, blob stores, backup contribution, tests), one migration, `apps/web` registry routes + nav + locale shards, `tests/e2e/modules/registry/`, `docs/modules/registry.md`, publisher / operator guides.
- Template-surface edits: `db/schema.ts`, `routes/protected.ts`, `routes/raw.ts` or `app.ts` (the `/r` mount), `workers/entry.ts`, `wrangler.toml`, `config/schema.ts` (new env vars), sidebar registry, `tests/e2e/run.ts`, `tests/workers/smoke.ts`.
- Removed: `document` and `issue` modules with their web routes and e2e.
- Out of scope: any change to `dotns/lode`; everything under *Deferred*.

## Alternatives

- **D1 + stateless Workers instead of the template's Durable Object.** Scales reads better, but bun-tpl rejected D1 for lack of interactive transactions and per-query round trips, and the account / policy stack depends on both. Rewriting that stack is far larger than this project. Rejected.
- **Reuse the `file` module for assets.** It buffers whole uploads and is shaped around attachments with reference counting. Extending it means editing shared template infra. Rejected in favour of a module-local `BlobStore`.
- **Server-side signing with managed keys.** Simpler for publishers, but the server becomes able to forge releases for every tenant — the opposite of lode's publisher-identity model. Rejected.
- **Presigned direct-to-R2 uploads** for large assets. Offloads the Worker, but needs R2 S3 credentials as secrets and still needs a post-upload verification step. Multipart through the Worker reaches 500 MiB with bindings only; presigning stays an option if sizes grow.
- **Proxy GitHub Releases instead of hosting bytes.** lode already supports `github = "owner/repo"` directly; a proxy adds nothing.
- **Read feed under `/api/raw/registry/…`.** Zero wrangler or mount changes, but a long, template-flavoured URL becomes the permanent operator contract. `/r/` recommended.

## Annotations

Decisions from the user, 2026-10-09:

1. **Asset size**: no practical limit short of 500 MiB; streaming or R2 multipart. → multipart is part of M2.
2. **Identity provider**: the user supplies the OIDC configuration. Needed before M5; local development uses the template's bundled dex.
3. **Publishing**: open to every signed-in user, bounded by quotas.
4. **Signatures**: not required. `require_signature` defaults to off per package.
5. **Repository**: `github.com/dotns/lode-server`, private.
6. **Roles**: a platform administrator manages other users and every package; each user manages their own packages and publishes from CI.
7. **Tokens**: reuse the personal API token; one token may cover several packages. A token page configures `read` / `write` / `admin` per package; `admin` allows management operations on that package, deletion excluded. CI publishes with such a token. (Replaces an earlier draft with a separate one-per-package CI token.)
8. **Naming** (2026-10-10): the namespace is system-assigned (8-character random id), not claimed. A package has a slug — lowercase letters, digits and `-`, unique within its namespace — and a separate free-text display name.
9. **Signing keys** (2026-10-10): keys belong to a package, not to a user, and are managed on the package page. A token with a `write` grant on the package may register one. A leaked token can then register a key of its own, but operators who pin `trusted_keys` under `enforce` do not install what it signs.

10. **Registry address** (2026-10-10): `lode.bk.io` is the production hostname. The console and its API are mounted under `/u` with the template's `BASE_PATH`, the public home page is at `/` (`HOME_PAGE=root`), and the read feed stays at `/r` on the origin root. The publishing tools default to `--registry https://lode.bk.io/u`.
11. **Repository move** (2026-10-10): the project lives at `github.com/bkhq/lode-server`, private, replacing `dotns/lode-server` (item 5). Its history starts from a single initial commit; lode itself is to move to `bkhq` later.

Still assumed: app slug `lode-server`, read prefix `/r/`.

## Results

Implemented 2026-10-09 – 2026-10-10 through a four-workstream campaign; every branch merged into `main`:

- M0 foundation — `ef59f08`
- M1–M3 registry backend — `a2cd909`. Verified with the real lode 0.3.3 binary: signed package under `enforce`, unsigned under `off`, rollback-pointer refusal, private package through `[http].headers`.
- M5 deployment and publisher tooling — `1e3f10f`. Everything except the deployment itself.
- M4 web UI — `c7d4fe8`. Walked through in a browser as user and as admin, EN and ZH.

Not done: the Cloudflare deployment and the checks that only a deployment can run (a 500 MiB upload under real limits, refused-upload behaviour on the edge). They are the owner steps in `docs/develop/deployment.md`.

Deviations, known limitations and deferred items are kept in `docs/modules/registry.md`; the dated history is in `docs/changelog.md`.
