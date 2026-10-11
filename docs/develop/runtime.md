# Runtimes

The app runs on **Bun** by default and on **Cloudflare Workers** as a
selectable second target. Both run the same modules, routes, schema and
tests. Nothing in a module knows which host it is on.

## The seam

`apps/api/src/platform/` defines the narrow contract the app needs from its
host. Module code reaches it through `getPlatform()` and never touches
`Bun.*`, `node:fs`, `setInterval` or a database driver directly.

| Seam | Bun | Cloudflare Workers |
| --- | --- | --- |
| `env` | `Bun.env` | Worker bindings (`vars` + secrets) |
| `kv` | in-process `Map` per namespace, TTL swept by one `unref()`'d timer | same, inside the Durable Object |
| `scheduler` | `setTimeout` + `setInterval`, non-overlapping | Durable Object alarm, multiplexed onto one slot |
| `openDatabase` | libsql file (`db/bun.ts`) | Durable Object SQLite (`workers/db.ts`) |
| `capabilities` | everything | see the table below |

The adapter is installed once at startup: `src/index.ts` on Bun,
`src/workers/entry.ts` on Workers. Tests can install a fake with
`setPlatform()`.

## Capabilities

A runtime declares what it can do; the app refuses configuration it cannot
honour rather than failing later at request time.

| Capability | Bun | Workers | Enforced at |
| --- | --- | --- | --- |
| `encryptionAtRest` | yes | no | boot — `DB_ENCRYPTION=true` is rejected |
| `argon2` | yes | no | boot — use a `pbkdf2-sha256` hash |
| `pbkdf2MaxIterations` | unbounded | 100,000 | boot — a hash above the ceiling is refused |
| `subprocess` | yes | no | the cron `shell` action throws |
| `filesystem` | yes | no | static assets, file logs and the OIDC discovery cache fall back |
| `residentTimers` | yes | no | boot — `CRON_ENABLED=true` is rejected |

Workers-specific consequences:

- **Database encryption** is the host's job. Durable Object storage is
  encrypted by Cloudflare; libsql's page-level encryption has no counterpart
  and the `meta.db` / DEK rotation machinery is Bun-only.
- **Passwords** must be `pbkdf2-sha256`, generated with at most 100,000
  iterations. `Bun.password`'s argon2 and bcrypt verification has no WebCrypto
  equivalent, and Cloudflare refuses PBKDF2 above that ceiling — a hash minted
  at the OWASP baseline of 600,000 throws rather than verifying slowly. Note
  that `wrangler dev` computes any iteration count, so a hash that
  authenticates locally can still fail in production; the boot guard catches
  it either way. `hashPassword` clamps to the running platform's ceiling, and
  a hash for another runtime can be minted with an explicit count.
- **Logs** go to the console as JSON, which is what `wrangler tail` reads.
- **The SPA** is served by Cloudflare's asset pipeline, not by the app's
  static middleware.
- **Scheduled jobs** do not run in-process. See below.
- **A configuration change resets the object.** A Durable Object keeps the
  `env` it was constructed with for as long as it stays resident, and this
  app schedules alarms, so it can stay resident indefinitely. Without
  intervention `wrangler secret put` would appear to do nothing: the new
  value binds to the stateless Worker while the object serving every request
  still holds the old one. The Worker therefore sends a digest of its
  bindings with each request, and the object resets itself when that digest
  stops matching the one it booted with. The request that detects it is
  answered with 503; the next one boots against the current bindings.
- **Rate limits that matter survive eviction.** The per-user creation cap is
  stored in the `rate_limits` table precisely because an in-memory window
  could be reset by pacing requests around an eviction. The in-memory,
  IP-keyed limiters keep short windows only, where the reset is not worth
  exploiting.
- **In-flight OAuth logins** are more fragile. The PKCE verifier is sealed
  with a key held in memory and never persisted, so a login that spans an
  eviction fails with `oauth_state_invalid` and the user retries. On Bun the
  same thing happens across a restart; it is just rarer there.

## Why Durable Objects and not D1

D1 was the obvious first choice and is the wrong one for this codebase.

- D1 runs in auto-commit. `BEGIN` / `COMMIT` are not available through the
  Worker API, and its only atomic unit is a static `batch()`. This app opens
  an interactive transaction in 20+ places, several of which read before they
  write (policy tuple rewrites, backup restore, file reference counting).
  Those cannot be expressed as a batch without losing rollback.
- Every D1 query is a network round trip. The policy engine walks relation
  tuples recursively, so a single authorized request can issue dozens of
  small queries — the pathological shape for a remote database.

A Durable Object owns its SQLite file locally: queries are in-process, and
`storage.transaction()` accepts an async callback and rolls back when it
rejects (verified in `tests/workers/smoke.ts`). The whole app lives in one
object named `app`, which keeps the same single-writer, single-memory-space
model the Bun process has — so the in-memory rate-limit buckets, step-up
tokens and per-request policy cache stay correct.

The trade-off is a single instance in a single location, with 10 GB of
storage and a 2 MB row ceiling. Blob content goes to R2, so the row limit
does not bind; throughput is bounded by one object's sequential execution.

### Cost shape

Row pricing is identical to D1 (25 billion reads and 50 million writes
included per month on the paid plan, then $0.001 per million rows read and
$1.00 per million rows written). Stored data is cheaper than D1 — $0.20 per
GB-month against $0.75, with the first 5 GB included. The difference is that
Durable Objects also bill compute duration: 400,000 GB-s are included per
month, and a 128 MB object held in memory for an entire 30-day month costs
about 332,000 GB-s, so a continuously warm single-instance deployment fits
inside the included allowance. Request billing is $0.15 per million after the
first million.

## OpenID Connect on Workers

Everything the flow needs is runtime configuration; nothing is stored in the
settings table. A deployment needs:

| Setting | Notes |
| --- | --- |
| `OAUTH_ISSUER` | Discovery fills the authorize, token, userinfo and end-session endpoints |
| `OAUTH_CLIENT_ID` | |
| `OAUTH_CLIENT_SECRET` | Omit for a public client; PKCE then carries the proof |
| `OAUTH_PKCE` | Defaults to `true` |
| `APP_URL` | Required in production — the callback URL is never inferred from forwarded headers |
| `CORS_ORIGIN` | Required in production once OAuth is in play |
| `DEFAULT_ADMIN` | Identities that are always admins; an email entry needs the provider's `email_verified` |

Register `${APP_URL}${BASE_PATH}/api/account/auth/callback` with the
provider. The authorize request asks for `openid profile email`, sends
`response_type=code`, and adds `code_challenge` with `code_challenge_method=S256`
when PKCE is on.

Single-user mode and OpenID Connect are mutually exclusive in practice: the
login page renders a local form or a provider button, never both, and
single-user wins. A deployment meant to use a provider must leave
`SINGLE_USER_MODE` unset, or the provider it exists for is hidden.

Two Workers-specific consequences:

- **Discovery is fetched on every boot.** The cache is a file, and there is
  no filesystem here, so each Durable Object start re-reads the provider's
  `.well-known/openid-configuration`. A provider that is unreachable at that
  moment leaves the endpoints unset and the login route answers
  `oauth_not_configured`. Setting `OAUTH_AUTHORIZE_URL`, `OAUTH_TOKEN_URL`
  and `OAUTH_USERINFO_URL` explicitly removes the dependency — they take
  precedence over discovery.
- **A login in flight does not survive a reset.** The PKCE verifier is sealed
  with a key held only in memory, so an eviction or a configuration change
  mid-login fails it with `oauth_state_invalid` and the user retries.

## Scheduled jobs on Workers

The cron module delegates scheduling to cronbake, which arms a timer per job
and assumes the process stays resident. A Durable Object is evicted when it
goes idle and only an alarm wakes it, so those timers would stop without an
error and jobs would silently never run. `CRON_ENABLED=true` is therefore
rejected at boot on Workers — the `residentTimers` capability is what that
check reads.

The job catalog, history and routes all still work; only the in-process
ticker is absent. Drive jobs from outside instead: point a Cloudflare Cron
Trigger (or any external scheduler) at

```
POST /api/cron/jobs/:id/trigger
```

which executes a job without the in-process scheduler and records the run in
the same history. The route is admin-only.

The app's own background sweeps — file GC and audit retention — are
unaffected: they go through the `scheduler` seam, which is backed by the
Durable Object alarm and survives eviction.

## Running on Workers

```bash
bun run --filter @app/web build      # the asset pipeline serves apps/web/dist
cd apps/api
cp .dev.vars.example .dev.vars       # local secrets, gitignored
bun run workers:dev                  # workerd via wrangler
bun run workers:build                # bundle only, no deploy
bun run workers:deploy               # wrangler deploy
```

Configuration lives in `apps/api/wrangler.toml`: the Durable Object binding
and its SQLite migration tag, the R2 bucket for blobs, the asset directory,
and the non-secret `vars`. Real secrets go through `wrangler secret put`.

A secret outranks a `var` of the same name, and `wrangler secret` publishes a
version of its own — so setting one after a deploy leaves two versions and a
question of which serves. Prefer deploying configuration as `vars` in the
same version as the code, and keep secrets for values that must not be
readable from the dashboard.

The asset pipeline answers every path the Worker is not listed for in
`run_worker_first`, serving the SPA's `index.html` for unknown ones. A route
prefix left out of that list never reaches the app — it returns HTML with a
200 — which is why every API surface, including the raw API, lives under
`/api/*`.

### BASE_PATH on Workers

Without a `BASE_PATH` the setup above is complete. With one (say `/u`) the
asset pipeline cannot help: the SPA is built with `BASE_PATH=/u` and its HTML
references `/u/assets/…`, but the files sit at the root of `apps/web/dist`,
and the pipeline has no way to strip a prefix. So the Worker runs first for
the SPA's own paths and maps them itself (`src/workers/spa.ts`): it strips the
prefix and asks the `ASSETS` binding, which still applies the single-page
fallback, and it forwards `/u/api/*` to the app. Three things have to agree:

- the SPA built with the same `BASE_PATH`;
- `BASE_PATH` (and `HOME_PAGE`, see `.env.example`) in `vars`;
- `run_worker_first = ["/", "/u/*"]` in `wrangler.toml`, replacing
  `["/api/*"]`.

The deploy workflow does all three from the `BASE_PATH` and `HOME_PAGE`
repository variables, and its smoke run goes through the prefix. At `/` the
Worker answers what the Bun server does: a redirect to the app, or the SPA
shell when `HOME_PAGE=root`. `bun tests/workers/smoke.ts --base-path /u
[--home-page root]` runs this under workerd against a prefix-aware build in
`apps/web/dist-smoke`.

Attaching a custom domain needs the zone on the same account; state it with
`zone_name` rather than relying on inference. Adding any route disables the
workers.dev URL unless `workers_dev = true` is explicit, and a newly attached
hostname routes before its certificate is issued — HTTP answers while HTTPS
fails the handshake for a few minutes.

Migrations are bundled into `src/db/migrations.generated.ts` because a Worker
has no filesystem to read `drizzle/` from. `bun run db:generate` regenerates
both; `bun run db:check-migrations` fails when the committed bundle is stale,
and CI runs it.

`bun run test:workers` boots the Worker in workerd and exercises boot,
login, transaction commit, transaction rollback and an R2 round trip. Pass
`--url https://…` to run the same suite against a deployment; the `workers`
workflow does that against a preview version when the repository has
Cloudflare credentials.
