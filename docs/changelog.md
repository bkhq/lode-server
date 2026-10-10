# Changelog

Track changes your fork makes on top of this template. Format adapted from
[Keep a Changelog](https://keepachangelog.com/) — group entries under
**Added / Changed / Removed / Fixed / Security**. The `Unreleased` block
holds work since your last tag.

Upstream cuts versioned tags so forks can anchor diffs against a known
template version. The boundary entries below summarise what shipped in
each upstream tag; your fork's `Unreleased` block sits at the top.

## Unreleased

### Added

- `HOME_PAGE` (`off` | `base` | `root`, default `off`) gives the SPA a home
  page at `/`. `base` puts it at `${BASE_PATH}/`, following the base path;
  `root` puts it at the origin's `/`, outside `BASE_PATH`, so a landing page
  can stand in front of an app mounted under a prefix. The content is
  `apps/web/src/app/routes/-home.tsx`. The SPA reads the mode from the
  anonymous `/encryption/status` response, so it needs no rebuild.

- Personal API tokens. Users create them under Settings → API tokens or at
  `/api/account/me/tokens`; the secret is shown once and only its SHA-256 is
  stored. A token (`Authorization: Bearer pat_…`) acts as its user but only
  on routes its scopes list — modules register scopes with
  `registerTokenScope`, and every other route, token management included,
  answers 403. It is authenticated by a provider added to the auth chain
  after the session provider. **Schema:** new `api_tokens` table in the
  regenerated `0000_init` migration; a deployed database needs it created by
  hand.

- Group memberships from the identity provider. With `OAUTH_GROUPS_CLAIM`
  set, each OIDC login makes the user's memberships in IdP-managed groups
  match the claim, creating missing groups as `source: "idp"`. Local groups
  are never touched, IdP groups refuse manual member edits and renames
  (`409 GROUP_MANAGED_BY_IDP`), and a login without the claim changes
  nothing. `OAUTH_SCOPES` sets the scopes requested at login (default
  `openid profile email`) for IdPs that send the claim only on request.
  **Schema:** `groups.source` was added to the regenerated `0000_init`
  migration; a deployed database needs the column added by hand
  (`ALTER TABLE groups ADD source text DEFAULT 'local' NOT NULL`).

- A raw API at `${BASE_PATH}/api/raw/*` for other services to integrate with.
  It shares the `/api` prefix but none of the browser-facing layers the `/api`
  sub-app applies for the SPA — no security headers, CSRF guard, CORS policy,
  session or policy middleware, or creation quota — only a per-client rate
  limit, `RAW_API_RATE_LIMIT_PER_MINUTE` (default 120, 0 disables). The header
  exemption is decided by path and applies only while the raw API is mounted;
  the `/api` sub-app's middleware is kept out by mounting the raw API first,
  and unknown raw paths answer a JSON 404. Routes go in
  `apps/api/src/routes/raw.ts` and authenticate their callers themselves.
- Runtime seam under `apps/api/src/platform/` (`getPlatform()`): `env`,
  a TTL key/value store (`kv.namespace(...)`), a background `scheduler`,
  an `openDatabase` override, and a `capabilities` flag set. The rate
  limiter, TOTP step-up tokens, the file GC and audit retention sweeps, and
  config env reads go through the seam instead of touching `Bun.env` /
  `setInterval` / module-level maps directly. No behaviour change on Bun.
- Cloudflare Workers as a second runtime target, selectable without forking
  the app. The whole API runs inside one Durable Object that owns its SQLite
  database (not D1: D1 is auto-commit only and cannot express this app's
  interactive read-then-write transactions); blobs go to R2 through a new
  storage driver; background sweeps run off a Durable Object alarm; the SPA
  is served by the asset pipeline. Configuration is `apps/api/wrangler.toml`,
  entry point `apps/api/src/workers/`, and migrations are bundled into
  `src/db/migrations.generated.ts` by `bun run db:generate`. See
  `docs/develop/runtime.md`.
- `bun run test:workers` — a smoke suite that boots the app in workerd and
  covers boot, login, transaction commit, transaction rollback and an R2
  round trip. Runs in the new `workers` CI workflow, which also smoke-tests a
  preview deployment when Cloudflare credentials are configured.
- Per-user rate limits on creating content, held in a new `rate_limits`
  table. The middleware is mounted once and discovers the creating routes
  from the router table — a `POST` whose path also answers `GET` creates a
  member of that collection — so a new module is covered as soon as it
  mounts and an action route like `POST /cron/jobs/:id/trigger` is left
  alone. `CREATE_RATE_LIMIT_EXEMPT` opts a resource out. Budgets are per
  resource — `issue`, `document`, `comment`, `attachment`, ... — so a burst
  of one does not spend the budget for another,
  and two windows apply together: `CREATE_RATE_LIMIT_PER_MINUTE` (default
  60) bounds a burst and `CREATE_RATE_LIMIT_PER_HOUR` (default 600) bounds
  the sustained rate; either at 0 disables that window. Rejected requests
  keep counting, so sustained abuse escalates from the minute window into
  the hour one. The counters are stored rather than in-memory because
  creation is where an authenticated caller can grow the database without
  bound, and a counter that dies with the process can be defeated by pacing
  requests around a restart or, on Cloudflare Workers, around an eviction.
  Counting happens in memory and reaches the row only when the stored value
  would change a decision — at most once per eight increments under the cap,
  once when crossing it, and never again for that window. That keeps SQLite
  off a path that is otherwise free, and stops the limiter from amplifying
  writes under the flood it exists to stop: refusals cost nothing. A restart
  or a Workers eviction forgets at most eight increments per key in flight,
  which is a worse deal for an attacker than waiting out the window. Like
  `auth_lockouts`, the table is deliberately excluded from backups.
- `pbkdf2MaxIterations` capability. Cloudflare refuses PBKDF2 above 100,000
  iterations, so a hash minted at the OWASP baseline of 600,000 cannot be
  verified there at all — it throws rather than verifying slowly, and
  `wrangler dev` computes any count, so the failure appears only in
  production. `hashPassword` now clamps to the running platform's ceiling and
  accepts an explicit count for minting a hash aimed at another runtime, and
  a configured hash above the ceiling is refused at boot.
- Runtime capability gates: `DB_ENCRYPTION=true`, `CRON_ENABLED=true`,
  argon2/bcrypt password hashes and the cron `shell` action are refused on a
  runtime that cannot support them, at boot rather than at request time. The
  cron gate exists because the scheduler holds its own per-job timers and a
  host that evicts the app when idle would drop jobs silently; such
  deployments drive jobs through `POST /api/cron/jobs/:id/trigger` instead.

### Changed

- On Cloudflare Workers, a configuration change now resets the Durable
  Object. It keeps the `env` it was constructed with while resident, and the
  app's alarms keep it resident, so `wrangler secret put` otherwise appeared
  to do nothing — the object kept serving with the values it booted with.
  The stateless Worker sends a digest of its bindings and the object resets
  when the digest stops matching.

- The auth and encryption routes no longer carry their own fixed-window
  counters. All in-memory rate limiting now goes through one implementation,
  `consumeRateLimit` in `shared/middleware/rate-limit.ts`, so there is a
  single eviction policy (evict the entry closest to expiry, keeping an
  address under active abuse) and one behaviour on every runtime. The
  thresholds, bucket sharing and 429 shapes are unchanged.

- Replaced the single-binary build (`scripts/compile.ts`) with a
  [lode](https://github.com/dotns/lode)-compatible release asset
  (`scripts/package.ts`): a tarball of the bundled `index.js`, SPA `dist/`,
  Drizzle `drizzle/`, and the libsql native binding, plus `manifest.json`
  (schema `lode/v1`) and `checksums.txt`. The app serves the SPA and runs
  migrations from the filesystem (no embedded asset map), detects the packaged
  layout via `ROOT_DIR`, and implements the lode `state.json` readiness/prepare
  handshake; `/api/system/version` now reports a lode upgrade summary.
- `Dockerfile` / `docker-compose.yml` now run the lode supervisor (it downloads,
  verifies, runs, and auto-updates the release asset) instead of baking the app
  into the image. `deploy/lode.toml` is the operator config template.
- `release.yml` builds and uploads the lode asset to a published GitHub Release
  instead of pushing a container image.
- Group membership lives in a dedicated `group_members` table owned by the
  account module instead of `relation_tuples`. The Zanzibar engine reads
  `group:*#member` through `group-members.service` so a deployment can drop
  the policy module while keeping user-group features.
- `POST /api/policy/tuples` (and the batch endpoint) now refuse
  `group:*#member` writes; callers must use
  `POST /api/account/groups/:id/members`.
- Refreshed the dependency baseline. Majors: `vitest` / `@vitest/coverage-v8`
  4 → 5, `nanoid` 5 → 6, `@hono/standard-validator` 0.2 → 0.4,
  `@libsql/client` 0.17 → 0.18, `@scalar/hono-api-reference` 0.11 → 0.12.
  Everything else moves to the latest minor/patch (hono, hono-openapi, zod,
  oauth4webapi, react 19.3, vite 8.3, tailwind 4.3.3, eslint 10.10, the
  TanStack and Milkdown packages, …). `routeTree.gen.ts` is regenerated by the
  newer `@tanstack/router-plugin`. TypeScript stays on 6.0.3: `typescript-eslint`
  8.x still caps its peer range at `<6.1.0`, so TypeScript 7 would break linting.
- The app sidebar now starts expanded when the visitor has no stored
  `sidebar_state` preference (it used to start collapsed).
- Bun 1.3.14 → 1.4.2 and Node 22.13.0 → 24.21.0 across every pin: CI and
  release workflows, the runtime image base (`oven/bun:1.4.2-debian`) and
  `deploy/lode.toml`'s runtime download. `@types/bun` already tracks 1.4.2, so
  the type surface and the runtime now match again. Bun 1.4.2 still does not
  fail a run on bunfig `coverageThreshold` (verified), so the CI coverage gate
  stays; the api coverage baseline it documents moves to lines 85.93% /
  functions 78.79% under the new runtime.
- `PolicyContext` carries a request-scoped `PermissionCache`: repeated
  checks of the same `(object, relation, actor)` within one request —
  middleware gate + handler `assert`, per-field `filterWritable` /
  `projectFields`, editor-then-viewer probes — resolve once. The actor's
  group closure is computed once per request and passed to the engine
  (`CheckOptions.groupClosure`), turning group usersets into set lookups.
  `grant` / `revoke` clear it; hooks still fire per call.
- `check()` fetches all tuples on a `(namespace, objectId)` once per
  resolution and answers every rung of the `computed_userset` ladder from
  memory, instead of two to four queries per rung on the same object.
- `relation_tuples.subject_relation` is `NOT NULL DEFAULT ''`: a direct
  subject is stored as the empty string so `idx_tuples_unique` enforces
  uniqueness for direct grants (SQLite treats NULLs as distinct). The API
  still reads and writes `null`. The application-level duplicate pre-check
  and its `BEGIN IMMEDIATE` transaction are gone; a collision surfaces as
  the same 422.
- Resource groups have their own `resource_groups` table (`id`, `name`,
  `description`, unique name). The `__meta__` tuple that smuggled the
  description into `subject_relation` is gone, along with the name-clash
  pre-checks it needed.
- `group_members.subject_relation` gets the same treatment as
  `relation_tuples`: `NOT NULL DEFAULT ''`, so `idx_group_members_unique`
  enforces direct-membership uniqueness and `addUserMember`'s pre-check is
  gone. Callers still pass `null` for "direct member"; storage holds the
  sentinel.
- Backup format is v3. Older dumps migrate forward on import: v1 → v2
  (tuple null → sentinel, `__meta__` → `resource_groups`), v2 → v3
  (group-member null → sentinel).
- `find-unused-i18n` / `clean-unused-i18n` are wired as `bun run i18n:unused`
  / `bun run i18n:clean`; the README listed them as scripts but nothing did.
- `bun run clean:all` now removes `data/db` (the local database with its
  WAL/SHM, pid file and encryption `meta.db`) — the README already said it
  did. Needed whenever the squashed `0000_init` migration is regenerated,
  since a dev DB from the old schema cannot be migrated forward.
- `initFileModule` warns once at boot when `FILE_PRESIGN_ENABLED` (default
  `true`) is set on a storage driver that cannot presign — the bundled
  `local` driver — instead of silently streaming every download through
  the API.
- `docker-compose.yml` drops all capabilities and sets
  `no-new-privileges` on the app service (the image already runs as the
  unprivileged `bun` user).
- The release workflow signs the lode asset (`scripts/ci/sign-release.sh`,
  `<asset>.sig` sidecar) whenever the `LODE_SIGNING_KEY` secret is set and
  uploads the signature alongside; `deploy/lode.toml` and the deployment
  guide explain that `require_signature = "auto"` installs UNVERIFIED until
  a `trusted_keys` entry is configured.
- **Migration note for forks with a deployed database:** per template
  convention the single squashed `0000_init` migration was regenerated in
  place rather than appended to. A database already at `0000_init` will
  not pick up the `subject_relation` constraint or the `resource_groups`
  table automatically; apply the two changes by hand (or export a backup,
  recreate, and import — the importer migrates the dump).

### Fixed

- Adding a module meant editing lists that nothing flagged when forgotten. The
  sidebar registry now collects every `-*.nav.ts` under `app/routes` by glob,
  and its test compares against the files rather than a key list; the e2e
  runner runs every `tests/e2e/modules/*` folder instead of a hand-kept
  `MODULE_DIRS`; the docs test derives the expected security schemes from the
  `SECURITY` presets and checks every documented route's requirement is
  defined. The creation-quota resource list in its test stays pinned on
  purpose, so a change to what is throttled is a visible diff.

- `docs/reference/env-reference.md` listed only the config schema, so a
  variable read directly from the environment — `ROOT_DIR`, `LODE_DIR`, or one
  a module reads through `getPlatform().env` — went undocumented and unchecked.
  `gen-env-docs` now scans `apps/api/src` for env reads outside the schema,
  fails `check` when one is missing from `.env.example`, and lists them in a
  separate table.

- On Bun, a raw `db.get(sql\`...\`)` that matched no row threw `Failed query`
  instead of returning `undefined`. drizzle's libsql driver maps the first row
  with `Object.keys` without checking there is one; the builder `.get()` and
  the Durable Object driver already returned `undefined`. The libsql prepared
  query now returns `undefined` for an empty raw result, inside transactions
  too, so code behaves the same on both runtimes.

- A module could not add a policy namespace without editing
  `namespace-config.ts`, and `loadNamespaces()` — which tests call to reset —
  cleared the registry back to the shipped list. `registerNamespace` (exported
  from `@/modules/policy`) adds one from the module's `index.ts`; the reset
  keeps it, and a different config under a taken name throws at boot.
  `loadNamespaces(configs)` still replaces the registry wholesale for tests.

- A second auth provider replaced the first. `registerAuthProvider` kept a
  single slot, so a module adding token authentication switched session
  login off. Providers now form a chain, asked in registration order, where
  the first to return a user wins and one that throws fails the request.
  Registering the same function twice is a no-op, and registration returns a
  function that removes the provider.

- The OpenAPI spec and `docs/reference/api-routes.md` left out the raw API.
  The spec walked only the `/api` sub-app; `mountDocs` now also takes the raw
  routes and documents them under `/raw`, tagged `Raw`. The route reference
  mounted a hand-kept module list; it now mounts the same route composition
  the app serves, so a new module is listed without editing the script.

- `bun run lint`, and so `bun run check`, passed or failed depending on the
  runtime ESLint happened to run on. perfectionist takes its list of built-in
  modules from `node:module` in the running runtime, and `bun:test` is on
  Bun's list but not Node's, so the same import was a built-in under Bun and
  an external package under Node and the two demanded opposite orders. CI
  lints under Node and stayed green; running under Bun reported 43 errors.
  `sort-imports` now sets `environment: "bun"`, which makes `bun:*` a built-in
  in both, and the lint passes under either. `tests/` is now linted too — it
  was outside the glob and did not meet the rules — with the two executable
  entry points given the same top-level-await exemption antfu gives
  `scripts/`.

- A module's `router.use("*", authRequired)` guarded every router mounted after
  it, not only its own routes: Hono merges a sub-router's `use("*")` into the
  parent. A public route could only live in `public.ts`, ahead of all modules,
  and the backup sidecar's `POST /backup/export-via-token` — authenticated by a
  service token, not a session — answered 401 to a valid token, because the
  session guards of the modules mounted before backup reached it. Each module
  now scopes its guard to its own path prefixes, and a composition test mounts
  a public route after all protected modules and fails if any guard reaches
  it.

- On Bun, two writes that happened to overlap failed with `SQLITE_BUSY`. libsql
  keeps a connection pool, and a transaction holds one connection — and
  SQLite's write lock — across every `await` in its body, so a write from
  another request landed on a second connection and met that lock. The
  `PRAGMA busy_timeout` meant to absorb it only ever reached the one
  connection that ran it. A busy timeout would not have fixed it anyway:
  libsql executes synchronously, so waiting inside SQLite blocks the event
  loop the open transaction needs in order to commit, and the server freezes
  until the write fails regardless. Writes in the process are now serialized
  before they reach SQLite — a transaction holds an async lock for its whole
  life, a write outside one takes it for its single statement, reads skip
  it — and a write waiting past 15 seconds answers `503 DB_BUSY`. A write that
  escapes a transaction through the outer handle, which could never succeed,
  now fails at once with an explanation. The busy timeout is passed to the
  client so every pooled connection gets it, for other processes writing the
  same file.
- An `AppError` thrown beneath a query reached the client as a 500. drizzle
  wraps whatever a driver throws in `DrizzleQueryError`; the error handler now
  finds an `AppError` on the cause chain, as the constraint-violation check
  already did.

- On Cloudflare Workers, editing a document, deleting an item, and the audit
  retention sweep all failed. drizzle's Durable Object driver returns nothing
  from `run()`, where libsql returns a result carrying `rowsAffected`, and the
  app reads that field to detect version conflicts, skip no-op deletes and
  count retention batches — so each read threw on `undefined`. The Workers
  adapter now wraps `run()` to return the libsql shape, reading `changes()`
  straight after the statement, which is exact on a single-threaded Durable
  Object. The smoke suite covered creates but never edits or deletes, which is
  how this shipped; it now covers both.

- `DEFAULT_ADMIN` could be silently cancelled. It applied only while no admin
  existed at all, so any other admin — a single-user account left from an
  earlier mode, for instance — meant the configured admin logged in as an
  ordinary user, and nothing would ever promote them afterwards. A matching
  login is now an admin on every login, whether or not other admins exist,
  including an account that already exists. The setting grants and never
  revokes. Matching is also tightened: an entry containing `@` matches only a
  verified email, never a username, so a self-chosen username spelled like
  the admin's address can no longer claim the role.

- Every OpenID Connect login in production failed with a 500 at the
  callback. The OAuth state cookie is named `__Secure-oauth_state` in
  production, and it was cleared without `secure` — which Hono refuses for a
  `__Secure-` cookie, even for the expiring cookie a deletion writes — so the
  callback threw before exchanging the code. Development uses the plain
  cookie name, which is why neither local runs nor the e2e suite ever hit
  it. The deletion also hardcoded `Path=/`, so under a non-empty `BASE_PATH`
  the state cookie was never cleared. Both attributes now mirror how the
  cookie is set.

- `PATCH /api/policy/tuples/:id` deleted the old tuple before validating the
  new relation, so a rejected relation (typo, or one that collided with an
  existing row) answered 422 and silently revoked the permission. The rewrite
  now validates first and runs delete + insert in one transaction
  (`updateTupleRelation`). The route also goes through the same
  `group:*#member` guard as `POST` and the batch endpoint.
- `POST /api/policy/tuples/batch` accepted the same tuple twice in one payload
  and inserted both — the duplicate check only looked at rows already in the
  table, and `idx_tuples_unique` cannot catch it when `subjectRelation` is
  NULL. Intra-batch duplicates are now a 422 before anything is written.
- `policyMiddleware` let the handler run when a route binding pointed at a
  resource with no registered definition. It now fails closed with a 500 —
  that state is a wiring bug, not a reason to skip the permission check.
- `expand()` had only the depth cap; `check()` / `listUserResources()` also
  carried the shared node budget. It now threads the same budget through
  every recursive branch, so a wide nested-userset graph is cut off instead
  of walked in full.
- `registerRouteBinding()` accepted a second binding on the same
  `(method, path)`, which would gate the route twice with whichever action
  each declared. It now throws at registration.
- `listUserResources()` hard-coded its `tuple_to_userset` branch to
  `resource_group`, so for the shipped `item` namespace (`parent_item`
  edges with `item` subjects) "which objects can I see" silently dropped
  every inherited grant; only documents got subtree visibility, via a
  module-side recursive CTE. The branch is now the true reverse of
  `check()`: config-driven, self-referential rules walk to a fixpoint under
  the node budget, cross-namespace rules recurse. The document CTE is gone.
- The issue module answered "may I?" from two different authorities: its
  own routes and comments checked the `items` columns (`admin || creator ||
  assignee`), while the generic `/files/*` download path and comment
  attachments asked the policy engine — so the same attachment could be 200
  on one URL and 403 on the other, and an engine-granted `viewer` was
  refused by `GET /issues/:id` while `/permissions` said yes. Issues are now
  a `defineResource` on the `item` namespace (`issue:read` / `download` →
  viewer, `issue:update` → editor, `issue:transition` (status-only) →
  assignee, `issue:delete` → owner, `issue:manage_attachments` → assignee),
  and `assignee` now implies `viewer` in the namespace so the handler keeps
  read access everywhere. Every issue path resolves through the engine.
- The cron `http-request` action followed redirects, so a public URL
  answering `302` to a private address slipped past the DNS-pinned SSRF
  guard. Redirects are now reported, never followed, and the response body
  is read to a 64 KiB cap instead of being buffered in full.
- `errorHandler` never mapped SQLite constraint errors to 409: drizzle wraps
  the driver error, so the code/message it checked lived on `.cause`. The
  check now walks the cause chain (`isConstraintViolation`).
- `listReferencesByOwner` ordered by `created_at` then the random reference
  id, so two attachments written in the same millisecond came back in
  arbitrary order (a long-standing flaky test). Ties now break by insertion
  order (`rowid`).
- **Encrypted databases could become "database disk image is malformed".**
  `createDb` set `PRAGMA mmap_size = 256 MiB` unconditionally; libsql's
  page-level encryption and memory-mapped I/O do not mix, and under an
  ordinary write sequence (reproduced end-to-end by the new `/api/files`
  e2e, deterministic per sequence) a fresh-page append left the encrypted
  file unreadable — surfacing as 500s mid-run or a failed unlock after
  restart. Encrypted databases are no longer memory-mapped; plaintext keeps
  the mapping. A test pins the pragma per mode.
- The generic `/api/files/*` download path was admin-only in the shipped
  app: `cronRoutes()` registered `router.use("*", adminRequired)`, and Hono
  merges a sub-router's `use("*")` into the parent where it applies to
  every router mounted afterwards — `fileRoutes()` is mounted last. Cron's
  guard is now scoped to `/cron/*`; a composition test over
  `protectedRoutes()` pins that a non-admin reaches later routers.
- `stopFileGcSweep()` only cancelled timers; a sweep already running kept
  writing while shutdown closed the database under it. It now waits for the
  in-flight sweep, and a tick that fires while one is running is skipped.

### Removed

- Orphaned code with no importers: `shared/lib/api-response.ts` and
  `shared/lib/pagination.ts` (a response-envelope layer superseded by the
  `openapi.ts` helpers), `shared/middleware/totp.ts` (a `requireTotp`
  middleware never adopted — both TOTP routes check the step-up header
  inline), and the web `editor/toc.tsx` component.

### Security

- Dependency scan (osv-scanner) was failing on 17 advisories in 7 packages.
  Raised `wrangler` to 4.149.0 (brings `miniflare` with `undici` 7.29.1 and
  `sharp` 0.35.5), `shadcn` to 4.21.4, and the `dompurify` override to
  ^3.4.16 — the only one of these that ships in the SPA bundle — and added
  `source-map-js` and `@modelcontextprotocol/sdk` overrides for fixed
  releases. `shadcn` is a CLI and a CSS import used at build time, so it moved
  from `dependencies` to `devDependencies`. Two advisories with no usable fix
  (`braces`, no fixed release; `katex` 0.16, pinned by the eslint markdown
  plugin) are accepted in `osv-scanner.toml` with a reason and a review date.

- Transitive dependencies re-resolved within their existing ranges to clear
  30 OSV advisories (19 High) across 14 packages flagged by the CI
  `osv-scanner` step — among them `brace-expansion`, `browserslist`,
  `fast-uri`, `js-yaml`, `nanoid` (transitive 3.x/5.x), `postcss`, `qs`,
  `dompurify`, `ip-address`, `body-parser`. Lockfile only; no direct
  dependency ranges changed.

## v0.1.0 — 2026-05-14

First tagged template release. Subsequent forks should anchor their
`develop/forking.md` Part 2 (Tracking upstream) workflow against
`v0.1.0` or later.

### Added

- Bun monorepo skeleton (`apps/api`, `apps/web`, `packages/shared`,
  `packages/tsconfig`).
- Hono API with per-request DI (config / db / encryption / logger
  threaded through `c.var`).
- React 19 + TanStack Router web app with EN/ZH i18n and file-based
  routes.
- Shipped modules: `account/auth` (OAuth + TOTP), `account/users`,
  `policy` (Zanzibar tuples), `item` (base) + `file` / `document` /
  `issue` (sub-types), `cron`, `backup`, `audit`, `encryption`,
  `settings`, `system`.
- ECIES at-rest encryption with bootstrap-token, master-password
  derived keypair, and admin DEK challenge-response.
- Live e2e harness (dex + API + every module).
- Single-binary build via `scripts/compile.ts`.
- `scripts/rebrand.ts` rewrites manifests + `.env` defaults for forks.
- Doc-drift safeguards: `check:i18n` / `check:env-docs` /
  `check:api-docs`.
- `.github/workflows/ci.yml` + `release.yml`.

### Security

- Sentinel guards refuse production boot with example
  `OAUTH_CLIENT_SECRET=app-secret`, `OAUTH_CLIENT_ID=app`,
  `DEFAULT_ADMIN=admin@example.com`.
- `SERVICE_TOKEN` split into `SERVICE_TOKEN_METRICS` /
  `SERVICE_TOKEN_BACKUP` (independently rotatable).
- CSRF middleware (XHR header + Origin/Referer match), `__Secure-`-
  prefixed session cookies, PKCE + state binding for OAuth.

### Known issues

Tracked separately (lockout persistence, cookie scope vs `BASE_PATH`,
DNS-rebinding guard on the `http-request` cron action, …).
