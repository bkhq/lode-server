# API e2e suite (live API + dex IdP, encrypted DB)

Drives the live API process against a real OIDC provider (dex) over a real
encrypted database. The test data dir lives under `tests/e2e/.cache/data/`
(per-run subdir) so it never collides with the local dev DB at
`<repo>/data/db/app.db`.

## Run

```bash
bun run test:e2e
```

The orchestrator prints a phase-by-phase summary at the end. Its shape (the
counts and times below are placeholders, not a recorded run):

```
e2e summary
  phase                                 tests   pass   fail   skip     time
  phase-a-encryption-init                   N      N      0      0    0.00s
  phase-b-modules                           N      N      0      N    0.00s
  phase-c-encryption-rate-limit             N      N      0      0    0.00s
  phase-c-encryption-unlock                 N      N      0      0    0.00s
  TOTAL                                     N      N      0      N    0.00s
```

Phase B is by far the longest: the registry suites move a 65 MiB and a
96 MiB asset through the multipart path. Its `skip` column counts the
registry cases that need the real lode client when no binary is available
(see [Registry suites](#registry-suites)).

## Reports

Each run writes JUnit XML and a JSON summary into
`tests/e2e/.cache/reports/<run-ts>/`:

```
tests/e2e/.cache/reports/<run-ts>/
  phase-a-encryption-init.xml
  phase-b-modules.xml
  phase-c-encryption-rate-limit.xml
  phase-c-encryption-unlock.xml
  summary.json
```

A `tests/e2e/.cache/reports/latest` symlink always points to the most
recent run, so CI can attach `tests/e2e/.cache/reports/latest/*.xml` as
test artefacts unconditionally. The orchestrator keeps the 10 most
recent runs and trims older ones.

Sequential phases share one data dir:

| Phase | Test target | What it covers |
|---|---|---|
| **A. encryption init** | `modules/encryption/init.test.ts` | API boots fresh + encrypted; status `uninitialized`; the wizard derives a master keypair from a password and POSTs `/encryption/init`; the system flips inline to `unlocked`. |
| **B. module suites** | every `modules/<name>/*.test.ts` (excluding init/unlock) | Real-user simulation against the now-unlocked, OIDC-wired API: OAuth login, profile, users / groups CRUD, TOTP enrol + step-up, policy tuples + check + resource-groups, settings, audit, backup export with DEK proof, encryption admin (challenge / meta / change-master), files, the raw API, and the registry (see [Registry suites](#registry-suites)). |
| **C. encryption rate limit** | `modules/encryption/rate-limit.test.ts` | API restart with the same DB → `locked`, with a fresh in-memory limiter: the unlock-challenge rate limit trips. |
| **C. encryption unlock** | `modules/encryption/unlock.test.ts` | API restart with the same DB → `locked`; the wizard fetches the unlock-challenge bundle, re-derives the master key, decrypts the wrapped DEK, re-encrypts under the server's ephemeral pubkey, POSTs `/encryption/unlock` → `unlocked` again. |

dex itself is fetched on first run (binary extracted from the official
`ghcr.io/dexidp/dex` OCI image — no docker daemon required, just curl +
python3 + tar) into `tests/e2e/.cache/dex` and reused.

## Registry suites

`modules/registry/` covers the registry module against the live API with the
`local` blob driver; what each file asserts is listed in
[`docs/modules/registry.md`](../../docs/modules/registry.md#end-to-end-coverage).

| File | Covers |
|---|---|
| `namespace.test.ts`, `keys.test.ts`, `packages.test.ts`, `tokens.test.ts` | Namespace assignment, signing keys, package CRUD and the cross-user matrix, token grants. |
| `versions.test.ts`, `uploads.test.ts` | Draft → upload → publish, signatures, channels, yank / restore; one real multipart upload (64 MiB + 1 MiB in two parts). |
| `admin.test.ts`, `audit.test.ts` | Administration routes, quota overrides, namespace suspension; audit entries. |
| `feed.test.ts` | The `/r` read feed: manifest, cache headers, the identical 404, private packages. |
| `lode.test.ts` | The real `lode` / `lode-cli` 0.3.3 binaries against the live feed: signed under `enforce`, unsigned under `off`, rollback refusal, private package. |
| `publish.test.ts` | Runs `scripts/publish.sh` as a subprocess, the way a publisher's CI does: draft → upload → publish, re-run into an existing draft, refusals. It moves one asset of about 96 MiB through the multipart path, and signs with `lode-cli` in one case. |
| `helpers.ts` | Shared request helpers; not a suite. |

**The lode binary.** `lode.test.ts` and the signing case of
`publish.test.ts` need the real client. It is static and runs directly on
the test host. It is looked for in this order:

1. `E2E_LODE_BIN` — path to a `lode` binary;
2. `tests/e2e/.cache/lode-v0.0.1/lode` — left by an earlier run;
3. extraction from the local image `bkhq/lode:v0.0.1` into that cache path.
   Pull it once with `docker pull docker.io/bkhq/lode:v0.0.1`; the container
   is created, never started, and removed.

With none of them the real-client cases are **skipped with a message**
(`[registry/lode] SKIPPED: no lode binary…`); they do not fail. CI pulls the
image before the run.

**Environment.** `run.ts` sets two entries for the registry on the API it
spawns:

| Variable | Value | Why |
|---|---|---|
| `REGISTRY_BLOB_LOCAL_ROOT` | `<per-run data dir>/packages` | Assets are removed with the run instead of piling up under `<repo>/data`. |
| `MAX_UPLOAD_BYTES` | 100 MiB | The Bun server caps a request body at this value; the 10 MiB default would refuse a 64 MiB part. |

## Layout

```
tests/e2e/
  run.ts                       # phase orchestrator (entry point)
  scripts/install-dex.sh       # ghcr-pull-then-source-build dex installer
  dex/config.yaml              # static client + 2 static users
  lib/
    api.ts                     # cookie-jar HTTP client (multipart-aware)
    oidc.ts                    # OIDC login walker + per-email session cache
  modules/
    system/
      health.test.ts
      security.test.ts         # CSRF / Origin guards
    account/
      auth.test.ts             # OIDC login + me + logout
      me.test.ts               # /me / users / preferences / status update
      groups.test.ts           # CRUD + members
      totp.test.ts             # enrol + confirm + step-up + delete
      tokens.test.ts           # personal API tokens
      single-user.test.ts      # single-user login (own API instance)
    policy/
      tuples.test.ts           # tuple CRUD + check
      resource-groups.test.ts  # rg CRUD + check chain (editor implies viewer)
    settings/
      settings.test.ts         # admin K/V + 403 matrix
    audit/
      audit.test.ts            # event listing + 403 matrix
    backup/
      export.test.ts           # admin export with DEK proof
      restore.test.ts          # export → restore round trip (own API instance)
    cron/
      cron.test.ts             # actions catalog + read paths
                               # (write paths describe.skip — see Known issues
                               # in docs/develop/operations.md)
    file/
      files.test.ts            # generic download path, refusals
    raw/
      raw.test.ts              # the raw API surface
    registry/                  # see "Registry suites"
      helpers.ts               # shared request helpers
      namespace.test.ts
      keys.test.ts
      packages.test.ts
      tokens.test.ts           # grants: read / write / admin
      versions.test.ts         # draft, single-request upload, publish, channels
      uploads.test.ts          # multipart
      admin.test.ts
      feed.test.ts             # /r manifest + asset
      audit.test.ts
      lode.test.ts             # real lode client
      publish.test.ts          # scripts/publish.sh
    encryption/
      init.test.ts             # phase A
      rate-limit.test.ts       # phase C (locked, fresh limiter)
      unlock.test.ts           # phase C
      admin.test.ts            # /meta + /challenge + change-master (phase B)
  .cache/                      # dex + lode binaries, per-run data dirs, reports (gitignored)
```

## Static users (dex)

Both have password `admin`:

| Email | Role in API |
|---|---|
| `admin@example.com` | admin (matches `DEFAULT_ADMIN`) |
| `user@example.com` | regular user |

## Adding a new test

1. Drop `<area>.test.ts` under the matching `modules/<module>/` folder.
2. Use `getClient(email)` from `../../lib/oidc` to grab a cached, logged-in
   `ApiClient`. The cache self-heals (probes `/me`, re-logs in on 401).
3. The orchestrator wires `E2E_API_BASE`, `E2E_DEX_BASE`,
   `E2E_BOOTSTRAP_TOKEN`, and `E2E_PASSWORD` into the test process —
   `lib/api.ts` reads `E2E_API_BASE` so tests work whether the API is on
   the default `:3010` or somewhere else.
4. A new `modules/<module>/` folder is picked up by the orchestrator
   automatically (phase B runs every module folder except `encryption`).

## Known gaps

- `rotate-dek` is currently `it.skip` in `encryption/admin.test.ts` — the
  WAL/lock contention between the live writer and the libsql copy client
  triggers `SQLITE_IOERR: disk I/O error` mid-rotation. Tracked
  separately; the rest of the encryption admin surface is covered.
