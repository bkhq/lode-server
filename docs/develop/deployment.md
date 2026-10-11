# Deployment

> Examples assume `BASE_PATH=/app`. The app is mounted at root (`/`) by default; set `BASE_PATH` to serve under a URL prefix (e.g. behind a reverse-proxy mount).

The app has two deployment targets. This page first covers the **Bun** target — a lode-supervised release asset, usually in a container — and then, under [Cloudflare Workers](#cloudflare-workers), the target the registry is meant to run on in production. [Registry on the Bun target](#registry-on-the-bun-target) lists what a Bun deployment that takes release uploads has to set.

The Bun build target is a [lode](https://github.com/bkhq/lode)-compatible release asset. lode is a supervisor that downloads, verifies, runs, auto-updates, and rolls back the asset; production pairs it with a reverse proxy and a persistent volume for the SQLite database and uploaded attachments.

## Build options

```bash
# lode release asset (run on the same OS/arch you deploy to — Linux x64)
bun run package
# → dist/app-linux-x64.tar.gz   (bundled index.js + SPA dist/ + drizzle/ + libsql native binding)
#   dist/manifest.json          (schema lode/v1: channels → version → asset)
#   dist/checksums.txt          (SHA-256 of the tarball)

# Container image (runs the lode supervisor, not the app directly)
docker build -t myapp .
```

The asset is a flat runtime directory: lode unpacks it, runs `bun index.js` from the version directory, and the app serves the SPA from `dist/` and runs Drizzle migrations from `drizzle/` on disk. `BUILD_COMMIT` / `BUILD_VERSION` / `BUILD_TIME` are injected at package time (from git + the release tag) so `app --version` and `/api/system/version` report the real values.

The container image bakes only the lode binary on top of `oven/bun:1.4.2-debian` (override `BUN_IMAGE` / `LODE_IMAGE` build-args). The app itself is **not** in the image — lode fetches the release asset named by `deploy/lode.toml` (`[update].asset`) at runtime. See [Upgrade playbook](#upgrade-playbook) and the lode [integration guide](https://github.com/bkhq/lode/blob/main/docs/integration.md).

## Required environment

The complete env reference (every variable, its type, default, and
description) is generated from the zod schema in `apps/api/src/config.ts`
and the comments in `.env.example`. See [`env-reference.md`](../reference/env-reference.md);
CI rejects PRs that leave it out of sync.

Highlights for a production deploy:

| Variable | Why |
|---|---|
| `APP_NAME`, `APP_DISPLAY_NAME` | Branding (see [`forking.md`](forking.md)) |
| `APP_URL` | Production redirect-URI base; forwarded headers are not trusted in prod |
| `CORS_ORIGIN` | Comma-separated allow-list; fail-closed in prod when unset |
| `BASE_PATH` | URL prefix the app is mounted under. Leave unset for root mount; set to the reverse-proxy mount (e.g. `/app`) when serving under a prefix |
| `DB_PATH`, `DB_ENCRYPTION` | Persistent volume for the DB; encryption defaults to off for dev — turn on in prod |
| `OAUTH_*` | OIDC issuer or full endpoint set, plus client id/secret |
| `DEFAULT_ADMIN` | Comma-separated identities that are always admins (verified email, or username) |
| `LOG_FILE` / `LOG_TO_STDOUT` | Either rotates on disk or hands lines to the runtime |
| `AUDIT_RETENTION_DAYS` | `0` (keep forever) by default; set to a finite value in long-running deployments to bound `audit_events` size |
| `SERVICE_TOKEN_METRICS`, `SERVICE_TOKEN_BACKUP` | Scoped bearers for `/api/metrics` and `/api/backup/export-via-token` |

## Volumes

The container declares `VOLUME /srv/lode`. That volume holds lode's own state — `lode.toml`, the downloaded `versions/`, `state.json` — **and** the app's writable data under `/srv/lode/data`.

The app **must** write its data to the volume, never to its version directory (`/srv/lode/versions/<v>/`), which lode replaces on every update. This is handled automatically: the app resolves a top-level **`DATA_DIR`** and anchors the DB, uploads, and logs under it.

`DATA_DIR` resolves by the lode SDK's `dataDir()` order — explicit `DATA_DIR` → `LODE_DIR` → `ROOT_DIR` — but the lode/root dirs are used as a *base* with a `data/` subdir (`${LODE_DIR}/data`), so app state stays separate from lode's own `state.json` / `versions/`. lode injects `LODE_DIR=/srv/lode`, so app data lands at `/srv/lode/data` automatically. So **no per-path config is needed** under lode — the table below is the result:

| Path (under `${DATA_DIR}` = `/srv/lode/data`) | Variable (override) | Holds | Backup priority |
|---|---|---|---|
| `db/app.db` | `DB_PATH` | `app.db`, `app.db-wal`, `app.db-shm`, `meta.db` | Critical |
| `uploads/files/` | `FILE_STORAGE_LOCAL_ROOT` | All attachments; content-addressable blobs under the `file` module | Critical |
| `logs/app.log` | `LOG_FILE` (or `LOG_TO_STDOUT=true`) | Runtime logs | Operational |

Set `DATA_DIR` to relocate everything at once, or an absolute `DB_PATH` / `LOG_FILE` / `FILE_STORAGE_LOCAL_ROOT` to override one. Container deploys default `LOG_TO_STDOUT=true` so logs go to the runtime rather than a file under the volume.

## Health checks

The API exposes two distinct probes:

- `GET /<base>/api/health` → `200 {status:"ok"}` whenever the process is alive. Use for **liveness** — restart-on-failure semantics.
- `GET /<base>/api/health/ready` → `200 {status:"ready"}` when the DB is unlocked **and** reachable; `503 {status:"locked"\|"no_db"\|"db_unavailable"}` otherwise. Use for **readiness** — load-balancer pool membership.
- `GET /<base>/api/encryption/status` is still available for richer debug info (returns `{initialized, locked, status, dbError}`) but should **not** be used as a probe — its 200 response doesn't imply ready.

Recommended Kubernetes / docker-compose probes:

```yaml
livenessProbe:
  httpGet:
    path: /app/api/health
    port: 3000
readinessProbe:
  httpGet:
    path: /app/api/health/ready
    port: 3000
  # 200 = ready (db unlocked + reachable); 503 = drain traffic
```

## Reference compose stack (local dev / smoke test)

`examples/compose/` holds a reference docker-compose stack — app + a bundled `dex` IdP + a Caddy proxy — meant for local-development and smoke-test use. It is **not** a production deployable: dex ships with hardcoded test users, the proxy terminates plain HTTP, and the app runs against a self-signed IdP issuer. Treat it as the starting point you adapt for production: real IdP, real TLS, real secrets store.

```bash
cd examples/compose
cp .env.example .env                # populate APP_NAME, secrets, APP_URL, etc.
docker compose up --build
```

Required env (in `.env` next to the compose file): `APP_NAME`, `APP_DISPLAY_NAME`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `APP_URL`. The bootstrap token gating `/api/encryption/init` is auto-generated at every boot and printed to stderr / written to `<data dir>/bootstrap-token.txt` while the system is in setup mode (no `meta.db` yet) — there is nothing to set in `.env`. Strip the `dex` service and replace it with your real IdP for any non-toy deploy.

## Reverse proxy

Mount the app at `BASE_PATH` and pass the host header. Caddy example:

```caddy
your-domain.com {
  reverse_proxy /app/* localhost:3000 {
    header_up Host {host}
    header_up X-Forwarded-Proto {scheme}
  }
  redir /app /app/  # trailing slash
}
```

Set `APP_URL=https://your-domain.com` in the app's env so OAuth callback URLs are stable.

### TLS via Caddy automatic HTTPS

For a public-internet deployment, Caddy will auto-issue a Let's Encrypt certificate when you give it a domain and a contact email:

```caddy
your-domain.com {
  tls you@example.com
  reverse_proxy /app/* app:3000 {
    header_up Host {host}
    header_up X-Forwarded-Proto {scheme}
    header_up X-Forwarded-For {remote_host}
  }
  redir /app /app/  # trailing slash
}
```

The reference `examples/compose/Caddyfile` ships with plain `:80` for local smoke-testing — replace the site block with the form above (and forward 80/443 from the host) before pointing it at a real domain.

## Trust Proxy

`TRUST_PROXY` controls whether the app reads `X-Forwarded-For` (and, as a
fallback, `X-Real-IP`) to determine the client IP used for rate limits,
lockouts, audit logs, and DEK challenge caps.

- **Default (`TRUST_PROXY=false`)** — the app uses the connection peer IP only. Appropriate when the app is reachable directly. Behind a reverse proxy the peer is the proxy for every request, so all clients share one rate-limit bucket — including the registry read feed's (`RAW_API_RATE_LIMIT_PER_MINUTE`), which one client can then exhaust for every host — and one login lockout. Set `TRUST_PROXY=true` with `TRUSTED_PROXY_IPS` there; `.env.docker.example` does.
- **`TRUST_PROXY=true`** — the app honours the **rightmost** `X-Forwarded-For` entry (the hop closest to our process — the one set by the trusted proxy). `X-Real-IP` is read only when XFF is absent. Set this **only** when every request reaches the app through a proxy that **overwrites** both headers with the verified client IP.

### Mandatory proxy header rewrites

The proxy must **replace** any client-supplied `X-Forwarded-For` /
`X-Real-IP` so an attacker cannot forge a header to bypass per-IP gates.
Reference snippets:

**nginx**

```nginx
location / {
    proxy_pass http://app:3000;
    # `proxy_set_header` overwrites the value rather than appending.
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
}
```

**Caddy** — `reverse_proxy` already overwrites these headers by default.

**Traefik** — set `forwardedHeaders.trustedIPs` to the load balancer
subnet and Traefik will drop client-supplied forwarding headers.

### `TRUSTED_PROXY_IPS` allow-list

Defence-in-depth against a misconfigured proxy: set
`TRUSTED_PROXY_IPS` to a comma-separated CIDR list of the immediate
peer addresses you accept forwarding headers from. Requests whose peer
IP is outside the list are still served, but their forwarding headers
are ignored (the connection peer IP is used). Empty (default) preserves
the pre-flag behaviour. Example:

```ini
TRUST_PROXY=true
TRUSTED_PROXY_IPS=10.0.0.0/8,172.16.0.0/12
```

> **Security warning.** If you set `TRUST_PROXY=true` while the API is also reachable directly (port exposed on the host, alternate ingress, etc.) without `TRUSTED_PROXY_IPS`, an attacker can spoof `X-Forwarded-For` to bypass per-IP rate limits and poison audit log attribution. Either keep the API exclusively behind the proxy (no direct exposure), set `TRUSTED_PROXY_IPS` to the proxy subnet, or leave `TRUST_PROXY` at the default.

## Production compose addendum

The reference stack under `examples/compose/` is local-dev grade. For a production deployment, layer the items below on top of it (or maintain a separate `compose.prod.yml`).

### Secrets

Treat the following env vars as secrets and inject them via your platform's secret manager rather than committing them in `.env`:

- `OAUTH_CLIENT_SECRET` — IdP client secret.
- `MASTER_PASSWORD_FILE` — path to a single-use file containing the master password for unattended unlock (see [`operations.md`](operations.md) § Sealed-file unlock). Mount via the platform's secret manager so the file appears at runtime, is read once, and is then deleted by the app. Avoid `MASTER_PASSWORD` in plain env vars — `docker inspect` and process listings expose it.
- `SERVICE_TOKEN_METRICS` / `SERVICE_TOKEN_BACKUP` — bearer tokens for scrape / sidecar callers. Each min 32 chars; rotate independently.

The encryption bootstrap token is **not** an env var — it is generated at every boot, surfaced via stderr and `<data dir>/bootstrap-token.txt`, and consumed once by the setup wizard. Pull it from container logs (`docker compose logs app | grep BOOTSTRAP_TOKEN`) or the on-disk file; both are removed on `/encryption/init` success.

In compose, prefer `secrets:` files over `environment:` for the values that *are* secrets, so they do not show up in `docker inspect`:

```yaml
services:
  app:
    secrets:
      - oauth_client_secret
    environment:
      OAUTH_CLIENT_SECRET_FILE: /run/secrets/oauth_client_secret

secrets:
  oauth_client_secret:
    file: ./secrets/oauth_client_secret
```

(Wire `*_FILE` reading into your entrypoint, or use Docker Swarm / Kubernetes which read secret files natively.)

### Resource limits and lifecycle

```yaml
services:
  app:
    restart: unless-stopped
    mem_limit: 512m
    cpus: "1.0"
    pids_limit: 256
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/app/api/health"]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3
    depends_on:
      dex:
        condition: service_healthy
```

Pair `restart: unless-stopped` with the in-image `HEALTHCHECK` and use `depends_on: condition: service_healthy` so the app starts only after dependent services pass their checks.

### Database snapshots

Run an at-least-hourly snapshot sidecar — either `litestream` for continuous replication, or a simple `sqlite3 .backup` cron container that writes to a snapshot volume. Example sidecar:

```yaml
services:
  db-snapshot:
    image: alpine:3
    restart: unless-stopped
    volumes:
      - lode-data:/srv/lode:ro
      - app-snapshots:/snapshots
    entrypoint:
      - /bin/sh
      - -c
      - |
        apk add --no-cache sqlite tini
        while true; do
          ts=$(date -u +%Y%m%dT%H%M%SZ)
          sqlite3 /srv/lode/data/db/app.db ".backup '/snapshots/app-${ts}.db'"
          find /snapshots -name 'app-*.db' -mtime +7 -delete
          sleep 3600
        done
```

For anything past a single-tenant tool, prefer [litestream](https://litestream.io/) replicating to S3-compatible storage.

### Logs volume

Prefer `LOG_TO_STDOUT=true` under lode (the version directory is swappable). If you must write to disk, set `LOG_FILE` to a path under `/srv/lode/data/logs/` (or a separate mounted volume) so log retention does not compete with DB snapshots for disk pressure.

## Logging

Two output modes are supported:

- **File (default)** — `LOG_FILE` controls the destination. Pino writes JSON lines. Rotate with logrotate or your platform's log shipper.
- **Stdout** — set `LOG_TO_STDOUT=true` to write JSON lines to stdout instead of a file. **Recommended for container deployments**: the orchestrator (Docker, Kubernetes) collects stdout, attaches metadata, and ships it onward — no rotate-on-disk required.

Logrotate snippet (for the `LOG_FILE` case). The API holds the log fd open
for its process lifetime; the `SIGHUP` handler in
[`apps/api/src/index.ts`](../../apps/api/src/index.ts) calls
`logger.reopen()` so logrotate's `postrotate` is the correct signal
(`copytruncate` would race with pino's async buffer and lose lines):

```
/srv/lode/data/logs/app.log {
  hourly
  rotate 168
  size 50M
  compress
  delaycompress
  missingok
  notifempty
  create 0600 app app
  postrotate
      pkill -SIGHUP -x app >/dev/null 2>&1 || true
  endscript
}
```

A ready-to-drop example lives at
[`examples/logrotate.d/app`](../../examples/logrotate.d/app); copy it into
`/etc/logrotate.d/app` and adjust paths/user if needed.

## Operations runbook

Day-2 procedures (master-password rotation, lost-password recovery, snapshot restore, audit-log investigation) live in [`operations.md`](operations.md). Bookmark it before you cut over to production.

## Backup & restore

### Database

The DB is a single SQLite file with WAL. Two viable strategies:

1. **`sqlite3 .backup`** — atomic, doesn't block writers. Run out-of-band via cron; pair with `gpg --encrypt` if the box doesn't host the master password.
2. **[litestream](https://litestream.io/)** — continuous WAL replication to S3-compatible storage. Recommended for anything past a single-tenant tool.

### Application-level export

The `/api/backup/export` admin endpoint produces a JSON dump of selected modules. It requires the master password to prove DEK ownership, and import is **schema-version-locked** — see "Upgrade" below.

### Uploaded files

`${FILE_STORAGE_LOCAL_ROOT}` (default `data/uploads/files/`) is plain filesystem storage. Snapshot it together with the DB; orphaned blobs will eventually be reclaimed by the cleanup job, but mismatched DB+disk states will produce dangling references.

## Upgrade playbook

Updates are driven by [lode](https://github.com/bkhq/lode). To publish one: bump the version, cut a GitHub Release with a `v*` tag, and the `release` workflow builds + uploads the lode asset (`<app>-linux-x64.tar.gz` + `manifest.json` + `checksums.txt`). Each deployed lode polls its source (`deploy/lode.toml` `[update]`) on `check_interval`, then — per `policy` (`off` / `check` / `auto`) — downloads, verifies the checksum (and signature when `[trust].require_signature` is set), runs the new version, waits out `health_grace`, and **auto-rolls-back** to the last good version if the new one exits early. `keep_versions` bounds the retained versions.

**Sign your releases.** The checksum lives in the same release as the asset,
so on its own it proves integrity, not origin — anyone who can publish a
release can ship an asset every polling lode will install. Run
`lode-cli keygen` once, store the printed seed as the `LODE_SIGNING_KEY`
repository secret, and put the printed `trusted_keys` entry in
`deploy/lode.toml`. The `release` workflow then signs every asset
(`scripts/ci/sign-release.sh` → `<asset>.sig`) and lode's `auto` trust mode
fails closed on anything unsigned. Until a key is configured the signing
step is skipped and lode logs an UNVERIFIED warning on each install.

The SQLite migrations ship inside the asset (`drizzle/`) and run on boot of the new version. The risky schema cases:

| Change | Path |
|---|---|
| Add table / add nullable column | Drop in. lode rolls the new version in; migration auto-runs. |
| Add NOT NULL column with default | Same — defaults apply during migration. |
| Drop or rename column | Snapshot the DB first. Drizzle's "create new table + copy + swap" runs at boot; verify size and row count after. If it fails, lode rolls back to the prior version. |
| Major schema reshuffle | Use `/api/backup/export` (still on the old version), publish the new release, `/api/backup/import` to a fresh DB. Skip in-place migration entirely. |

Always run a restore drill (export → import on a scratch DB) before a production upgrade — it's the only way to know the schema-version locked import path is still intact.

### Master-key rotation

`/api/encryption/rotate-dek` is marked **EXPERIMENTAL** and gated behind `ENABLE_EXPERIMENTAL_DEK_ROTATION` (default `false`). With the flag off the route returns **501 Not Implemented**. With the flag on it can still fail under busy WAL with the known `SQLITE_IOERR`; the e2e suite asserts the current 500/`ROTATE_FAILED` contract so a future fix is detected automatically. Until it lands, prefer `/api/encryption/change-master` (changes the master password / re-wraps the DEK without touching ciphertext).

## Disabling encryption

Setting `DB_ENCRYPTION=false` skips the locked/unlocked dance entirely — useful for staging or air-gapped boxes where the OS already encrypts the disk. Once turned off, do not flip back on against a populated DB without going through the export → fresh init → import path.

## Registry on the Bun target

Everything above applies to the registry too. Three things are specific to
it:

- **Raise `MAX_UPLOAD_BYTES`.** `Bun.serve` caps every request body at
  `MAX_UPLOAD_BYTES` + 64 KiB — 10 MiB by default — and answers 413 before
  the app sees the request. A Bun deployment that accepts release assets
  must set `MAX_UPLOAD_BYTES` to at least `99614720` (the 95 MiB
  single-request limit). `67108864` covers the 64 MiB multipart parts only:
  single-request uploads between 64 and 95 MiB would still be refused.
- **Asset `GET` responses are chunked.** Bun sends a streamed body without
  `Content-Length`; only `HEAD` carries it. lode does not need the header.
- **Asset bytes are on disk**, under `REGISTRY_BLOB_LOCAL_ROOT`
  (`uploads/packages/` in the data directory). They are not part of a
  database backup — snapshot the directory together with the database.

The Workers target is affected by none of the three. See
[`modules/registry.md`](../modules/registry.md#known-limitations).

## Cloudflare Workers

The production target of the registry. How the app runs there — one Durable
Object, the capability differences from Bun, OpenID Connect — is described
in [`runtime.md`](runtime.md); this part is the deployment procedure.

> **Status.** None of the steps below was performed by this project's
> automation: no Cloudflare resource has been created and nothing has been
> deployed. Everything here needs the owner's account, hostname and identity
> provider. The checks that could only be run against a real deployment are
> listed under [Verification](#verification).

### What gets deployed

| Piece | Name in `apps/api/wrangler.toml` | Holds |
|---|---|---|
| One Worker | `lode-server` | The stateless entry: forwards every `/api/*` and `/r/*` request to the Durable Object. |
| One Durable Object with SQLite | class `AppDurableObject`, binding `APP` | The whole app and its database. |
| The SPA | `[assets]`, built from `apps/web/dist` | Served by Cloudflare's asset pipeline, not by the app. |
| R2 bucket `FILES` | `lode-server-files` | Blobs of the `file` module. |
| R2 bucket `PACKAGES` | `lode-server-packages` | Registry assets. |

`wrangler.toml` sets `REGISTRY_BLOB_DRIVER = "r2"`, and with that driver the
registry resolves its blob store when its routes are mounted. A Workers
deployment without the `PACKAGES` bucket binding therefore fails at boot
instead of at the first upload: **both buckets must exist before the first
deploy.**

### Owner checklist

Every value that has to come from the owner, and where it goes. "Repository
secret" and "repository variable" are GitHub Actions settings of this
repository, read by the `workers` workflow
(`.github/workflows/workers.yml`); "wrangler secret" is
`bunx wrangler secret put <NAME>` in `apps/api`; "`wrangler.toml` var" is a
line under `[vars]` in `apps/api/wrangler.toml`.

Cloudflare:

- [ ] **Account id** → repository secret `CLOUDFLARE_ACCOUNT_ID`.
- [ ] **API token** → repository secret `CLOUDFLARE_API_TOKEN`. Permissions
      it needs: *Workers Scripts: Edit* and *Workers R2 Storage: Edit* on the
      account; for a custom domain also *Zone: Read* and *Workers Routes:
      Edit* on the hostname's zone (the workflow lists the account's zones
      to check the zone before deploying).
- [ ] **Workers plan** → Cloudflare dashboard. The plan sets two limits the
      registry depends on. The request body cap — 100 MB on Free and Pro —
      is why multipart parts are fixed at 64 MiB and a single request at
      95 MiB; no plan needs to be bought for the body size. The CPU time
      allowed per request matters for one operation: completing a multipart
      upload reads the whole object back through SHA-256 inside the Durable
      Object (up to 4.2 s of CPU for 500 MiB, measured on local workerd).
      Choose a plan whose CPU limit covers that, and confirm it with the
      `--large` check below.
- [ ] **Production hostname** → repository variable `WORKER_CUSTOM_DOMAIN`
      (the bare hostname, no scheme). Operators embed it in `lode.toml`, so
      it is permanent once the first package is published.
- [ ] **The hostname's zone** → repository variable
      `WORKER_CUSTOM_DOMAIN_ZONE`. DNS: the zone must be on the same
      Cloudflare account; attaching the custom domain creates the record
      and the certificate, so no other record may already use the hostname.
- [ ] **Bucket names**, only if they differ from the defaults → `bucket_name`
      of the two `[[r2_buckets]]` entries in `wrangler.toml`. The workflow
      reads the names from there.

Identity provider:

- [ ] **OIDC issuer** → repository variable `OAUTH_ISSUER`. Without it the
      workflow deploys a single-user preview with a random password that is
      never printed: fine for a smoke run, not a usable registry.
- [ ] **Client id** → repository variable `OAUTH_CLIENT_ID`.
- [ ] **Client secret** → wrangler secret `OAUTH_CLIENT_SECRET`. Omit it for
      a public client; PKCE is on by default.
- [ ] **Redirect URI** → IdP console: register
      `https://<host>/api/account/auth/callback`.
- [ ] **Scopes and groups claim**, if group sync is wanted → repository
      variables `OAUTH_SCOPES` and `OAUTH_GROUPS_CLAIM`.
- [ ] **`DEFAULT_ADMIN`** — who becomes platform administrator → repository
      variable `DEFAULT_ADMIN`: comma-separated; an entry with `@` matches an
      email the IdP marks verified, any other entry a username. These
      accounts can act on every user's packages.

Application:

- [ ] **`APP_URL` and `CORS_ORIGIN`** — required in production. The workflow
      derives both from `WORKER_CUSTOM_DOMAIN` (`https://<host>`); nothing to
      set when deploying through it. For a manual `wrangler deploy` they are
      `wrangler.toml` vars. `APP_URL` is also the origin of every asset URL
      in a manifest.
- [ ] **Quota defaults** for an open sign-up registry → `wrangler.toml` vars
      `REGISTRY_MAX_PACKAGES_PER_USER` (default 50),
      `REGISTRY_MAX_STORAGE_BYTES_PER_USER` (default 10 GiB) and
      `REGISTRY_MAX_ASSET_BYTES` (default and ceiling 500 MiB). Leave them
      out to keep the defaults.
- [ ] **Creation rate limit.** The workflow deploys the single-user preview
      with `CREATE_RATE_LIMIT_PER_MINUTE = "10"` so its smoke suite can reach
      the limit — at 10 a user can create ten drafts a minute. An OpenID
      Connect deployment, where that suite is not run, keeps the shipped
      default of 60; set the var in `wrangler.toml` to change it.
- [ ] **Optional service tokens** → wrangler secrets
      `SERVICE_TOKEN_METRICS` and `SERVICE_TOKEN_BACKUP` (at least 32
      characters each), only if `/api/metrics` or the token-driven backup
      export is used.

The app reads no other secret in production: there is no session secret to
set (the comment in `wrangler.toml` that names `SESSION_SECRET` describes a
variable that [`env-reference.md`](../reference/env-reference.md) does not
list). Database encryption is the host's on Workers; `DB_ENCRYPTION` stays
`false`.

### Owner steps

In order. All of them remain to be done.

1. **Create both R2 buckets.** The workflow's *Ensure the R2 buckets exist*
   step does it; by hand:

   ```bash
   cd apps/api
   bunx wrangler r2 bucket create lode-server-files
   bunx wrangler r2 bucket create lode-server-packages
   ```

2. **Set the repository secrets** `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
3. **Set the repository variables** from the checklist, and commit any
   `wrangler.toml` change (bucket names, quota defaults).
4. **Deploy.** Run the `workers` workflow manually (*Actions → workers → Run
   workflow*). Its inputs:

   | Input | Effect |
   |---|---|
   | `fresh` | Deletes the Worker, its Durable Object database and every object in both buckets first. **Destroys all data**; for a preview only. |
   | `registry_large` | After the default smoke suite, also runs `--large --refused-body` against the deployment. Ignored for an OIDC deployment, where those checks need a token — see [Verification](#verification). |

   Or deploy by hand, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
   in the environment and the variables the workflow would append
   (`OAUTH_ISSUER`, `OAUTH_CLIENT_ID`, `DEFAULT_ADMIN`, `APP_URL`,
   `CORS_ORIGIN`, …) added under `[vars]`:

   ```bash
   bun run --filter @app/web build
   cd apps/api
   bunx wrangler deploy
   ```

5. **Set the wrangler secrets** (`OAUTH_CLIENT_SECRET`, optional service
   tokens). A secret belongs to the Worker, so it is set after the first
   deploy — and again after a `fresh` run, which deletes the Worker and its
   secrets with it. Setting one publishes a new version and resets the
   Durable Object; the request that notices is answered 503 once.
6. **Attach the custom domain.** The workflow adds the route
   (`custom_domain = true`, `zone_name`) when `WORKER_CUSTOM_DOMAIN` is set;
   for a manual deploy add the same `[[routes]]` block to `wrangler.toml`.
   The hostname routes before its certificate is issued: HTTPS can fail the
   handshake for a few minutes after the first attachment.
7. **Register the redirect URI** `https://<host>/api/account/auth/callback`
   at the IdP.
8. **Sign in as `DEFAULT_ADMIN`** and confirm the administration area is
   there. That login is what makes the account an administrator.
9. **Publish one package from a real CI run** with a `write`-granted token —
   the plan's M5 verification. Follow the
   [publisher guide](../guides/publisher.md) with
   [`examples/publish/`](../../examples/publish/), then install it on a host
   with the [operator guide](../guides/operator.md).

### Verification

The smoke suite (`tests/workers/smoke.ts`) runs against any deployment. From
a checkout with dependencies installed:

```bash
# single-user preview: boot, login, transactions, registry round trip, multipart, rate limit
SMOKE_USERNAME=<user> SMOKE_PASSWORD=<password> bun tests/workers/smoke.ts --url https://<host>

# OIDC deployment: provider wiring instead of a login
SMOKE_OAUTH_ISSUER=<issuer> SMOKE_OAUTH_CLIENT_ID=<client id> bun tests/workers/smoke.ts --url https://<host> --oidc
```

The workflow runs the first form itself with credentials it mints per run,
and the second when `OAUTH_ISSUER` is set. The default suite's last case
sends a burst of 40 creations and expects a 429, so it fails against a
deployment whose `CREATE_RATE_LIMIT_PER_MINUTE` is 40 or more — which is why
the workflow deploys the single-user preview with 10, and why an OIDC
deployment, left at the default of 60, is checked with the second form only.

Two checks could **not** be run without Cloudflare credentials and are still
open. Both are opt-in flags; a run given either flag does only the health
check, the login and the selected checks.

**(a) `--large` — a 500 MiB multipart completion under real limits.**

```bash
bun tests/workers/smoke.ts --url https://<host> --large
```

Uploads exactly 524288000 bytes in 8 parts, completes, publishes and
downloads the asset again with a digest check. While the completion is in
flight it probes `/api/health` and a published manifest once a second. It
prints:

| Line | Meaning |
|---|---|
| `part upload: …` | Time to send the eight 64 MiB parts — mostly your uplink. |
| `completion: …` | Time the server took to assemble the object and hash it. **This is the number the CPU limit bounds.** |
| `slowest of N probes during completion: … ms` | How long the app made another client wait while it hashed. |
| `download: …` | Time to read the asset back through `/r`. |

The check fails when the completion fails, when any probe answers anything
but 200, or when the slowest probe takes 10 s or more. Record the three
server-side timings. It moves 500 MiB up and 500 MiB down and needs about
300 MiB of memory on the machine running it.

**(b) `--refused-body` — a refused upload leaves the client usable.**

```bash
bun tests/workers/smoke.ts --url https://<host> --refused-body
```

Sends a 90 MiB upload the server refuses before reading it, then ordinary
requests that must succeed; then the same with a client that aborts its own
body after 16 MiB. It prints how long the refusal took — the cost of
draining the body — and how the abort ended. A failure here means a client
whose upload was refused loses its connection on the real edge.

Both flags can be combined in one run.

**Locally measured numbers say nothing about the edge.** On local workerd
the 500 MiB completion took about 3.6 s, and the refused body drained
without trouble — but local workerd enforces no CPU or memory limit and has
no edge in front of it. Until (a) and (b) have passed against the deployed
Worker, the 500 MiB limit and the connection behaviour are unverified in
production.

**Token mode, for an OIDC deployment.** There is no password to log in with,
so the two checks run with a token instead, against a package that already
exists:

```bash
SMOKE_REGISTRY_TOKEN=pat_... SMOKE_REGISTRY_PACKAGE=<namespace>/<slug> \
  bun tests/workers/smoke.ts --url https://<host> --oidc --large --refused-body
```

`SMOKE_REGISTRY_TOKEN` is a personal token with a `write` grant on
`SMOKE_REGISTRY_PACKAGE`. Without the two variables the checks are skipped
on an `--oidc` run, with a message. A token cannot delete a published
version, so each token run leaves behind, and lists at its end:

- a seed version `<run id>-seed` (a few KiB);
- with `--large`, a version `<run id>-large` (500 MiB, counted against the
  owner's storage quota);
- the channel `smoke`, pointing at the last of them.

Use a **dedicated package** for this and delete the whole package afterwards
from a session of its owner (the web UI, or
`DELETE /api/registry/packages/<namespace>/<slug>`): that removes the
versions, the channel and the stored bytes. Deleting only the versions does
not work for the one the `smoke` channel points at — a channel pointer can be
moved but not removed.

### Quotas and abuse controls

Every signed-in user may publish, so an open sign-up registry is bounded by:

- **Quotas** — 50 packages, 10 GiB of storage and 500 MiB per asset for each
  user by default (the three `REGISTRY_MAX_*` variables). An administrator
  overrides them for one user with
  `PUT /api/registry/admin/users/:userId/quota`; a limit left out falls back
  to the default, and the asset limit never exceeds 500 MiB.
- **Rate limits** — `CREATE_RATE_LIMIT_PER_MINUTE` / `_PER_HOUR` per user on
  creating packages, drafts, tokens and keys; `RAW_API_RATE_LIMIT_PER_MINUTE`
  (120 per IP) on the read feed.
- **Takedown** — an administrator yanks or deletes any version or package
  through the ordinary package routes, revokes any token
  (`DELETE /api/registry/admin/tokens/:id`), and suspends a namespace
  (`POST /api/registry/admin/namespaces/:slug/suspend`): its feed answers
  404, its owner becomes read-only and the owner's tokens are refused, until
  `…/restore`.
- **Disabling the user** in the template's user administration stops their
  tokens altogether.

`GET /api/registry/admin/namespaces` and `…/admin/packages` list storage per
namespace and per package. See
[`modules/registry.md`](../modules/registry.md#administration--apiregistryadmin).

### Future work

Mentioned only; none of it is built.

- **Presigned direct-to-R2 uploads** — deferred by the owner. Uploads go
  through the Worker in parts instead.
- **An edge cache for the read feed** in the stateless Worker, purged on
  publish. Today every manifest poll and asset download passes through the
  one Durable Object; the `/r/*` URLs will not change when a cache lands.
