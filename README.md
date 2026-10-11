# Lode Server

A hosted, multi-user release registry for [lode](https://github.com/bkhq/lode), built on the [bun-tpl](https://github.com/zzci/bun-tpl) template.

**Status: implemented, not yet deployed.** The registry API, read feed, web UI and publisher tooling are in place (milestones M0–M5 of [`docs/plan/20261009-2241-lode-registry-server.md`](docs/plan/20261009-2241-lode-registry-server.md)); the first Cloudflare deployment and its on-edge checks are the owner steps listed in [`docs/develop/deployment.md`](docs/develop/deployment.md). What ships today:

- **API** — Hono on Bun, SQLite via Drizzle, optional ECIES at-rest encryption.
- **Web** — React 19 + TanStack Router + Tailwind v4, file-based routes, dual EN/ZH i18n.
- **Registry** — per-user namespaces, packages with channels and draft → publish releases, streamed and multipart uploads to R2, optional ed25519 signatures, per-package token grants, quotas, admin controls, and the `/r` feed lode reads. See [`docs/modules/registry.md`](docs/modules/registry.md) and [`docs/guides/`](docs/guides/README.md).
- **Modules** — account/auth (OAuth + TOTP), groups, Zanzibar relation tuples, `item` base + `file` storage, cron, settings, audit logs, encryption admin, JSON backup.
- **Build** — lode-compatible release asset (`index.js` + SPA + migrations) via `scripts/package.ts`; self-updates under the [lode](https://github.com/bkhq/lode) supervisor.

## Quick start

```bash
bun install
cp .env.example .env       # uncomment the "Bundled dex IdP" block
bun run dev:all            # starts dex + web + api in one process group
```

Open the URL printed by `bun run dev:all` (e.g. `http://lode-server.localhost:3355`). Sign in with `admin@example.com` / `admin` — the bundled dex's static user. That login is an admin because it matches `DEFAULT_ADMIN`.

Already have an OAuth/OIDC provider? Point `OAUTH_ISSUER` at it in `.env` and use `bun run dev` instead — `dev:all` detects an external issuer and bows out so it doesn't fight your IdP.

### Reset local state

After `bun run dev:all` has run, `data/` contains the SQLite DB, uploaded blobs, and the OIDC discovery cache. To start over (e.g. after experimenting with `DB_ENCRYPTION=true` and forgetting the master password):

```bash
bun run clean        # build artefacts only (dist/, .vite/, .tanstack/, coverage/)
bun run clean:all    # also wipes data/ — DB, uploads, logs, oidc cache
```

`clean:all` is destructive; uncommitted local data is gone. Use it on a fresh clone or after intentionally tearing down a local experiment.

### First-run setup (only when `DB_ENCRYPTION=true`)

`DB_ENCRYPTION` defaults to `false` in dev — `bun run dev:all` lands you on login directly. If you enable encryption (recommended for production deploys), the first boot adds:

1. Visit `/<base>/setup`.
2. Paste the bootstrap token. It is auto-generated at every boot and surfaced via stderr / `<data dir>/bootstrap-token.txt` while the system is in setup mode; both go away once init succeeds.
3. Choose a master password — this derives the master keypair that wraps the data-encryption key (DEK).
4. Save the recovery key file (`<APP_NAME>-master-key.txt`).
5. Sign in via OAuth. Any login matching `DEFAULT_ADMIN` is an admin.

## Customize

- **Identity** — set `APP_NAME` (slug) and `APP_DISPLAY_NAME` in `.env`. HTML title, TOTP issuer, backup filename, and sessionStorage namespace derive from these. `BASE_PATH` is unset by default (root mount); set it to serve under a URL prefix. See [`docs/develop/forking.md`](docs/develop/forking.md).
- **Modules** — the shipped set is listed in [`docs/modules/`](docs/modules). To add one, follow [`docs/develop/module/playbook.md`](docs/develop/module/playbook.md) (10-step checklist) with starter files in [`docs/develop/module/recipe.md`](docs/develop/module/recipe.md).
- **Logo** — replace `apps/web/public/logo.svg` and the inline SVG in `apps/web/src/shared/components/logo.tsx`.

## Commands

```bash
bun run dev            # Vite dev server (web + API via @hono/vite-dev-server)
bun run dev:all        # dev + bundled dex IdP, one process group
bun run dev:dex        # just the bundled dex IdP (use when running dev in another terminal)
bun run rebrand        # rewrite manifests + .env defaults for a fork
bun run build          # Build all packages
bun run lint           # ESLint
bun run typecheck      # tsc --noEmit
bun run test           # Unit tests (bun:test + vitest)
bun run test:e2e       # Live e2e: dex + API + encrypted DB + every module
bun run check          # lint + typecheck + test + build + check:i18n + check:env-docs + check:api-docs
bun run gen:env-docs   # regenerate docs/reference/env-reference.md from the zod schema + .env.example
bun run gen:api-docs   # regenerate docs/reference/api-routes.md from the in-process Hono routes
bun run package        # Build the lode release asset (dist/<app>-<os>-<arch>.tar.gz + manifest.json + checksums.txt)
bun run clean          # Remove build artifacts
```

## Layout

```text
apps/api/          Hono API; Drizzle schema lives per-module
apps/web/          React 19 SPA (TanStack Router file-based)
packages/shared/   ECIES utilities used by both api and web
packages/tsconfig/ Shared TS config
docs/              Architecture, module standards, deployment, rebranding
tests/e2e/         Live e2e harness (dex + API)
scripts/           dev-all / dev-dex / rebrand / package / clean / hash-password
                   / check-i18n / i18n:unused / i18n:clean / gen-env-docs
```

## Documentation

- [`docs/README.md`](docs/README.md) — documentation index
- [`docs/architecture.md`](docs/architecture.md) — runtime shape
- [`docs/develop/module/standards.md`](docs/develop/module/standards.md) — adding a module
- [`docs/develop/forking.md`](docs/develop/forking.md) — rebranding checklist inherited from the template
- [`docs/guides/publisher.md`](docs/guides/publisher.md) — publishing a package from CI
- [`docs/guides/operator.md`](docs/guides/operator.md) — running an app that updates from the registry
- [`docs/develop/deployment.md`](docs/develop/deployment.md) — production deployment + upgrade, Cloudflare Workers
- [`docs/develop/operations.md`](docs/develop/operations.md) — runbook (logrotate, backup, restore, known issues)
- [`docs/develop/forking.md`](docs/develop/forking.md) — merging upstream template changes
- [`docs/plan/20261009-2241-lode-registry-server.md`](docs/plan/20261009-2241-lode-registry-server.md) — registry plan
- [`docs/modules/`](docs/modules) — per-module deep dives
