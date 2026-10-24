# Architecture

> Examples assume `BASE_PATH=/app`. The app is mounted at root (`/`) by default; set `BASE_PATH` to serve under a URL prefix.

This is a Bun monorepo template that provides an OAuth-backed internal workspace: account management, Zanzibar-style policy tuples, documents, issues, settings, audit logs, optional DB-at-rest encryption, and JSON backup.

This document describes the implemented architecture in the current codebase. Planned integrations should live in separate roadmap or planning documents, not in current-state architecture docs.

In examples below, `${BASE_PATH}` is the configured URL prefix. Empty by default — leave the placeholder as `""` when reading the routes for a root-mounted deploy.

## Runtime Shape

```text
Browser
  |
  | ${BASE_PATH}/*
  v
App server
  |
  | ${BASE_PATH}/api/*
  v
Hono API
  |
  +-- public routes (always on: /health, /encryption/status)
  +-- setup routes (locked-only: /encryption/init, /unlock, /unlock-challenge)
  +-- protected routes guarded by requireUnlocked (unlocked-only business + admin)
  +-- SQLite via Drizzle ORM
```

The outer app serves:

| Mount | Purpose |
|---|---|
| `/` | HTML meta refresh to `${BASE_PATH}/` when `BASE_PATH` is set. Skipped when the app is root-mounted — the SPA already owns `/`. |
| `${BASE_PATH}/api` | Hono API. |
| `${BASE_PATH}/*` | Embedded SPA assets when production assets are present. |

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| API | Hono |
| Database | SQLite through Drizzle ORM |
| Web | React, Vite, TanStack Router, TanStack Query |
| Styling | Tailwind CSS |
| Build | `scripts/package.ts` lode release asset (bundled `index.js` + SPA + migrations) |
| Updates | [lode](https://github.com/bkhq/lode) supervisor — download, verify, run, auto-update, rollback |
| Authentication | External OAuth/OIDC provider with authorization code + PKCE |
| Authorization | Local Zanzibar-style relation tuples |

## Repository Layout

```text
apps/
  api/
    src/
      app.ts
      config.ts
      db/
      modules/
      routes/
      shared/
  web/
    src/
      app/
      shared/
packages/
  shared/      # ECIES utilities used by api and web
  tsconfig/    # shared tsconfig
scripts/
tests/
  e2e/         # live e2e harness (dex + API + every module)
docs/
```

## API Module Layout

```text
apps/api/src/modules/
  account/
    auth/
    users/
    groups/
  audit/
  backup/
  cron/
  document/        # sub-type of item
  encryption/
  file/            # blob storage; pluggable drivers + content dedupe
  issue/           # sub-type of item
  item/            # base for content sub-types
  policy/
  settings/
  system/
```

| Module | Responsibility | Details |
|---|---|---|
| `account` | OAuth login, sessions, current user, users, groups, TOTP. | [account.md](modules/account.md) |
| `audit` | Persisted audit events + retention sweep. | [audit.md](modules/audit.md) |
| `backup` | JSON backup export and import (admin + service-token surfaces). | [backup.md](modules/backup.md) |
| `cron` | In-process job scheduler: cron-driven actions with run history. | [cron.md](modules/cron.md) |
| `document` | Documents, attachments, comments, shares; sub-type of `item`. | [document.md](modules/document.md) |
| `encryption` | DB-at-rest encryption setup, unlock, metadata, key rotation. | [encryption.md](modules/encryption.md) |
| `file` | Content-addressable blob storage with pluggable drivers and ref counting. | [file.md](modules/file.md) |
| `issue` | Issues, attachments, comments; sub-type of `item`. | [issue.md](modules/issue.md) |
| `item` | Base primitive for content sub-types (common metadata + comments + permission edges). | [item.md](modules/item.md) |
| `policy` | Zanzibar-style relation tuples, check, expand, resource groups. | [policy.md](modules/policy.md) |
| `settings` | Runtime key/value settings store. | [settings.md](modules/settings.md) |
| `system` | Health probes, build version, Prometheus metrics, upload limits. | [system.md](modules/system.md) |

## Request Flow

```text
Request
  -> request ID (+ propagation for outbound calls)
  -> CORS
  -> app context injection (db, config, logger, encryption)
  -> request logging
  -> CSRF guard
  -> policy middleware (auto-gates routes declared via defineResource.routes)
  -> route group
  -> requireUnlocked for protected routes
  -> authRequired where the module requires a session
  -> adminRequired where the module requires admin privileges
  -> handler
  -> shared error handler
```

## Authentication Flow

```text
Unauthenticated user
  -> GET /app/api/account/auth/login
  -> OAuth authorization endpoint
  -> GET /app/api/account/auth/callback
  -> token exchange with PKCE verifier
  -> local user create/update
  -> session cookie
  -> redirect back to requested page
```

Sessions are stored in SQLite. The browser stores only the HTTP-only session cookie.

### Session lifetime

A session lasts `session.max_age` (Settings → Authentication, seeded from
`SESSION_MAX_AGE`, default one day) for every sign-in method. It is an idle
timeout: once half of it has passed, the next request extends the session and
rewrites the cookie for a full period, so a session is written at most twice
per period and ends only after `session.max_age` without use. Independently, no
session lives longer than 30 days from sign-in, so a change made at the identity
provider — a disabled account, new group memberships — reaches the app at
least that often.

The IdP's access token does not bound the session. It is used to read the
user's profile at sign-in and revoked, with the refresh token if one was
issued, at sign-out. An expired session is deleted and the user signs in
again; it is not renewed with a refresh-token grant.

### Session token storage

Each session row carries the upstream OAuth `access_token` and `refresh_token` as plain columns. Their protection at rest depends on `DB_ENCRYPTION`:

| `DB_ENCRYPTION` | At-rest protection for session tokens |
|---|---|
| `true` (recommended for production) | libsql encrypts the whole SQLite file with the DEK; rows are unreadable without the master key. |
| `false` (template default — dev convenience) | Tokens live as cleartext SQL strings in `app.db`. Anyone with read access to the file (filesystem, snapshot, leaked backup) gets the tokens. |

For deployments that disable encryption (e.g. local dev, or a single-tenant box where the file is already covered by full-disk encryption) this trade-off is acceptable. If sessions must be defensible even when an attacker can read `app.db`, run with `DB_ENCRYPTION=true` or wrap the columns at the application layer before persisting. Drizzle's `defaultFn` is a reasonable seam.

`DEFAULT_ADMIN` is the operator's declaration of who administers the deployment. A login matching it is granted admin on every login — including an account that already exists — whether or not other admins exist. It used to apply only while no admin existed, which let any other admin, such as a single-user account left from an earlier mode, silently cancel it. An entry containing `@` matches only a verified email; any other entry matches the username, so a self-chosen username spelled like the admin's address cannot claim it. The setting grants and never revokes: an admin promoted in the UI keeps the role, and a listed admin demoted in the UI is granted it again at their next login.

OAuth/OIDC provider configuration is read from environment variables at runtime. The admin settings UI does not own these values, which prevents a bad database setting from breaking login.

## Authorization Model

The policy module stores relation tuples in `relation_tuples` and exposes check and expand operations. Admin users bypass policy checks where the route explicitly uses `adminRequired`.

Tuple example:

```text
document:abc123#viewer@group:dev-team#member
group:dev-team#member@user:user123
```

## Rate Limiting

Two limiters, chosen by whether the window has to outlive the process.

**In-memory, IP-keyed** — `shared/middleware/rate-limit.ts`, backed by the
platform key/value seam. Free per request, so it suits short windows on
unauthenticated surfaces. `consumeRateLimit` is the single implementation of
the fixed-window counter: `rateLimit()` wraps it as middleware for TOTP
step-up, and the auth and encryption routes call it directly where they need
to gate part of a handler rather than the whole route. State is lost on
restart, which is acceptable for these windows because the control that
actually stops credential brute force is `auth_lockouts`, below.

**Durable, user-keyed** — `shared/middleware/creation-rate-limit.ts`,
backed by the `rate_limits` table. Creation is the surface where an
authenticated caller can grow the database without bound, and a counter that
dies with the process would let a caller pace requests around a restart — or,
on a runtime that evicts the app when idle, around the eviction.

The middleware is mounted once and finds the creating routes itself, rather
than being wired into each one. The rule is the REST invariant the whole
route table already follows: a collection answers `GET` with a list and
`POST` with a create, so a `POST` whose path also has a `GET` creates a
member of that collection, while an action posted at a member
(`/cron/jobs/:id/trigger`, `/policy/check`) has no matching `GET` and is left
alone. A new module is therefore throttled the moment it mounts, with
nothing to remember and no central list to maintain — and
`creation-rate-limit.test.ts` pins the discovered set, so a route entering or
leaving it has to be acknowledged.

Budgets are per resource, not global: `issue`, `document`, `comment`,
`attachment` and the rest each carry their own counter, so a burst of
comments does not spend the budget for opening issues and a runaway loop in
one module cannot lock a user out of the rest of the app. All three
attachment endpoints land on `attachment` because they create the same kind
of thing. `CREATE_RATE_LIMIT_EXEMPT` lists resources to leave alone.

Two windows apply together. `CREATE_RATE_LIMIT_PER_MINUTE` bounds a burst;
`CREATE_RATE_LIMIT_PER_HOUR` bounds the sustained rate that a burst limit
alone would still allow — at 60/minute, an unbounded hour is 3600 creates.
Rejected requests keep counting, so a caller hammering the minute limit
escalates into the hour window instead of settling into a comfortable rhythm
just under the burst cap. A 429 reports the longest tripped window in
`Retry-After`.

Counting happens in memory; the row is a checkpoint, not a ledger. Writing
on every request would put SQLite on a path that is otherwise free and —
worse — would write on *rejected* requests too, turning the limiter into a
write amplifier under exactly the flood it exists to stop. So a row is
written only when its value would change a decision: at most once per eight
increments while under the cap, once on the request that crosses it, and
never again for that window, because a stored count already past the cap
refuses on its own after a restart. A flood therefore costs a handful of
writes rather than two per request.

The cost is bounded and deliberate: a restart, or an eviction on Cloudflare
Workers, forgets up to eight increments for the keys in flight. Recovering
those by engineering an eviction means going idle long enough to be evicted,
which is a worse deal than waiting out the one-minute window and getting the
whole budget back. Memory being authoritative assumes a single writer, which
holds everywhere this app runs — one Bun process, or one Durable Object —
and is the same assumption behind the in-memory limiter, the per-process
PKCE key and the request-scoped policy cache.

Keying on the user id bounds the table to users × resources × windows, one
row each, overwritten in place, so no sweep is needed.

Login has a third control that is neither: `auth_lockouts` records failures
per username in the database, which is what actually stops credential
stuffing from a rotating set of addresses. The same table backs the TOTP
verification lockout.

The two long windows — `/encryption/unlock` at 10 per 15 minutes and
`/encryption/init` at 5 per 15 minutes — are the only ones where losing
in-memory state would matter, and they are reachable only on an encrypted
deployment, which needs the `encryptionAtRest` capability and therefore a
long-lived process. Every window reachable on a runtime that evicts the app
when idle is either a minute long or has a database-backed control beneath
it.

## Raw API

`${BASE_PATH}/api/raw/*` is the bare surface for other services to integrate
with. It shares the `/api` prefix but not the `/api` sub-app, and deliberately
carries none of what that sub-app applies for the SPA:

| Applied on the rest of `/api` | On `/api/raw` |
| --- | --- |
| Security headers (CSP, HSTS, frame, `same-origin` resource and opener policy) | No |
| CSRF guard (Origin plus `X-Requested-With`) | No |
| CORS policy | No |
| Session and policy middleware | No |
| Per-user creation quota | No |
| Per-client rate limit | Yes — `RAW_API_RATE_LIMIT_PER_MINUTE`, per IP |

Each of those exists for a browser session and gets in the way of a service
calling from outside: a `same-origin` resource policy stops cross-origin
readers outright, and the CSRF guard demands headers a server-to-server client
never sends. What remains is plumbing — a request id, the request context,
request logging, the JSON error shape — and the rate limit, which counts
unknown paths too, so probing for routes spends the same budget as calling
them.

Two mechanisms keep it bare. The security-header exemption is decided by
path, and applies only while the raw API is mounted: a locked deployment has
none, and the prefix then keeps the normal headers instead of becoming an
unprotected hole. The `/api` sub-app's middleware is kept out by mount order:
the raw API is mounted first and always responds — including a JSON 404 for
an unknown path — and Hono runs matching handlers in registration order, so
nothing the `/api` sub-app registered is reached. `raw-api.test.ts` pins that
order; swapping it fails the suite.

Routes live in `apps/api/src/routes/raw.ts`. Nothing there is authenticated
by the framework, so a route that needs it checks it itself, usually with a
service token in a header. Routes described with `describeRoute` appear in the
OpenAPI spec at `/api/openapi.json` under `/raw/...`, tagged `Raw`, and in
`docs/reference/api-routes.md`.

## Home Page

`HOME_PAGE` decides whether the SPA has a home page at `/` and where:

| Value | Home page | `/` and `${BASE_PATH}/` |
|---|---|---|
| `off` (default) | none | `${BASE_PATH}/` goes to `/overview`; the origin's `/` redirects there |
| `base` | at `${BASE_PATH}/` | the origin's `/` redirects to it |
| `root` | at the origin's `/`, outside `BASE_PATH` | `${BASE_PATH}/` goes to `/overview` |

Without a `BASE_PATH`, `base` and `root` are the same. The page is public and
makes no authenticated call; its content is
`apps/web/src/app/routes/-home.tsx`, and its "Enter" link goes to
`${BASE_PATH}/overview`.

The SPA learns the mode from `homePage` in the anonymous `/encryption/status`
response, which the root layout fetches before rendering anything, so it needs
no rebuild and works wherever the SPA is served (the Worker's asset pipeline
included). For `root` the API serves the SPA shell at `/` (the base-path
wildcard does not reach it), `main.tsx` builds the router without the prefix
on that page, and `__root.tsx` skips the setup and unlock redirects there.
Only the home page is outside the prefix, so its links into the app must carry
`BASE_PATH`.

## Encryption Lifecycle

The app can start in a locked mode. Setup and unlock routes are available before the full protected app is mounted. After unlock, protected routes are mounted and guarded by `requireUnlocked`.

## Data Storage

Runtime data is stored below `ROOT_DIR`:

| Path | Purpose |
|---|---|
| `data/db/app.db` | SQLite database. |
| `data/db/app.pid` | PID lock file. |
| `data/logs/app.log` | Structured JSON logs. |

