# Operations Runbook

Day-2 procedures for operators. Examples assume `BASE_PATH=/app`. The app is mounted at root (`/`) by default; drop the `/app` prefix from the paths below if you have not set `BASE_PATH`. Endpoints are described in [`api.md`](../reference/api.md); deployment context in [`deployment.md`](deployment.md).

---

## Master password rotation

Rotate the master password (re-wraps the DEK with a new master keypair; ciphertext is untouched).

### Procedure

1. Sign in as admin to the running, **unlocked** instance.
2. Mint a challenge:
   ```http
   POST /app/api/encryption/challenge
   ```
3. Call `POST /app/api/encryption/change-master` with the current and new master passwords (proving DEK ownership against the challenge). See [`api.md`](../reference/api.md) for the request body shape.
4. Save the new recovery key file the API returns. Store it in your password manager / sealed envelope process — **do not** keep it on the application server.

### Verification

- Lock the instance (restart the container) and unlock with the **new** password. If unlock fails, revert by restoring the latest snapshot (see "Restore from snapshot").
- Verify `GET /app/api/encryption/status` returns `{initialized: true, locked: false, status: "unlocked"}`.
- Verify any sensitive admin endpoint (e.g. `GET /app/api/encryption/meta`) still returns 200.

### Storage rules for the new recovery key

- One copy in your secrets vault (1Password, Vault, sealed Bitwarden item, etc.).
- One offline copy (printed and stored in a safe) for break-glass.
- **Never** commit it to git, paste it into chat, or email it.

---

## Lost master password / recovery key

This is a destructive scenario. The current implementation does **not** support unlocking with the recovery key alone once the master password is lost — the recovery key file you saved at setup is the master keypair, but unlock requires deriving the wrap key from a password the operator types in. If you lose the password and the key file, the database ciphertext is unrecoverable.

The only recovery path is **restore from a JSON backup** taken with `/api/backup/export` while the system was unlocked.

### Procedure

1. Stop the container.
2. Take a forensic copy of the existing `data/db/` directory (`app.db`, `app.db-wal`, `app.db-shm`, `meta.db`). You will not be using it, but keep it until you have verified the restore.
3. Move the existing DB files aside so the next start sees an empty database.
4. Start the container. Read the auto-generated bootstrap token off stderr (`docker compose logs app | grep BOOTSTRAP_TOKEN`) or `<data dir>/bootstrap-token.txt`. Visit `/app/setup`, paste the token, and initialise with a **new** master password. Save the new recovery key. The token and file are removed once init succeeds.
5. Sign in as admin and `POST /app/api/backup/import` with the most recent JSON backup. Import is schema-version-locked — the old binary used to take the export and the new binary used to import must be schema-compatible.
6. Verify row counts and a representative user / group / settings entry.
7. Once verified, delete the forensic copy from step 2.

If you do not have a JSON backup, the data is unrecoverable. This is the strongest possible argument for the snapshot sidecar described in `deployment.md`.

---

## Restore from snapshot

When the database has been corrupted, accidentally truncated, or you need to roll back to a known-good state.

### Procedure

1. **Stop the container.** Do not attempt a hot copy.
   ```bash
   docker compose stop app
   ```
2. Identify the snapshot you want to restore. The snapshot sidecar (see `deployment.md`) writes timestamped `app-YYYYMMDDTHHMMSSZ.db` files.
3. Replace the four DB files in the data volume:
   - `app.db`
   - `app.db-wal`
   - `app.db-shm`
   - `meta.db`

   The simplest safe sequence:
   ```bash
   # working in the host-side mount of the data volume
   mv data/db/app.db data/db/app.db.broken
   rm -f data/db/app.db-wal data/db/app.db-shm
   cp /snapshots/app-20260510T120000Z.db data/db/app.db
   # meta.db is unencrypted and rarely changes; restore from the same window
   cp /snapshots/meta-20260510T120000Z.db data/db/meta.db
   ```

   If your snapshot only captured `app.db` (the SQLite online backup API merges WAL into the file), removing the stale `-wal` / `-shm` is correct — SQLite recreates them on next open.
4. **Start the container.**
   ```bash
   docker compose up -d app
   ```
5. Visit `/app/unlock` and enter the master password that was active **at the time of the snapshot**. If you have rotated the master password since, you must restore both `app.db` *and* `meta.db` from the same snapshot window — they are coupled.
6. Verify:
   - `GET /app/api/encryption/status` → `unlocked`.
   - Spot-check the most recently created record (user, group, token) from before the incident.
   - `GET /app/api/audit?limit=20` shows recent entries.
7. Once verified, retain `app.db.broken` for at least 24 hours, then delete. For deployments that perform restores frequently, rename to `app.db.broken-$(date -u +%Y%m%dT%H%M%SZ)` so successive incidents do not clobber each other, and add a host-level cron to prune older than 7 days:
   ```bash
   find /path/to/data/db -name 'app.db.broken-*' -mtime +7 -delete
   ```

---

## Audit log investigation

Use during an incident response — abnormal logins, suspected privilege escalation, attachment exfiltration, etc. All endpoints below require admin access.

### Endpoints

- `GET /app/api/audit` — paginated list. Supports filters:
  - `actor` — username or user id
  - `action` — e.g. `auth.login`, `auth.logout`, `totp.verify`, `users.update`, `groups.add_member`, `tuples.create`, `attachments.upload`, `attachments.download`, `attachments.delete`, `settings.update`, `encryption.change_master`, `encryption.rotate_dek`, `backup.export`, `backup.import`
  - `resource` — `users:<id>`, etc.
  - `result` — `success` | `failure`
  - `from`, `to` — ISO timestamps
  - `ip` — exact client IP
- `GET /app/api/audit/:id` — full event detail (includes the JSON `detail` payload).

### Suggested incident playbook

1. **Scope by time.** Start with `from=<incident_start_minus_1h>&to=<incident_end_plus_1h>`.
2. **Pivot on actor.** If a user account is suspect, filter by `actor=<id>` and review **every** action in the window — not just the suspicious one.
3. **Pivot on IP.** Use the IP from a suspicious entry to find every other action from the same IP across all actors. Look for credential-stuffing patterns (many `auth.login` `failure` rows then a `success`).
4. **Check encryption / backup events.** `encryption.change_master`, `encryption.rotate_dek`, `backup.export`, and `backup.import` are the highest-leverage actions; any unexplained occurrence is a hard incident.
5. **Cross-reference with the application log** (`LOG_FILE` or stdout). The audit table records intent and outcome; the application log records request-level detail (request id, headers, latency).

### Retention

`AUDIT_RETENTION_DAYS` defaults to `0` (keep forever). Long-lived deployments should set a finite value (e.g. `90` or `365`) so `audit_events` does not grow unbounded. The retention sweep runs hourly.

---

## Service-token automation

Two endpoints accept a bearer instead of a session cookie. Each scope is gated by its own env var (≥ 32 chars). Splitting the surfaces means a leaked metrics scraper credential cannot also dump the database.

| Endpoint | Env |
|---|---|
| `POST /app/api/backup/export-via-token` — streams the JSON backup. No DEK challenge, no master password. Used by `examples/compose/backup-sidecar.yml`. | `SERVICE_TOKEN_BACKUP` |
| `GET /app/api/metrics` — Prometheus exposition (HTTP request counter + duration histogram, encryption_locked gauge). Configure Prometheus to send `Authorization: Bearer ${SERVICE_TOKEN_METRICS}`. | `SERVICE_TOKEN_METRICS` |

Operators that don't need a surface should leave its env var unset; the endpoint then returns `503 SERVICE_TOKEN_DISABLED`. Rotate by changing the env var on both the API and any caller, then restarting the API. Constant-time comparison; no length oracle.

Treat each token like an OAuth client secret: store in your secrets manager, never commit to git. The audit row for `backup.export-via-token` records `actor:"system"` / `actorName:"system:backup-sidecar"` so you can distinguish automated dumps from operator-driven ones.

---

## Log handling

- Container deployments: keep `LOG_TO_STDOUT=true` (the Dockerfile default). Logs go to docker / journald / k8s and survive container churn. No on-host rotation needed.
- Bare-metal deployments: write to `LOG_FILE` and rotate externally. The example config at `examples/logrotate.d/app` ships a daily rotation with 14-day retention. The `postrotate` hook sends `SIGHUP`; the API responds by reopening the log fd in place (`apps/api/src/index.ts`'s SIGHUP handler), so the next write goes to the freshly-rotated file without process restart.

---

## OIDC discovery cache

`bootstrap` calls the IdP's `/.well-known/openid-configuration` once at startup and persists a copy as `<DB_PATH minus .db>-oidc.json` (e.g. `data/db/app-oidc.json`). On subsequent boots, if the IdP is unreachable we fall back to the cached endpoints — the API still serves traffic with last-known-good URLs. A successful refresh updates the cache; switching `OAUTH_ISSUER` invalidates by issuer mismatch.

Operationally: this cache file contains URLs only (no secrets). It is safe to back up alongside the DB. Delete it to force a fresh discovery on next boot.

---

## Half-encrypted state recovery

If a DEK rotation crashes mid-flight and leaves both `data/db/app.db` (plaintext side) and `data/db/app.db.enc.tmp` (the partially-rotated copy) on disk:

1. Stop the service.
2. Inspect both files; `.enc.tmp` is the in-progress rotation that did not finish the rename swap. The pre-rotation DEK is still authoritative.
3. Delete the `.enc.tmp` file. The original `app.db` and `meta.db` remain valid under the previous DEK.
4. Restart. The boot path detects the existing meta and proceeds with the previous DEK.
5. Re-run rotation once the system is verified healthy.

When in doubt, restore from the most recent snapshot (see "Restore from snapshot") rather than guessing which file is canonical.

---

## Service health and on-call response

### SLOs and alert thresholds

Suggested defaults to alert on (Prometheus exposition):

| Symptom | Query / signal | Threshold |
|---|---|---|
| Service locked | `encryption_locked == 1 for 5m` | page on-call |
| Readiness flapping | `up{job="app"}` or HTTP 503 from `/api/health/ready` | warn after 2m, page after 5m |
| Error-rate elevated | `rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])` | warn > 1%, page > 5% |
| Latency p95 | `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))` | warn > 1s, page > 3s |
| Backup stale | last successful audit row for `system:backup-sidecar` | warn > 26h |

Tune the warn / page thresholds to your traffic shape. The metric names
are the ones emitted by `apps/api/src/shared/lib/metrics.ts`.

### Decision tree: `/api/health/ready` returns 503

1. Check `GET /api/health` (liveness): if it is also failing, the
   process is wedged — restart the container.
2. If liveness is healthy but ready returns 503, inspect the
   `Encryption-Status` header and JSON body:
   - `locked` → an operator unlock is required. Drain the LB and run
     `/api/encryption/unlock`. If unattended, see "Sealed-file unlock"
     below.
   - `db_unavailable` → the DB handle is gone. Common causes: disk
     pressure (check `df -h ${ROOT_DIR}/data/`), libsql corruption
     (see "DB will not open after restart"), or a half-applied
     migration. Take a snapshot of `data/db/` before restarting so a
     postmortem still has the on-disk state.
3. While in 503, drain LB / k8s readiness so traffic does not pile up.

### DB will not open after restart

Symptom: post-restart logs show `SQLITE_CORRUPT` (or
`Failed to open libsql db`) and `/api/health/ready` stays at 503.
Cause: encrypted-WAL + SIGTERM during a write burst can leave the
file unable to reopen.

Recovery:

1. Stop the application. Snapshot `data/db/app.db*` and `data/db/meta.db*`
   for post-mortem (corruption is rare; preserving evidence helps).
2. Restore the most recent good snapshot (see "Restore from snapshot").
   Both `app.db` and `meta.db` must be from the same point in time.
3. Resume the application; verify unlock + `/api/health/ready` returns
   200.

Production deploys must run a snapshot sidecar or `litestream` (see
[`deployment.md`](deployment.md) § Backup & restore). The single-node
SQLite topology has no built-in failover; the snapshot is the only
recovery path.

### Sealed-file unlock for unattended restarts

When `MASTER_PASSWORD_FILE` is set, the API reads the master password
from that file at boot, posts to `/api/encryption/unlock` on loopback,
then **deletes the file**. The mode must be `0600` and the file is
considered single-use — recreate it on every restart from your secret
store, or accept that the next restart will land in `locked` until an
operator unlocks manually. Pair with a sidecar that writes the file
just before container start and treat the host filesystem as the
trust boundary.

---

## Known issues

Areas where the template ships with a documented gap. Re-validate any of
these before relying on them in production.

### DEK rotation is opt-in / experimental

`POST /app/api/encryption/rotate-dek` is gated behind
`ENABLE_EXPERIMENTAL_DEK_ROTATION=true` and returns `501 Not Implemented`
when the flag is off. The end-to-end test that exercises the round-trip
(`tests/e2e/modules/encryption/admin.test.ts`'s `rotate-dek round-trip`)
is currently `it.skip`-ped pending hardening of the libsql swap path.
Implications:

- Operators that need to rotate the DEK should expect manual recovery
  steps (see "Half-encrypted state recovery") if the rotation aborts
  mid-flight.
- The "Master password rotation" procedure above is independent and
  fully tested — it re-wraps the DEK, it does not generate a new DEK.

### Cron write-path e2e is currently skipped

`tests/e2e/modules/cron/cron.test.ts` `describe.skip`s the cron
write-path suite — the test orchestrator's tight `phase-A → phase-B →
encrypt-restart` cycle exposes a libsql encryption-key write race the
read-path tests work around. Implications:

- The unit tests under `apps/api/src/modules/cron/` cover the
  scheduler, executor, and action registry; coverage for the HTTP
  surface (POST/PATCH/DELETE on `/api/cron/jobs`) is unit-only and
  not exercised against an encrypted DB.
- If your deployment uses cron heavily, smoke-test job creation +
  trigger via the admin UI after the first DEK is initialised.

### Bootstrap token surface

The bootstrap token is published in this order:

1. `/dev/tty` when a controlling terminal is attached (interactive
   `bun` / `docker run -it`).
2. `<data-dir>/bootstrap-token.txt` with verified `0o600` file +
   `0o700` directory permissions (file is removed automatically on
   `/encryption/init` success or on the next boot once `meta.db`
   exists).
3. `stderr` only as a last resort — when neither of the above worked.
   The line carries an explicit "WARNING: this value was emitted to
   stderr" tail so log-retention systems flag it.

Operationally: prefer the file-based pickup for daemonised
deployments. If you see the stderr fallback fire (e.g. in `docker logs`
for a non-tty `docker run`), strip the line from log retention after
setup completes — the token is single-use, but the historical value
shouldn't sit indefinitely in archived logs.
