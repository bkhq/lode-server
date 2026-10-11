# Cron Module

In-process job scheduler. Operators register cron expressions against
named actions; the scheduler persists job definitions, drives them on a
[`cronbake`](https://www.npmjs.com/package/cronbake) timer, and records
every run in `cron_job_logs` for audit / debugging. Built-in actions
ship out of the box; downstream consumers register more by calling
`registerAction(...)` at module load time.

## Enabling

The module ships **with the scheduler off**. Flip `CRON_ENABLED=true`
in the API environment (see `.env.example`) and restart to start
firing ticks.

| `CRON_ENABLED` | What happens |
|---|---|
| `false` (default) | `app.ts` calls `initCronActions()` (populates the in-memory action catalog + the create-time validator) and **skips** `startCron` entirely. Baker is never allocated, no DB rows are seeded, and `getScheduler()` returns `null`. Route handlers use the null-safe paths — writes still land, Baker side effects no-op. |
| `true` | `app.ts` calls `initCronActions()` then `startCron`, which allocates Baker, seeds the default `log-cleanup` row (idempotent), loads every `enabled && !is_deleted` row, and starts the timer. Rows created while the flag was off begin running immediately. |

**Runtime requirement.** Baker holds a timer per job and needs the app to
stay resident between firings, so `CRON_ENABLED=true` is refused at boot on a
runtime that is evicted when idle — Cloudflare Workers, where the app lives
in a Durable Object. The check reads the `residentTimers` platform capability
(`assertCronSchedulerSupported`). Everything below still works there; drive
the schedule from an external trigger calling
`POST /api/cron/jobs/:id/trigger`. See
[`develop/runtime.md`](../develop/runtime.md).

What stays on either way:

- All `/api/cron/*` routes are mounted and admin-gated. Admins can
  list, create, edit, delete, view-logs, pause / resume, and manually
  trigger jobs in either state. Writes land in the DB; manual triggers
  call the handler directly (the scheduler is irrelevant to one-shot
  execution).
- `GET /api/cron/actions` always returns the action catalog plus a
  `schedulerEnabled` flag. The SPA reads it and renders an amber
  "scheduler is off" banner above the job table without blocking any
  operation.
- The schema, the migration, and the backup contribution ship
  unconditionally — flipping the gate later is a pure runtime change,
  no migration required.

Why off by default: the `shell` action runs arbitrary commands with the
API process's UID/GID (see [§ Built-in actions](#actions)). A fresh
deploy that auto-mounted cron would expose that surface before the team
had a chance to audit the action catalog or pin a retention story for
the run-history table. Keeping the gate explicit forces operators to
read this doc before they hand admins the ability to schedule
`sh -c "$cmd"` every minute.

## File layout

```text
apps/api/src/modules/cron/
  schema.ts              # cron_jobs, cron_job_logs
  cron-format.ts         # cron-expression validation + normalisation
  executor.ts            # runs one task, persists the cron_job_logs row, auto-pauses on consecutive failures
  serialize.ts           # row + Baker state + last log → admin DTO
  cron.service.ts        # module-level scheduler singleton (startCron / stopCron / getScheduler)
  cron.routes.ts         # admin-only HTTP surface, mounted under protectedRoutes
  cron.backup.ts         # BackupContribution registered from index.ts
  index.ts               # re-exports + backup self-registration
  actions/
    types.ts             # ActionSpec / ActionExecutor / ActionDef / ActionInput / ActionContext
    registry.ts          # defineAction + registry + catalog + validateActionConfig
    index.ts             # initActions() registers the shipped actions below
    log-cleanup/         # ┐
      spec.ts            # │  definition layer (metadata + inputs + validate)
      executor.ts        # │  execution layer (the handler function)
      index.ts           # ┘  defineAction({ spec, execute }) default export
    http-request/        # one HTTP call with status assertion (same 3-file split)
    shell/               # run `sh -c` and capture exit + stdout
    soft-delete-cleanup/ # hard-delete soft-deleted cron rows
```

## Lifecycle

`cron` is an **infrastructure module** with global side effects, so it
hooks the same start / stop seams as `audit` retention and `file` GC.

| Phase | Hook | Effect |
|---|---|---|
| Boot (DB unlocked) | `app.ts buildFullApp` → `initCronActions(); if (config.CRON_ENABLED) await startCron(...)` | `initCronActions()` populates the in-memory action catalog + create-time validator (idempotent). `startCron` is only invoked when the gate is on; it auto-seeds default-cron rows, loads every `enabled && !is_deleted` row into Baker, and bakes the timer. |
| Live | `cron.routes.ts` → `getScheduler()` | Routes are mounted unconditionally and use the nullable handle. When the scheduler is running, admin mutations call `scheduler.syncJob(name)` so Baker reflects the new row without a restart. When the scheduler is off (gate disabled or `startCron` not yet run), the same mutations write to the DB and the Baker side effects are skipped. |
| Shutdown | `index.ts shutdown` → `await stopCron()` | Stops + destroys every Baker timer; clears the singleton. Idempotent — a no-op when `startCron` was never called (i.e. `CRON_ENABLED=false`). |

Two invariants the singleton enforces:

- `getScheduler()` returns `null` when `startCron` has not been called
  with `schedulerEnabled=true` (or has not run yet). Route handlers
  null-check the handle so the data-layer paths keep working with the
  scheduler off.
- `startCron` is idempotent so the test orchestrator (and hot-reload
  flows) can re-enter without duplicating default rows or stacking
  Baker handles.

## Database

| Table | Purpose |
|---|---|
| `cron_jobs` | Job definitions. `id` = 8-char nanoid, unique `name`, `task_config` is JSON text, soft-delete via `is_deleted` so logs remain joinable, `enabled` toggles ticking. |
| `cron_job_logs` | One row per run. `id` is a ULID so monotonic order = run order; `(job_id, started_at)` index serves "latest run per job" without a sort step; cascade-deletes when the parent job is hard-deleted. |

Indexes:

- `idx_cron_jobs_name` (unique) — the constraint behind the
  `JOB_NAME_CONFLICT` error.
- `idx_cron_jobs_enabled` — filters the boot-time "load every enabled
  job" scan.
- `idx_cron_job_logs_job` and `idx_cron_job_logs_job_started` — back
  the `serializeJob` "latest log" lookup and the `/cron/jobs/:id/logs`
  cursor.
- `idx_cron_job_logs_status` — supports the `?status=failed` filter on
  the logs endpoint.

## Actions

An **action** is a typed function registered by name. Job rows carry
an action reference in `task_config.action`; the executor resolves it
via the registry at run time. The catalog is populated by
`initCronActions()` (always) and surfaced via `GET /api/cron/actions`
so both the admin UI and external SPAs render the same options.

Every action splits in two physical layers:

- **`ActionSpec`** — declarative metadata + input schema + optional
  cross-field validator. Read by the catalog endpoint, the create-time
  validator, and the SPA's dynamic form.
- **`ActionExecutor`** — the function that does the work:
  `(ctx, config) => Promise<string>`. Read by the cron task runner.

A registered `ActionDef` is the frozen pair `{ spec, execute }`,
constructed with `defineAction({ spec, execute })` and added to the
in-process registry with `registerAction(def)`.

> **Authoring a new action?** See [`cron-actions.md`](../develop/module/cron-actions.md)
> for the full guide: file layout, field reference, validation
> lifecycle, worked example, testing patterns, and a pre-PR checklist.

## Retry policy

A misconfigured handler that throws every tick would otherwise burn CPU,
DB writes, and downstream rate limits on a one-minute schedule until
someone notices. The executor protects against that with a per-job
**consecutive-failure auto-pause**:

| Field | Default | Range | Meaning |
|---|---|---|---|
| `cron_jobs.max_consecutive_failures` | `3` | `0..100` | After N consecutive `cron_job_logs.status='failed'` rows, the executor flips `cron_jobs.enabled` to `false` and calls `baker.pause(name)` so the timer stops emitting ticks. `0` opts out of auto-pause entirely — only for jobs that *must* keep retrying through a downstream incident (heartbeat probes, watchdog pings). |

Mechanics:

- The check runs at the end of every failed `executeTask`. The executor
  reads the most recent N log rows (ordered by `cron_job_logs.id` DESC,
  which is ULID monotonic) and pauses iff all N are `status='failed'`.
- A single `status='success'` row in the window resets the streak — no
  separate counter is persisted; the log table itself is the source of
  truth.
- Auto-pause only sets `enabled=false`; the job row stays alive
  (`is_deleted` untouched), so admins can review the failure history
  and `POST /api/cron/jobs/:id/resume` once the upstream is fixed.
- Manual triggers (`POST /api/cron/jobs/:id/trigger`) go through the
  same executor path and respect the same threshold.

How to override:

- Create-time: `POST /api/cron/jobs` accepts `maxConsecutiveFailures`
  (integer, `0..100`) alongside `name / cron / action / config`. The
  admin UI surfaces it as the "Retry policy → Max consecutive failures"
  input in the create dialog, defaulted to 3.
- The list table shows a red **`no auto-pause`** badge next to the
  status column whenever a job has `maxConsecutiveFailures: 0`, so the
  override is visible during triage.

Picking a value:

- **3 (default)** — balances "tolerate one transient blip" against
  "stop wedging the API on persistent failure". Good for most jobs.
- **1** — strict mode for expensive jobs (data exports, irreversible
  mutations) where each failed run is a non-trivial cost.
- **5–10** — for noisy upstreams that fail in bursts of two or three
  ticks before recovering on their own.
- **0** — heartbeats / liveness pings that must keep retrying. Pair
  with rate-limited monitoring elsewhere so the failure stream is still
  visible to humans.

Built-in actions:

| Name | Auto-mounted | Required config | What it does |
|---|---|---|---|
| `log-cleanup` | yes (`0 0 3 * * *`) | — | Trims `cron_job_logs` to 1000 rows per active job; purges every log row of soft-deleted jobs. |
| `http-request` | no | `url` | Issues one HTTP request against `config.url`. Optional `method` (default `GET`, any of `GET / POST / PUT / PATCH / DELETE / HEAD`), `headers` (string→string), `body` (request body for non-GET/HEAD), `timeoutMs` (default 10 000, bounded to 100..60 000), `expectStatus` (single int 100..599; default accepts any 2xx). On a status mismatch or transport failure the action throws — `cron_job_logs.error` records the URL, the observed status, and the first 2 KB of the response body. |
| `shell` | no | `command` | Runs `sh -c "$config.command"`. Optional `timeoutMs` (default 30 000, bounded to 100..300 000) and `cwd`. Captures up to 4 KB of stdout + 4 KB of stderr per run. Exit `0` resolves to `exit 0 (<ms>) stdout: …`; any other exit code (or timeout → SIGKILL 137) throws so the row lands as `status=failed`. **Security:** the command runs with the API process's full UID/GID and filesystem permissions — there is no sandbox. Registration is admin-gated; treat the action catalog like a host root crontab. |
| `soft-delete-cleanup` | **no — opt-in** | — | Hard-deletes `cron_jobs` rows where `is_deleted=true` and lets the `ON DELETE CASCADE` foreign key drop their `cron_job_logs` history in the same statement. Optional `olderThanDays` (0..3650, default 0) sets a grace window — only rows whose `updated_at` is older than the cutoff are purged. Deliberately ships without a `defaultCron`: operators decide whether they want a janitor pass and at what retention (typical: weekly with `olderThanDays: 30`). Leaving it unscheduled is the safe default; the soft-delete marker keeps tombstoned jobs visible via `?deleted=only` for forensics / restore-by-re-create. |

`http-request` is the standard external-service-keepalive primitive (Prometheus pings, webhook fan-out, health probes). `shell` is the escape hatch for one-off operational chores (rotate a key, run `vacuum`, kick a sidecar) — prefer a typed custom action when the same command lands more than twice. `soft-delete-cleanup` is the janitor for the cron module's own retention; the broader audit retention sweep is owned by [`modules/audit.md`](audit.md) and runs on a separate timer.

## Routes

All routes are admin-only, mounted under `protectedRoutes`. See
[`reference/api.md` § Cron jobs](../reference/api.md#cron-jobs) for the full table.

| Method | Path | Description |
|---|---|---|
| GET | `/api/cron/actions` | Catalog: registered actions + supported cron formats. |
| GET | `/api/cron/jobs` | Cursor-paginated job list. `?deleted=true|false|only` toggles soft-deleted visibility. |
| POST | `/api/cron/jobs` | Create. Body: `{ name, cron, action, config? }`. |
| DELETE | `/api/cron/jobs/:id` | Soft-delete. `:id` accepts either the nanoid or the `name`. |
| GET | `/api/cron/jobs/:id/logs` | Cursor-paginated run history. `?status=running|success|failed` filters. |
| POST | `/api/cron/jobs/:id/trigger` | Manual run. Returns the freshly-written log row. Rejects when the job is already running. |
| POST | `/api/cron/jobs/:id/pause` | `enabled=false` + `baker.pause(...)`. |
| POST | `/api/cron/jobs/:id/resume` | `enabled=true` + `scheduler.syncJob(...)`. |

Error codes returned to the client:

| HTTP | code | When |
|---|---|---|
| 400 | `INVALID_CRON` | `isValidCron(body.cron) === false`. Response message includes `SUPPORTED_CRON_FORMATS`. |
| 400 | `INVALID_ACTION_CONFIG` | Action unknown or `requiredFields` / `validate` rejects the config. |
| 404 | `NOT_FOUND` | `:id` matches neither `cron_jobs.id` nor `cron_jobs.name` for a non-deleted row. |
| 409 | `JOB_NAME_CONFLICT` | Create with a name that already exists (matches `idx_cron_jobs_name`). |
| 500 | `CORRUPT_CONFIG` | `JSON.parse(row.taskConfig)` threw — should never happen for rows the API created. |

## Auditing

Every write route lands an `audit_events` row with `resourceType="cron_job"` and `resourceId=<row.id>`:

| Action | Emitted by |
|---|---|
| `cron.job.created` | `POST /api/cron/jobs` |
| `cron.job.deleted` | `DELETE /api/cron/jobs/:id` |
| `cron.job.triggered` | `POST /api/cron/jobs/:id/trigger` |
| `cron.job.paused` | `POST /api/cron/jobs/:id/pause` |
| `cron.job.resumed` | `POST /api/cron/jobs/:id/resume` |

The scheduler's own ticks do **not** emit audit events — the run is
captured in `cron_job_logs` instead. `audit_events` is reserved for
interactive operator actions.

## Backup

`cronBackupContribution` (registered from `index.ts`) exports
`cron_jobs` and `cron_job_logs` under the module name `cron`. Order
matters: `cron_jobs` lists first so `cron_job_logs.job_id` foreign keys
resolve on import. No cross-module `deps` — nothing references
`cron_jobs` outside this module.

## End-to-end coverage

`tests/e2e/modules/cron/cron.test.ts` drives the routes through the
live API process.

Active (always-on) cases:

- **Actions catalog** — built-in `log-cleanup` present in
  `/cron/actions`; 401 for anonymous, 403 for non-admin.
- **Default seeding read** — the auto-seeded `log-cleanup` row shows up
  in `/cron/jobs`.

Skipped under a `FIXME(libsql-encryption)` block (full bodies preserved
in the same file as documentation of the intended coverage):

- **CRUD happy path** — create → list → soft-delete + `deleted` toggle.
- **Validation matrix** — `JOB_NAME_CONFLICT` / `INVALID_CRON` /
  `INVALID_ACTION_CONFIG`.
- **Lifecycle** — pause → resume → trigger → logs.
- **Permission matrix** — every write route returns 403 to non-admin;
  delete returns 404 for unknown ids.
- **Audit landing** — a `cron.job.triggered` row shows up in
  `/api/audit` filtered by the new job's id.

**Reason for the skip.** The orchestrator's phase-A → phase-B → phase-C
restart sequence trips an upstream libsql encrypted-WAL bug — an
`INSERT cron_jobs` immediately followed by an `audit_events` insert and
then a SIGTERM leaves the next-open database with `SQLITE_CORRUPT:
database disk image is malformed` on the first
`SELECT FROM "__drizzle_migrations"`. The pattern reproduces only with
`DB_ENCRYPTION=true` and only when the process is killed seconds after
the write, so production deployments (which do not restart at e2e
cadence) are unaffected. The same write paths are exercised in unit
tests under `apps/api/src/modules/cron/cron.test.ts` against a
plain-text temp SQLite, so the service-layer logic stays covered.
Re-enable the skipped `describe` block once libsql ships the upstream
fix and the e2e orchestrator runs cleanly through phase C.

## Out of scope

- **Distributed scheduling** — single-process Baker only. Running the
  API in HA requires either leader election or pinning `cron` to one
  replica (a future env switch). The schema is forward-compatible but
  the executor does not coordinate locks across processes.
- **Time-zone aware schedules** — every cron expression evaluates in
  the API process's local TZ; the UI displays `nextExecution` in UTC.
- **Action argument schemas** — `requiredFields` + an optional
  `validate` callback is the contract; there is no per-action zod
  schema surface for the operator UI yet.
