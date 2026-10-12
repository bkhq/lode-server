# Changelog

Track changes your fork makes on top of this template. Format adapted from
[Keep a Changelog](https://keepachangelog.com/) — group entries under
**Added / Changed / Removed / Fixed / Security**. The `Unreleased` block
holds work since your last tag.

Upstream cuts versioned tags so forks can anchor diffs against a known
template version. The boundary entries below summarise what shipped in
each upstream tag; your fork's `Unreleased` block sits at the top.

This repository is a fork: the dated entries directly below are Lode
Server's own, and everything from `Unreleased` down is the upstream
template's history, kept unchanged.

## 2026-10-12 11:20 [ci] [docs]

### Fixed

Settings → About on the Workers deployment reported `0.0.0-dev`, `dev` and
the isolate's start time (task `20261012-1120-workers-build-info`). The
`deploy` job of the `workers` workflow now passes `BUILD_VERSION` (root
`package.json`), `BUILD_COMMIT` and `BUILD_TIME` (the commit's time) to
`wrangler deploy`, as `scripts/package.ts` does for the lode asset. A manual
`wrangler deploy` still gets the placeholders unless it passes the same
`--define` flags.

## 2026-10-11 21:34 [ci] [deps] [docs]

CI repair and dependency updates (task
`20261011-2134-ci-and-dependency-updates`). `Upload Trivy results` runs only
when the scan wrote `trivy-image.sarif`, so a failed image build no longer
fails that step too. Actions: `actions/setup-node` v7,
`trufflesecurity/trufflehog` v3.99.2, `google/osv-scanner-action` v2.6.0.
Dependencies: the patch and minor updates of the runtime and tooling groups,
and `vitest` 5.0.3. The `docker build` and `e2e` jobs failed on the first
run only because `docker.io/bkhq/lode:v0.0.1` was not published yet.

## 2026-10-11 14:45 [api] [scripts] [ci] [docs]

**Breaking:** asset signatures are lode's `lode.artifact.v2` (task
`20261011-1443-artifact-signature-v2`). The signed message names the app, and the
registry verifies it with the package slug as the app:
`lode.artifact.v2\n{app}\n{name}\n{version}\n{sha256}\n{run}\n{exec}`. An
asset signed for one package is refused in another that trusts the same key,
which closes the gap the 13:30 entry left open. There is no fallback to
`lode.artifact.v1`: hosts need `[global].app` set to the package slug, and
assets signed before have to be published again. `scripts/publish.sh` and
`scripts/ci/sign-release.sh` pass `--app`; the test vectors are regenerated;
the lode pin of the e2e tests, CI, `examples/publish/` and the self-hosting
`Dockerfile` is `bkhq/lode:v0.0.1`, lode's first release after its version
reset. The "one signing key per package" advice of the 13:30 entry is
withdrawn. With no older lode left to support, `docs/develop/lode-compatibility.md`,
the older-lode e2e scenario and every "lode 0.0.x or newer" qualifier are
removed.

## 2026-10-11 14:10 [api] [web] [docs]

The id of a version that was published and then deleted is retired (task
`20261011-1355-retired-versions`). `POST …/versions` answers 409
`VERSION_RETIRED` for it, also after the package is deleted and created
again under the same slug; a deleted draft's id stays free. Before, the id
could be published again with other bytes while caches held the first ones
as `immutable`. New table `registry_retired_versions` (migration
`0002_retired_versions`), part of the registry backup.

## 2026-10-11 13:30 [api] [scripts] [ci] [docs]

Security fixes from the 2026-10-11 audit (task `20261011-1305-audit-fixes`).

### Security

- OIDC login no longer rebinds an account to a new IdP subject by username.
  Only the single-user row is claimed by username; any other account, with
  or without a password, is linked by a verified email. Before, a second IdP
  identity presenting the same `preferred_username` took the account over,
  admin role included.
- Completing a multipart upload answers 400 `INVALID_SIGNATURE` when the key
  its signature was verified under at start has been revoked since.
- `scripts/sign-manifest.sh` signs a manifest its key has not signed before
  only when the channels equal the new `--expect <channel>=<version>`
  arguments; an unchanged manifest is renewed without them.
  `examples/publish/sign-manifest.yml` does the same and takes an `expect`
  input. **Breaking** for callers that sign after a release step.
- `.env.docker.example` sets `TRUST_PROXY` and `TRUSTED_PROXY_IPS`: behind
  Traefik every client otherwise shares one rate-limit bucket, the read
  feed's included.
- `Dockerfile` and `scripts/ci/sign-release.sh` pin `bkhq/lode` v0.0.6 by
  digest; `deploy/lode.toml` pins the bun runtime's `sha256`; the release
  job's actions are pinned by commit.

### Changed

- CI pulls `bkhq/lode:v0.0.5` and `v0.0.4`, the versions the real-client e2e
  suites use (it pulled v0.0.2, so they skipped themselves), and those suites
  fail in CI when the binary is missing.
- Publisher guide and module doc: one signing key per package. The signed
  asset message does not name the package.

### Open

Not pursued:
`trusted_keys` and `enforce` in `deploy/lode.toml` — the production registry
runs on Cloudflare Workers, not through lode; that file is the self-hosting
template.

## 2026-10-10 21:30 [api] [web] [docs]

Publisher-signed manifest, for lode v0.0.5's `[trust].require_manifest`
(task `20261010-2100-manifest-signature`). A package can store the
publisher's signature over the manifest the registry generates:
`PUT /api/registry/packages/:ns/:pkg/manifest-signature` (`write` grant)
verifies `key_id` / `sig` and an optional `expires` / `expires_sig` against
the catalog rebuilt from the database, `GET` reports the state, `DELETE`
removes it. The feed attaches the signature only while it is live — same
catalog, key active, not expired — and serves the manifest unsigned
otherwise. New table `registry_manifest_signatures` (migration
`0001_manifest_signatures`). The package's Install tab shows the state.
`scripts/sign-manifest.sh` and `examples/publish/sign-manifest.yml` do the
publisher's side. The lode pin in the e2e tests and `examples/publish/`
moves to `bkhq/lode:v0.0.5`.

Also: the Install tab generates a complete, downloadable `lode.toml`, and
`GET …/keys` is open to anyone who can read the package so that file carries
the publisher's `trusted_keys`.

## 2026-10-10 20:45 [docs]

`docs/develop/lode-compatibility.md`: what each lode release changes for the
registry. lode v0.0.4 needs nothing. lode v0.0.5's manifest expiry keeps
working against the registry under its default policy; the guide lists what a
host cannot enable yet, what the generated `lode.toml` must not contain, and
the outline, signed bytes and tests for serving a publisher-signed manifest.

## 2026-10-10 18:00 [web]

The site serves `/llms.txt`: what the registry is, its three addresses, how to
publish with `lode-cli publish`, how to configure a host, where to get lode,
the HTTP sequence behind a release, and links to the guides. It is a static
file in `apps/web/public`, so it names `lode.bk.io`; a deployment elsewhere
has to edit it. On Workers the asset pipeline serves it at the origin root
whatever `BASE_PATH` is; a Bun deployment under a `BASE_PATH` serves it below
the prefix only.

## 2026-10-10 17:00 [web]

The home page has a "Get lode" part: the install command, the four release
archives, the container image, and links to lode's repository and releases.
lode `v0.0.2` contains `lode-cli publish`, so tests, CI and the workflow
example pin `bkhq/lode:v0.0.2` instead of a digest.

## 2026-10-10 16:00 [publish]

lode moved to `github.com/bkhq/lode` (image `docker.io/bkhq/lode`) and gained
`lode-cli publish`. References follow, the publisher guide, the workflow
example, `examples/hello` and the home page use the command, and
`scripts/publish.sh` stays as the alternative where `lode-cli` cannot be
installed. The e2e suite drives both against the live registry.

Tests, CI and the workflow example pin the lode image by digest: no tagged
lode release contains the command yet. Move the pin to a tag once one does.

## 2026-10-10 15:00 [decision]

The database migrations are folded into one, `0000_init`, generated from the
current schema, and the repository history starts over again from a single
commit. Nothing had real data yet, so existing databases are not migrated:
a database created before this point has to be discarded (locally, remove
`data/`; on Cloudflare, deploy with the workflow's `fresh` option, which
deletes the Worker with its Durable Object database and empties both R2
buckets). Earlier entries below that name migrations `0001`–`0004` describe
steps that are now part of `0000_init`.

## 2026-10-10 14:00 [template]

Template baseline moved from `30fec5b` to `4d78d5d`: password accounts next
to OIDC (`LOCAL_LOGIN`) and the bootstrap-admin fix, cherry-picked.

Upstream added `users.password_hash` by editing its initial migration. This
repository's databases already exist, so `0000_init.sql` is left as it was and
migration `0004` adds the column instead.

The deploy workflow passes the `LOCAL_LOGIN` repository variable through for
an OpenID Connect deployment, so both sign-in methods can be offered.

## 2026-10-10 13:00 [decision]

The repository moves to `github.com/bkhq/lode-server` and its history starts
over from one initial commit. Repository URLs in the manifests,
`deploy/lode.toml` and the publisher example follow. References to lode stay
on `dotns/lode` until lode moves as well.

The tree at that commit includes the template (`zzci/bun-tpl`) up to
`30fec5b`. With no shared history a `git merge template/main` no longer
applies; take later template changes commit by commit instead:

```bash
git fetch template
git log --oneline 30fec5b..template/main      # what is new upstream
git cherry-pick -x <commit>...                 # oldest first
```

and move the baseline named here forward after each round.

## 2026-10-10 12:10 [decision]

Address layout for the deployment: the console and its API under `/u`
(`BASE_PATH=/u`), a public home page at the origin's `/` (`HOME_PAGE=root`,
merged from the template), and the read feed at `/r` on the origin root.

The feed no longer follows `BASE_PATH`: it is mounted at `/r` whatever the
prefix, and the asset URLs in a manifest are built without it. The manifest
address is what operators put in `lode.toml`, so it must not move when the
console does. The home page content is `apps/web/src/app/routes/-landing.tsx`,
rendered by the template's `-home.tsx`.

The login page's `redirect` check now resolves the target against the page's
origin: `/\host` passed the old prefix test and left the site after a local
(single-user) login.

Open: Workers serve static assets from the bundle root, so a build with a
`BASE_PATH` needs the asset directory laid out under the prefix and
`run_worker_first` listing `/u/api/*`. Not done; `wrangler.toml` still
describes a root mount.

## 2026-10-10 11:20 [decision]

Signing keys belong to a package, not to a user. `registry_keys` is keyed by
`package_id` (unique with `key_id`, removed with the package); the routes are
`GET` / `POST /api/registry/packages/:ns/:pkg/keys` and `DELETE …/keys/:id`;
an upload signature must verify under a key of the package it goes into. The
web UI drops the Signing keys page for a tab on the package page.

A token with a `write` grant on the package may list and register its keys, so
CI needs the seed only: `scripts/publish.sh` derives the public key from
`LODE_SIGNING_KEY`, registers it and treats 409 `KEY_EXISTS` as done.
Revoking stays with the owner or an administrator, session only.

Why: the owner asked for both. A stolen token can register its own key and pass
the registry's upload check, which is accepted — the protection that matters is
the operator's pinned `trusted_keys` under `require_signature = "enforce"`.

Migration `0003` copies each existing key to every package its user owns, so
releases that verified before still do.

## 2026-10-10 02:40 [web]

Milestone M4: the registry web UI, walked through in a browser as an
ordinary user and as an administrator, in English and in Chinese.

- **Added — screens.** `/overview` (packages and storage against quota, the
  caller's namespace, the five newest versions, first-run steps);
  `/packages` (namespace with owner, quota usage, package table, create
  dialog); `/packages/$ns/$pkg` with the tabs Versions (assets, new draft,
  publish, yank / restore, delete), Channels (add, move), Install (manifest
  URL and the `lode.toml` snippet) and Settings (edit, delete); `/keys`
  (register, copy the `trusted_keys` entry, revoke); `/tokens` (per-package
  or all-packages grants, secret shown once, edit grants, revoke, the
  statement of what no token can do); and for administrators
  `/admin/registry` with Namespaces (suspend / restore, per-user quota),
  Packages (open, make private, delete) and Tokens (all or one user's,
  revoke). Sidebar: Packages, Signing keys and Access tokens in the main
  group, Registry beside Users in the admin group.
- **Added — foundation.** `apps/web/src/shared/lib/registry` (wire types,
  one API function per endpoint, the `registryKeys` query-key factory with
  a `queryOptions` per `GET`, byte and grant helpers, error-code messages)
  and the locale shards `packages`, `package`, `keys`, `grants`,
  `registry` and `regerrors` in `en` and `zh`. Described in
  `apps/web/README.md`.
- **Decisions.**
  - No asset upload in the browser: publishing happens from CI with an
    access token; the Versions tab says so and links to the token page.
  - The create dialog always sends `visibility` and defaults it to private,
    because the API creates a package public when the field is left out.
    Confirmed in the browser: a package created with the defaults is private.
  - The Install snippet carries a `[trust]` block with
    `require_signature = "enforce"` only for a signed asset — with the real
    `<key_id>:<public key>` when the signing key is one of the viewer's —
    and a warning instead for an unsigned one; a private package adds the
    `[http]` block. It also writes `[update].channel`, a key lode documents
    for the native manifest source.
  - Write controls are shown to the namespace owner and to administrators;
    everyone else gets a read-only package page.
  - The admin lists are fetched once and filtered on the client (the
    endpoints are unpaginated). The Tokens tab keeps the chosen user in the
    `user_id` search parameter, read and written through a cast because the
    route declares no search schema; the row action on Namespaces lands on
    the filtered list, a reload keeps it and the chip clears it.
  - Quota overrides are entered in MiB or GiB and validated like the server
    does; clearing every field removes the override.
  - Editing the grants of a token created on the settings dialog's token tab
    keeps its other scopes (checked with an `account:read` token).
  - Every mutation invalidates the query keys it affects; nothing patches
    the cache by hand.
- **Fixed by the walkthrough.**
  - Four selects on the package page (channel dialog version, Install
    channel and asset, Settings visibility) had no accessible name.
  - A token created or revoked on the settings dialog's token tab did not
    reach the access tokens page behind it until a reload.
  - Chinese copy: two words for "channel", a mixed pronoun, and half-width
    punctuation throughout the admin shard.
- **Found, not fixed (outside the web app).**
  - `bun run dev` routes only `/api` to the API (`apps/api/package.json`
    registers `<app>:/api` with nsl), so `/r/...` on the dev URL answers
    the SPA's HTML and the manifest URL shown on the Install tab is not
    usable there. The feed works on the API port and in a built deployment,
    where one process serves all three.
  - A package's `updated_at` does not move when a version is created or
    published, only when its settings change. The package list's "Updated"
    column and the overview's choice of the five packages to read versions
    from therefore follow settings edits, not releases.
  - The package page shows no "suspended" notice: the package response
    carries no namespace status. The owner sees it on `/packages` and in
    the error of a refused write.
  - Token scope descriptions on the settings token tab come from the API in
    English only.
- **Open — API gaps.**
  - The package response has no owner: the page shows it only for the
    viewer's own namespace or, for an administrator, from the admin list.
  - No endpoint exposes a publisher's public key to other users: the
    snippet shows a placeholder for a key that is not the viewer's own.
  - No cross-package recent-versions endpoint: the overview merges the
    version lists of five packages.
  - The admin token list carries only `user_id`; owner names are joined in
    the browser from the namespace list.
- **Checked:** `bun run check:i18n` (21 namespaces in sync) and
  `bun run i18n:unused` (0 unused of 1004 keys). No console error or
  warning on any screen in either language.

## 2026-10-10 02:27 [workers-workflow]

- **Fixed:** the `workers` workflow wrote `CREATE_RATE_LIMIT_PER_MINUTE =
  "10"` into every deployment, including an OpenID Connect one, where the
  suite that needs the low limit is never run. Only the single-user preview
  gets it now; an OIDC deployment keeps the default of 60.
  `docs/develop/deployment.md` says the same.
- **Fixed:** `tests/workers/smoke.ts` told the owner to delete the versions
  a token run leaves behind, which the `smoke` channel prevents (409
  `VERSION_IN_CHANNEL`). The header and the printed message now say to use a
  dedicated package and delete the whole package.
- **Fixed:** `examples/publish/README.md` lists every tool
  `scripts/publish.sh` requires (`dd`, `wc` and `awk` were missing).

## 2026-10-10 02:24 [guides]

Milestone M5, part 4: the guides, and what is left for the owner.

- **Added:** `docs/guides/publisher.md` (namespace, package, signing keys,
  tokens and grants, `scripts/publish.sh`, CI, channels / rollback / yank,
  quotas and an error table) and `docs/guides/operator.md` (`lode.toml` for
  a registry package, trust, private packages, rate limiting, caching,
  suspended namespaces and yanked versions, troubleshooting), with a short
  `docs/guides/README.md`. They link to `docs/modules/registry.md` for the
  contract instead of copying its tables.
- **Added:** a *Cloudflare Workers* part in `docs/develop/deployment.md` —
  what gets deployed, an owner checklist with the destination of every
  owner-supplied value, the owner steps in order, verification on the
  deployed Worker, quotas and abuse controls — and *Registry on the Bun
  target* (`MAX_UPLOAD_BYTES` ≥ 99614720, chunked asset `GET`, assets on
  disk).
- **Changed:** `docs/README.md` no longer says the registry is not
  implemented and lists the guides; the root `README.md` links them;
  `tests/e2e/README.md` describes the registry suites, how the lode binary
  is found, the two registry entries `run.ts` sets, and the fourth phase its
  tree and sample summary had been missing.
- **Changed:** `docs/modules/registry.md` — multipart on R2 / workerd is now
  covered by `bun run test:workers`; only the deployed run stays open.
- **Fixed:** the `workers` workflow skipped the default smoke suite on a run
  with `registry_large`: the suite runs only the selected checks when given
  `--large` / `--refused-body`. The default suite now always runs first and
  the opt-in checks follow as a second command.
- **Found — a refusal outside the upload routes does not drain the body.**
  A 429 from the creation rate limiter, or `POST /uploads/:id/complete` sent
  with a JSON body while a part is missing, leaves the request body unread;
  on local workerd the client's next request on that connection can fail
  with a 500 "Network connection lost". Unverified on the real edge.
  Recorded under *Known limitations*; draining in the shared refusal path is
  deferred, as is typechecking the repository-level `tests/` directory in
  `bun run check`.
- **Found — a channel pointer cannot be removed.** A smoke run in token mode
  leaves the channel `smoke` pointing at its last version, and that version
  cannot be deleted while the pointer is there. The deployment guide tells
  the owner to use a dedicated package and delete the package.
- **Found — `SESSION_SECRET`.** The secrets comment in
  `apps/api/wrangler.toml` names it, but the app reads no such variable
  (`docs/reference/env-reference.md` does not list it). The deployment guide
  says so; the comment is left as it is (template surface).
- **Remaining owner steps** — none was performed by this project's
  automation: create the two R2 buckets; set the repository secrets
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` and the repository
  variables (hostname and zone, OIDC issuer and client id, `DEFAULT_ADMIN`);
  run the `workers` workflow or `wrangler deploy`; set `OAUTH_CLIENT_SECRET`
  with `wrangler secret put`; attach the custom domain; register the redirect
  URI at the IdP; sign in as `DEFAULT_ADMIN`; run `smoke.ts --large` and
  `--refused-body` against the deployed Worker and record the timings;
  publish one package from a real CI run with a `write`-granted token. The
  list with every value and its destination is in
  `docs/develop/deployment.md`.

## 2026-10-10 02:24 [ci]

Milestone M5, part 3: the workflows.

- **Changed:** the `workers` deploy job handles **both** R2 buckets. It
  creates, and on a `fresh` start empties, every bucket named in
  `apps/api/wrangler.toml` (`lode-server-files`, `lode-server-packages`)
  instead of assuming one.
- **Added:** the `registry_large` dispatch input, which runs the opt-in
  registry checks (`--large --refused-body`) against a non-OIDC deployment;
  the deploy job's timeout is 40 minutes for the 500 MiB transfer.
- **Added:** the e2e job pulls `docker.io/dotns/lode:v0.3.3`, the image the
  real-client suite extracts the lode binary from. A failed pull raises a
  warning annotation and the suite skips itself; the job does not fail.
- **Added:** a `shellcheck` job over `scripts/ci/*.sh` and
  `scripts/publish.sh`.
- **Fixed:** the hint `scripts/dev-all.ts` prints when the bundled dex block
  is sealed showed the template's names. It now resolves the real issuer,
  client and app URL from `APP_NAME` and nsl, so following it works.

## 2026-10-10 02:24 [workers-smoke]

Milestone M5, part 2: the Workers smoke suite.

- **Added:** a multipart case in the default suite (`bun run test:workers`,
  now 8 cases): a 65 MiB asset goes into R2 in two parts, the completion
  digest is checked both ways (match and `DIGEST_MISMATCH`), and the asset
  is read back through `/r` with its `Content-Length` and a streamed digest.
- **Added:** two checks for a deployed Worker, `--large` (one 500 MiB
  multipart upload, with `/api/health` and a manifest probed once a second
  during completion; every probe must answer 200 within 10 s) and
  `--refused-body` (a refused and a client-aborted 90 MiB body must leave
  the client usable).
- **Decision — opt-in flags run only the selected checks.** A run given
  either flag does the health check, the login and those checks, never the
  default suite; a workflow that wants both runs the suite twice.
- **Decision — token mode.** With `SMOKE_REGISTRY_TOKEN` and
  `SMOKE_REGISTRY_PACKAGE` the two checks use a write-granted token against
  an existing package and send nothing but the `Authorization` header. It is
  the only way to run them against an OIDC deployment, where there is no
  password; without the variables they are skipped there with a message.
- **Found — the creation limit is per route.** The package and the draft a
  registry case creates take nothing from the resource-group budget the
  rate-limit case spends, so the cases do not have to share one budget.
- **Changed:** an unknown argument ends the run with the usage text instead
  of passing as a default run.
- **Not run:** `--large` and `--refused-body` against a deployed Worker —
  that needs Cloudflare credentials. The local figure (completion in about
  3.6 s for 500 MiB) is from workerd, which enforces no limits.

## 2026-10-10 02:24 [publish]

Milestone M5, part 1: publisher tooling.

- **Added:** `scripts/publish.sh` — one release of one package: create a
  draft, upload every asset, publish to a channel. Single request up to
  95 MiB, multipart above it in the part size the registry dictates, 500 MiB
  per asset. Needs `bash`, `curl`, `jq`, `sha256sum` or `shasum`, `dd`, `wc`
  and `awk`.
- **Added:** `examples/publish/` — a GitHub Actions workflow for a
  publisher's own repository (release or manual run → build → fetch
  `publish.sh` → optional signing → publish) and its README.
- **Added:** `tests/e2e/modules/registry/publish.test.ts`, which runs the
  script against the live API, including one asset of about 96 MiB through
  the multipart path.
- **Decision — the token comes from the environment only**
  (`LODE_REGISTRY_TOKEN`; there is no option for it) and reaches `curl` on
  stdin as a config line, so it is in no argument list and in no file. The
  script never traces.
- **Decision — uploads are streamed** with `curl --upload-file`, which also
  sends the size as `Content-Length`; a multipart part goes through one
  scratch file at a time.
- **Decision — a re-run continues into an existing draft.** On
  `VERSION_EXISTS` the script looks the version up and, when it is still a
  draft, uploads into it; a same-named asset is replaced and the draft's
  notes are kept. A published version fails the run.
- **Decision — per-asset `run` / `exec` overrides are not supported** by the
  script. The API accepts them; a release that needs them calls the upload
  routes itself.
- **Decision — the publish test lives in the registry e2e directory**, next
  to the suites of the routes it drives, and is picked up by phase B with
  them.
- **Signing** is on when `LODE_SIGNING_KEY` is set: every asset is signed
  with `lode-cli sign`, and the script refuses to upload unsigned when the
  key is set but `lode-cli` is not on `PATH`.

## 2026-10-10 01:49 [registry]

Milestone M3, part 2: live end-to-end coverage, with the real lode client,
and the module documentation.

- **Added:** `tests/e2e/modules/registry/` — one suite per resource
  (namespace, keys, packages, tokens and grants, versions, multipart
  uploads, admin, read feed, audit entries) against the live API, and
  `lode.test.ts`, which drives the real `lode` / `lode-cli` 0.3.3 binaries:
  signed package under `require_signature = "enforce"` (key from
  `lode-cli keygen`, assets signed with `lode-cli sign`, published with a
  write-granted token), unsigned package under `off`, refusal to follow a
  rolled-back `latest`, and a private package fetched with `[http].headers`.
  Each scenario asserts on lode's exit status, its output and the files it
  installed.
- **How lode runs.** The binary is static, so the suite runs it directly on
  the host against the API on loopback (lode allows plain http there). It
  is taken from `E2E_LODE_BIN`, from `tests/e2e/.cache/lode/`, or copied out
  of the local image `dotns/lode:v0.3.3` (container created, never started,
  removed). With none of them the suite is skipped with a message.
- **Changed:** `tests/e2e/run.ts` sets `REGISTRY_BLOB_LOCAL_ROOT` (inside
  the per-run data dir, so assets are removed with it) and
  `MAX_UPLOAD_BYTES` (100 MiB) on the API it spawns.
- **Found — Bun request-body cap.** `Bun.serve` is given
  `maxRequestBodySize = MAX_UPLOAD_BYTES + 64 KiB` in
  `apps/api/src/index.ts`, 10 MiB by default. With default settings the Bun
  target therefore answers 413 to a single-request asset upload above 10 MiB
  and to every full 64 MiB multipart part, before the app sees the request.
  Not fixed here (template surface); the e2e run raises `MAX_UPLOAD_BYTES`,
  and the module doc tells a Bun deployment to. Workers is not affected.
- **Found — no `Content-Length` on asset `GET` under Bun.** The feed sets
  the header, but Bun sends a streamed body chunked and drops it; `HEAD`
  carries it, and so does `GET` on Workers (the smoke suite asserts it).
  lode does not need it. Left as is and documented.
- **Checked — dex client pairs.** The first `bun run test:e2e` passed as it
  was, including the `file` and rewritten `tokens` suites. Each stack is
  consistent with itself: `tests/e2e` and `examples/compose` use `app` /
  `app-secret` on both the dex and the API side; `scripts/dev-dex.ts`
  defaults to `lode-server` / `lode-server-secret`, which is what
  `.env.example` documents for the app. Nothing needed changing. The one
  stale spot is the hint `scripts/dev-all.ts` prints (`app` / `app-secret`,
  `dex-app.localhost`), which still shows the template's names.
- **Docs:** `docs/modules/registry.md` (with *Deviations from the plan*,
  *Known limitations* and *Deferred*), registry rows in
  `docs/modules/README.md`, `docs/architecture.md`,
  `docs/reference/api.md` and `docs/reference/database.md`. The generated
  `api-routes.md` and `env-reference.md` were already current.
- **Changed:** `apps/api/src/app.test.ts` sets
  `REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS` to `0`, like the file GC, so the
  full-app test schedules nothing.

## 2026-10-10 01:28 [registry]

Milestone M3, part 1: the lode-facing read feed and the Workers round trip.

- **Added:** `GET /r/:ns/:pkg/manifest.json` (the generated `lode/v1`
  manifest) and `GET /r/:ns/:pkg/:ver/:asset` (the asset bytes, streamed from
  the blob store). The feed is a second app from the raw-app builder,
  mounted at `${BASE_PATH}/r` beside the raw API: no session, CSRF, CORS or
  policy middleware, and it shares the raw API's per-client rate-limit
  budget. HEAD is answered without opening the blob.
- **Manifest.** `name` is the package slug. Published versions only, newest
  first by publication time, capped at `REGISTRY_MANIFEST_MAX_VERSIONS` plus
  every channel target. `notes` is included when the version has it; `sig` /
  `key_id` / `alg` / `run` / `exec` are left out when absent, never null. No
  catalog signature. Asset urls use the origin the template derives its
  public URL from (`APP_URL`, else the request outside production).
- **Access.** Public packages are anonymous; a private one needs a bearer
  token with a read grant, and a session is never consulted. Every refusal —
  unknown, private without a grant, suspended namespace, draft or yanked
  version — is the same JSON 404. Yanked versions are not downloadable.
- **Caching.** Public manifest: strong `ETag` (SHA-256 of the body),
  `public, max-age=60`, 304 on `If-None-Match`. Public asset: `public,
  max-age=31536000, immutable`. Private: `private, no-store`, no `ETag`.
- **Security headers.** Unlike the raw API, `/r` keeps the outer app's
  browser security headers (CSP, `nosniff`, …): it serves user-uploaded
  bytes from the application's origin, and lode ignores them.
- **Docs gap.** The routes carry `describeRoute` and are described in
  `docs/reference/api.md`, but the OpenAPI document and the generated
  `api-routes.md` only walk routes under `/api`, so `/r` is in neither yet.
- **Changed:** a part upload or a completion on a multipart upload past its
  `expires_at` now answers 409 `UPLOAD_EXPIRED`, aborts the upload in the
  store and removes its row, instead of depending on the sweep having run.
- **Fixed:** an upload refused before the blob store took its body
  (validation, auth, quota, `INVALID_SIGNATURE`, …) now has that body read
  to its end and discarded instead of cancelled. On workerd, cancelling did
  not stop `Can't read from request stream after response has been sent`,
  and the client's next request failed with a lost connection; the Workers
  smoke test found it. The bytes are dropped as they arrive, nothing is
  buffered or stored.
- **Changed:** the expired-upload sweep is started at boot
  (`startRegistryUploadSweep` in `buildFullApp`) and stopped at shutdown.
- **Changed:** `apps/api/wrangler.toml` sets `REGISTRY_BLOB_DRIVER = "r2"`,
  so a Workers deployment stores assets in the `PACKAGES` bucket and the
  binding is verified at boot.
- **Tests:** the Workers smoke suite uploads an unsigned and an
  ed25519-signed asset to R2 on workerd, publishes, and reads both back
  through `/r` (bytes, `sha256`, `Content-Length`, `ETag` / 304); a wrong
  `sha256` (422 `DIGEST_MISMATCH`) and a signature over another digest
  (400 `INVALID_SIGNATURE`) are refused.

## 2026-10-10 01:16 [registry]

Milestone M2, part 2: multipart upload up to 500 MiB and the expired-upload
sweep.

- **Added:** `POST /api/registry/packages/:ns/:pkg/versions/:ver/uploads`,
  `PUT /api/registry/uploads/:uploadId/parts/:n`, `POST
  /api/registry/uploads/:uploadId/complete` and `DELETE
  /api/registry/uploads/:uploadId`. Start, complete and abort are audited
  (`registry.upload.started`, `registry.asset.uploaded` with `multipart:
  true`, `registry.upload.aborted`), each with `upload_id`; single parts are
  not.
- **Wire shape.** The start request is `{ asset, size, sha256, sig?, run?,
  exec? }` and answers `{ uploadId, partSize, partCount }`, camelCase as the
  plan writes them; everything else stays snake_case (a part answers
  `{ part_number, size }`, complete answers the asset).
- **Start.** Validation, the owner's limits and the signature are the
  single-request upload's own code (`requireDraft`, `admitUpload`), run before
  any byte is accepted. The `registry_uploads` row is the quota reservation.
  An upload of the same asset name still in flight is aborted first, so its
  reservation does not count against its replacement; that holds even when
  the new start is then refused.
- **Parts.** 64 MiB, a constant: nothing in a request changes it (tests swap
  it through `__setPartSizeForTests`, local store only, since R2 refuses
  non-final parts under 5 MiB). `Content-Length` is required (411) and must be
  the exact size of that part (422 `INVALID_PART_SIZE`); a number outside
  `1..partCount` is 422 `INVALID_PART_NUMBER`; a body the store did not take
  is 422 `PART_REJECTED`. Parts may arrive in any order and in parallel.
- **Complete.** Claims the asset name like an upload (409 `VERSION_BUSY`),
  refuses a version that is no longer a draft before assembling (409
  `VERSION_NOT_DRAFT`, upload discarded) and again inside the transaction,
  answers 409 `UPLOAD_INCOMPLETE` while a part is missing (the upload stays),
  then assembles and reads the object back through `sha256OfBlob`. A mismatch
  is 422 `DIGEST_MISMATCH`: object, upload row and any asset row of that name
  go. The asset row and the removal of the upload row are one transaction. A
  part list the store refuses is 409 `UPLOAD_UNUSABLE`.
- **Replacing by multipart.** The object is assembled at the asset's own key,
  so completing over an existing draft asset of that name replaces its bytes
  before they are verified; the claim keeps the version from being published
  meanwhile, and a failed verification removes that asset rather than leave a
  row describing other bytes.
- **Access by upload id.** `requireUploadAccess` resolves upload → version →
  package and runs the same check as `requirePackageAccess` (both now share
  one function). An upload is not public even when its package is: an unknown
  id and one in a package the caller has no write access to are the same 404;
  only a token of the package's side with too low a grant gets a 403.
- **Aborting in the store.** Deleting a draft version, deleting a package,
  restarting an upload and the sweep call `abortMultipart` for every upload
  whose row they remove; `deletePrefix` and the foreign-key cascade do not.
  The abort is best effort: a store that no longer knows an upload must not
  keep its row, and the quota it holds, alive. `deletePackageBlobs` now takes
  the database handle.
- **Sweep.** `runUploadSweepOnce` aborts uploads past `expires_at` (now +
  `REGISTRY_UPLOAD_TTL_SECONDS` at start) and removes their rows, skipping one
  that is being completed. `startRegistryUploadSweep` /
  `stopRegistryUploadSweep` schedule it as `registry-upload-sweep` on the
  platform scheduler every `REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS` (0
  disables), in the shape of the file module's GC.

## 2026-10-10 01:01 [registry]

Milestone M2, part 1: draft versions, the single-request upload, publish,
channel pointers, yank / restore and version deletion.

- **Added:** `GET` / `POST /api/registry/packages/:ns/:pkg/versions`,
  `GET` / `DELETE …/versions/:ver`, `PUT` / `DELETE
  …/versions/:ver/assets/:asset`, `POST …/versions/:ver/publish`, `PUT
  …/channels/:channel`, `POST …/versions/:ver/yank` and `…/restore`. Every
  handler goes through `requirePackageAccess`; every mutation is audited
  (`registry.version.*`, `registry.asset.*`, `registry.channel.updated`) with
  `owner_user_id` and, for a token request, `token_id`.
- **Read shape.** The list answers `{ versions, channels }` and a single
  version `{ version, channels }`; a channel is `{ name, version,
  updated_at }` with `version` the version string. Drafts and yanked versions
  are listed to everyone who may read the package.
- **Upload order.** Access, then parameters (422), then `Content-Length`
  (411 `LENGTH_REQUIRED`), the 95 MiB single-request cap (413
  `SINGLE_REQUEST_TOO_LARGE`, naming the multipart route), the owner's limits
  through `assertUploadAllowed`, the signature, and only then the body, which
  is handed to the blob store untouched. A middleware mounted ahead of the
  auth guard cancels a body nothing read, as workerd requires.
- **Status codes.** A signature that verifies under no active ed25519 key of
  the namespace owner is 400 `INVALID_SIGNATURE`; an unsigned upload into a
  `require_signature` package is 400 `SIGNATURE_REQUIRED`; a failed store put
  is 422 `DIGEST_MISMATCH` on both drivers. An empty `sig`, `run` or `exec`
  counts as absent, an empty body is a 422, and a replaced asset answers 200
  instead of 201.
- **Quota on replacement.** Re-uploading an asset name is checked against the
  quota at its full size, although the bytes it replaces are freed: delete the
  asset first when the quota is that tight.
- **In-flight claims.** While an upload streams, its asset — and for publish
  and delete, the whole version — is claimed in memory; a conflicting request
  answers 409 `VERSION_BUSY`. Without it a publish landing mid-upload would
  let the upload replace the bytes of a published asset. In memory is enough
  because one process owns the database (the Durable Object, or the Bun
  server).
- **Deleting.** A draft needs `write`. A published or yanked version needs a
  session of the owner or an administrator (a token is refused whatever its
  grant) and no channel pointing at it. Rows go first, then
  `deletePrefix("pkg/<package_id>/<version_id>/")`. `deletePackage` now takes
  the configuration and removes `pkg/<package_id>/`.
- **Boot check.** `registryRoutes()` resolves the blob store when
  `REGISTRY_BLOB_DRIVER` is not `local`, so `r2` without the `PACKAGES` binding
  fails the boot instead of the first upload.
- **Changed:** `REGISTRY_BLOB_LOCAL_ROOT` is anchored to `DATA_DIR` like
  `FILE_STORAGE_LOCAL_ROOT`. `packages:write` gained `DELETE
  …/versions/:ver/assets/:asset`.

## 2026-10-10 00:45 [registry]

Scope change confirmed by the project owner: namespaces are assigned by the
system, and a package is identified by a slug with a separate display name.
It supersedes the namespace claim and the namespace-slug narrowing described
in the entries below.

- **Namespace is assigned, never chosen.** `ensureNamespace(db, userId)`
  gives a user their one namespace the first time it is needed: 8 random
  characters, lowercase letters and digits, the first a letter, retried on
  a collision (after 8 failed attempts: `503 NAMESPACE_UNAVAILABLE`). It is
  called by `GET /api/registry/namespace` and by package creation, so a
  user's first `POST /api/registry/packages` works without any earlier
  call. Concurrent calls yield one row: the insert is a no-op on the
  owner's unique index. Audited once as `registry.namespace.assigned`
  (replaces `registry.namespace.claimed`).
- **Removed:** `POST /api/registry/namespace`, the reserved-slug list, the
  username suggestion and the namespace slug rule; with them the error codes
  `NAMESPACE_EXISTS`, `NAMESPACE_TAKEN` and `NAMESPACE_REQUIRED`.
- **Namespace view.** `GET /api/registry/namespace` answers
  `{ namespace: { slug, status, created_at } }`; `namespace` is never null
  and `suggested` is gone. The row's internal `id` left the wire shape, here
  and in the admin namespace list: `slug` is the namespace's id.
- **Package slug and display name.** `registry_packages.slug` — lowercase
  letters, digits and `-`, not starting with `-`, 1 to 128 characters, unique
  within its namespace — is the `:pkg` path segment and cannot change.
  `registry_packages.name` is now a free-text display name: trimmed, 1 to 100
  characters, no control characters, not unique, editable. `POST
  /api/registry/packages` takes `{ slug, name, … }`, both required; `PATCH`
  accepts `name` and refuses `slug` with 422; the package view carries both.
  `409 PACKAGE_EXISTS` is now about the slug.
- **Everything that names a package uses the slug:** `:ns/:pkg` lookups,
  token grants (`"<namespace>/<package slug>"`, `422 INVALID_GRANT`
  unchanged), the policy entity name, audit `resourceName`, and the ordering
  of package lists. `registry.package.created` records the display name in
  its detail.
- **Reads do not assign.** For a user without a namespace yet, the package
  list, quota usage and token list report empty, and they are absent from
  the admin lists; only `GET /registry/namespace` and package creation
  create the row.
- **Migration replaced, not stacked.** Nothing had been applied to a shared
  environment, so the registry migration was regenerated as
  `0002_curly_thunderbolt_ross` (adds `registry_packages.slug`, unique
  `(namespace_id, slug)` in place of `(namespace_id, name)`) and the Workers
  bundle with it. A local database created from the earlier `0002_even_kang`
  has to be recreated.

## 2026-10-10 02:30 [registry]

M1, part 2 — token grants, token scopes, quotas and the
platform-administration API of the `registry` module. No new migration.

- **Token grants.** `GET` / `POST /api/registry/tokens` and `PUT` / `DELETE
  /api/registry/tokens/:id` manage personal API tokens narrowed to packages.
  `grants` is `{ all: <level> }` or a list of `{ package: "<ns>/<pkg>",
  access }`, stored in `registry_token_grants`. A grant can only name a
  package the caller may manage; a package that does not exist and one that
  is not theirs both answer `422 INVALID_GRANT`. The list shows every
  personal token of the caller, the ones without grants included.
- **Scopes follow grants.** Three scopes are registered — `packages:read`,
  `packages:write`, `packages:admin` — and a token's scopes are derived from
  its grants whenever they are saved. The route table already lists the
  release routes of the next milestone. Creating and deleting packages,
  signing keys, token management, the namespace, the quota and
  `/registry/admin/*` are in no scope and stay session only.
- **Scopes are rewritten in place.** The template's tokens service can create
  and delete a token but not update one, so replacing grants writes the
  `scopes` column of the `api_tokens` row from the registry module, in the
  same transaction as the grants. Scopes outside `packages:*` are kept.
- **Grant check.** `requirePackageAccess` additionally requires, for a token
  request, a grant on that package at the level asked or above; `owner` is
  never open to a token. The "all my packages" grant covers the packages in
  the token owner's namespace, future ones included. A request with an
  `Authorization: Bearer pat_…` header is treated as a token request by the
  registry even when it also carries a session cookie.
- **Private packages answer 404.** A private package the caller cannot read
  answers like a missing one on every method, for sessions and tokens, so
  names cannot be found by probing. A public package of another user is
  readable (metadata) by any signed-in user and answers 403 on writes. A
  token with no grant on a public package gets 403.
- **Suspended namespaces.** The owner's session can still read; every
  mutating package route and package creation answer `403
  NAMESPACE_SUSPENDED`. The owner's tokens are refused on every registry
  route. Administrators are not restricted.
- **Quotas.** `GET /api/registry/quota` returns `{ limits, usage }`. Usage
  counts stored asset sizes plus the declared sizes of uploads in flight.
  `assertUploadAllowed(db, userId, size, config)` answers `413
  ASSET_TOO_LARGE` or `409 STORAGE_QUOTA_EXCEEDED`. The max-packages check
  and the insert now run in one transaction.
- **Administration.** Under `/api/registry/admin`, `admin` role and session
  only: list namespaces and packages with owner and storage usage, suspend
  and restore a namespace, read and replace a user's quota override, list
  and revoke any user's token (`?user_id=` filters). There are no admin
  package routes: an administrator passes every package check on the
  ordinary `/registry/packages/:ns/:pkg` routes.
- **Audit.** Every mutation is audited. A token request records `token_id`
  in the entry's detail; admin actions record `owner_user_id`.

## 2026-10-10 00:33 [registry]

Namespace slugs narrowed to lowercase letters, digits and `-` (decision of
the project owner).

- **Before:** a slug followed lode's id rule, so `Acme`, `acme_tools` and
  `acme.tools` could be claimed.
- **Now:** `[a-z0-9-]` only, still no leading `-`, still unique and one per
  user; reserved slugs are refused as before. A username outside the rule is
  no longer suggested as a slug. Package names, versions and asset names
  keep lode's wider rule.
- No migration: the case-insensitive unique index stays and is now simply
  never exercised by mixed-case slugs.

## 2026-10-10 00:30 [registry]

`BlobStore` for registry assets (`apps/api/src/modules/registry/blob/`): a
local-filesystem driver for Bun and an R2 driver for Workers, both streaming,
with multipart. A pure library: no routes, no database access.

- **Typed failures.** A failed `put` / `putPart` rejects with `BlobPutError`
  and stores nothing. `BlobDigestMismatchError` is a subclass, thrown only
  when the driver established the mismatch itself: always on the local driver
  (it hashes and counts while writing), and on R2 only for a length it
  counted. R2 does not report why it rejected a `put` in a form that can be
  relied on, so a wrong digest on R2 is a plain `BlobPutError`. Callers treat
  both as "nothing stored".
- **R2 uploads use the plain path first.** A stream R2 refuses for having no
  known length (a `TypeError` raised before any byte is read, leaving the
  stream unlocked) is sent again through `FixedLengthStream(size)`. Checked
  against local workerd with the real driver: plain and chunked bodies, wrong
  digest, short and long bodies, a three-part multipart upload with one part
  replaced, abort, `deletePrefix` and the completion digest.
- **`sha256OfBlob(store, key)`** streams the object through
  `crypto.DigestStream` on workerd and through an incremental hash on Bun. It
  resolves to `undefined` for a missing object, so a comparison with the
  declared digest fails closed.
- **Keys are validated by both drivers** (relative, `/`-separated, no empty,
  `.` or `..` segment, no backslash or NUL), so the local driver cannot be
  walked out of its root and a key valid on one driver is valid on the other.
  `deletePrefix` takes a string prefix and refuses the empty one.
- **Local multipart** keeps one file per part, named by part number and the
  part's SHA-256, which is its etag. Uploading a part number again replaces
  the earlier part and invalidates its etag. Completion requires ascending
  part numbers and rejects with `BlobMultipartError` otherwise.
- **`abortMultipart` of an unknown upload** is a no-op on both drivers.
- **Selection:** `getActiveBlobStore(config)` reads `REGISTRY_BLOB_DRIVER` and
  `REGISTRY_BLOB_LOCAL_ROOT` through a structural type. The Workers entry
  registers the `PACKAGES` bucket as `r2` when it is bound; selecting `r2`
  without it throws.

## 2026-10-10 00:20 [registry]

M1, part 1 — the `registry` API module: data model, namespaces, signing
keys and package CRUD. See
[the plan](plan/20261009-2241-lode-registry-server.md).

- **Schema.** One migration, `apps/api/drizzle/0002_even_kang.sql`, creates
  all nine `registry_*` tables, including the ones later milestones fill
  (`registry_versions`, `registry_assets`, `registry_channels`,
  `registry_uploads`, `registry_token_grants`, `registry_quotas`).
  Additions to the plan's column list: `registry_assets.alg`, `key_id` and
  `alg` on `registry_uploads` (so a finished upload can write its asset row),
  `created_at` / `updated_at` where a row has a lifetime, and a partial
  unique index that keeps the "all my packages" token grant single per token
  (SQLite treats NULLs as distinct under UNIQUE).
- **Foreign keys.** Deleting a package cascades to its versions, assets,
  channels, uploads and token grants; deleting an API token cascades to its
  grants. Nothing cascades from `users` or from a namespace: a namespace with
  packages has to be emptied deliberately. `registry_channels.version_id`
  does not cascade either, so a version a channel points at cannot be
  deleted from under it.
- **Namespace slugs** are unique ignoring letter case (`Acme` cannot be
  claimed next to `acme`) and one per user, both enforced by unique indexes.
  Reserved slugs are refused in any letter case. URLs still spell a slug
  exactly.
- **Validation** mirrors lode's `idval.rs` and `validate_command_override`,
  with one addition lode does not have: ids are capped at 128 characters,
  because an asset name becomes a file name in the local blob store.
- **Signing keys** are ed25519 only. The server derives `key_id` and stores
  the key as unpadded base64url. Revoking is final: the row stays and the
  same key cannot be registered again by that user.
- **Authorization.** The module registers the `package` policy namespace
  (`owner` > `maintainer` > `reader`) and binds
  `/registry/packages/:ns/:pkg` through `defineResource`, so the global
  policy middleware enforces it. Only the owner tuple is written. Changing
  package settings and deleting need `owner` until maintainers exist.
  A package the caller has no right to answers 403 whether it is public or
  private; an unknown one answers 404.
- **Session only.** The module registers no token scope, so a personal API
  token gets 403 on every registry route.
- **Backup.** The `registry` contribution covers eight of the nine tables.
  `registry_token_grants` is left out: `api_tokens` is in no backup and
  restoring `users` cascades the tokens away, so a restored grant would fail
  the foreign key check and abort the whole import. Asset bytes are not part
  of a database backup.
- **Wire format.** Request and response fields use the plan's column names
  (`key_id`, `public_key`, `require_signature`, `revoked_at`).
- **Config.** Eight `REGISTRY_*` variables are declared; only
  `REGISTRY_MAX_PACKAGES_PER_USER` is read so far. `REGISTRY_BLOB_LOCAL_ROOT`
  is not yet anchored to `DATA_DIR` the way `FILE_STORAGE_LOCAL_ROOT` is —
  that happens in `apps/api/src/config.ts` and is left to the blob store.

## 2026-10-10 00:20 [decision]

Zero-binding policy boot guard restored to a throw.

- **Before:** since the 2026-10-09 23:37 decision below, `apps/api/src/app.ts`
  only logged a warning when no module had registered a policy route
  binding.
- **Now:** the `registry` module registers bindings for
  `/registry/packages/:ns/:pkg`, so the guard fails closed again:
  `buildFullApp` throws when the binding registry is empty.
  `apps/api/src/app.test.ts` asserts both that the app boots with the
  registry bindings and that it refuses to build without any.

## 2026-10-10 00:17 [registry]

M2 workerd spike: both storage assumptions of
[the plan](plan/20261009-2241-lode-registry-server.md) hold on local workerd
(wrangler 4.132.0, workerd 1.20260915.1). Method, tables and caveats are in
`apps/api/src/modules/registry/spike/README.md`.

- **Streamed body into R2 through the Durable Object — works as planned.**
  `Content-Length` is preserved across `stub.fetch`, and
  `bucket.put(key, request.body, { sha256 })` streamed 1, 50 and 95 MiB
  bodies without buffering (95 MiB in about 0.67 s). R2 rejects a wrong
  `sha256` and stores nothing. A chunked body without `Content-Length` is
  refused by R2 with a `TypeError`; piping it through
  `FixedLengthStream(size)` is the smallest working variant, but the upload
  routes require `Content-Length`, so the plain path is used.
- **SHA-256 over a 500 MiB multipart object in the Durable Object — works as
  planned.** About 3.5 s wall and at most 4.2 s of process CPU, R2 simulation
  included (hashing alone: 0.25 s), against the 30 s default CPU limit. The
  completed multipart object carries no checksum of its own. No fallback is
  adopted; digesting in the stateless Worker measured the same and is the one
  to use if production disagrees.
- **Open until M5:** local workerd enforces no CPU, memory or body-size
  limits, and it served no other request while the digest ran (a
  single-thread artifact that also appears with the digest in the stateless
  Worker). The deployed smoke should confirm the 500 MiB completion and
  measure request latency during it.

## 2026-10-10 00:12 [registry]

Signature library for the registry module
(`apps/api/src/modules/registry/signature.ts`).

- **What it does:** rebuilds lode's `lode.artifact.v1` message, decodes and
  encodes lode's base64 forms, derives a `key_id`, and verifies an ed25519
  artifact signature. WebCrypto only, no dependency, so it runs unchanged on
  Bun and on Workers.
- **Compatibility proof:** the tests verify signatures produced by the real
  `lode-cli sign` 0.3.3. The vectors, the image digest and the exact commands
  are in `apps/api/src/modules/registry/testdata/`. The signing keys were
  throwaway and never left the generating container; only public keys are
  committed.
- **Message fields are bound verbatim.** `name` is the asset filename, not the
  package name. `sha256` is not normalised: lode signs lowercase hex, so an
  uppercase digest does not verify. An absent `run` / `exec` is an empty
  field, indistinguishable from an empty string.
- **Base64 decoding is as strict as lode's:** either alphabet, optional
  padding, surrounding whitespace ignored; interior whitespace, interior
  padding and stray trailing bits are rejected. `decodeBase64Flexible`
  returns `null` for such input instead of throwing.
- **`keyIdOf` is asynchronous** because WebCrypto's digest is.
- **`verifyArtifactSignature` takes a bare base64 public key**, not a lode
  trusted-key entry (`<key_id>:<base64>`), and resolves to `false` for any
  malformed key or signature.

## 2026-10-09 23:37 [decision]

Zero-binding policy boot guard downgraded from a throw to a warning.

- **Before:** `apps/api/src/app.ts` threw at boot when no module had
  registered a policy route binding. `document` and `issue` were the only
  modules registering bindings, so removing them made the app unbootable on
  both Bun and Workers.
- **Decision** (approved by the project owner): for the zero-binding case the
  throw became a logged warning. The change is limited to that single
  statement and is covered by `apps/api/src/app.test.ts`.
- **Why it is safe now:** no remaining route has an object-level binding, and
  every protected route keeps its own `authRequired` / `adminRequired` gate.
- **Residual risk:** once a module registers bindings again, a wiring bug
  that leaves the registry empty would boot with a warning instead of
  aborting.
- **Follow-up:** the registry module (M1) is expected to restore the
  fail-closed behaviour when it registers its first binding, or consciously
  retire the guard. `app.test.ts` asserts zero bindings first and will fail
  loudly at that point, which is the reminder.

## 2026-10-09 23:36 [foundation]

M0 — the foundation for the registry described in
[the plan](plan/20261009-2241-lode-registry-server.md). No registry feature
exists yet.

- **Fork.** Forked from the bun-tpl template at upstream commit `c6f5c58`
  (`ci: pin runners to ubuntu-26.04`), imported with history; the upstream
  is tracked as the `template` remote.
- **Rebrand.** The app is `lode-server` / "Lode Server"; the workspace
  package scope stays `@app`. The rebrand helper does not rewrite
  `deploy/lode.toml` or `docker-compose.yml`, so those were edited by hand.
  `examples/compose` and `tests/e2e` keep the demo OAuth client `app` /
  `app-secret` to match their dex configs, while `scripts/dev-dex.ts` now
  defaults to `lode-server` / `lode-server-secret`.
- **Modules.** `document` and `issue` were removed (API, web screens,
  locales, docs, tests); `item` and `file` stay. Migration
  `apps/api/drizzle/0001_marvelous_frightful_four.sql` drops
  `document_details` and `issue_details` and nothing else.
- **Workers.** The Worker is named `lode-server`, with R2 buckets
  `lode-server-files` (binding `FILES`) and `lode-server-packages` (binding
  `PACKAGES`). The `/r/*` prefix is reserved for the registry read feed and
  routed to the Worker first; no route is mounted on it and nothing reads
  `PACKAGES` yet.
- **Workers smoke coverage.** The suite now has 6 cases (health,
  single-user login, resource-group delete transaction, colliding tuple
  rewrite rollback, raw API headers, creation rate limit) plus the OIDC
  suite. The R2 upload/download round trip and the stale-version 409 went
  away with the document routes and are to be restored by the registry
  module.
- **E2E.** The tokens test was rewritten on the `account:read` scope and the
  file test reduced to its refusal paths. The e2e suite was not run in M0.
- **Known follow-up.** The deploy job in `.github/workflows/workers.yml`
  still assumes a single `bucket_name` in `wrangler.toml`; it is left to the
  deployment workstream.

## Unreleased

### Added

- Password accounts next to OIDC (`LOCAL_LOGIN=true`). Admins add users in the
  admin UI or at `POST /api/account/users` and reset passwords at
  `/api/account/users/:id/password`; those users sign in with a username and
  password while OIDC keeps working, and the login page offers both. Two-step
  verification, per-username lockout and identical failure answers apply.
  `SINGLE_USER_*` under `LOCAL_LOGIN` names a bootstrap admin created at
  every boot. An OIDC login can no longer take over a password account by
  username — only a verified email links them — and a username or email held
  by another account now answers with an account-conflict message instead of
  a 500. **Schema:** `users.password_hash`, added to the regenerated
  `0000_init` migration; a deployed database needs
  `ALTER TABLE users ADD password_hash text`.
  The bootstrap admin never adopts an account that signs in through the IdP
  (matched by self-chosen username or email); it logs an error instead.

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

- `BASE_PATH` did not work on Cloudflare Workers. The SPA's HTML referenced
  `/u/assets/…` while the asset pipeline served files from the build root, so
  every asset 404'd into the SPA fallback, and `run_worker_first` only listed
  `/api/*`. The Worker now serves the SPA's paths itself under a prefix
  (strip the prefix, ask the asset binding), forwards `${BASE_PATH}/api/*` to
  the app, and answers `/` as the Bun server does (a redirect, or the SPA with
  `HOME_PAGE=root`). The deploy workflow takes `BASE_PATH` and `HOME_PAGE`
  repository variables and applies them to the build, `wrangler.toml` and
  `vars`; the workerd smoke gained a base-path mode that CI runs both ways.
- With a `BASE_PATH` set, the Vite dev server redirected `/` to the base, so a
  home page at the origin root (`HOME_PAGE=root`) could not be seen in
  development. A dev-only plugin now serves the shell at `/` in that mode.

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
