# Encryption Module

Manages SQLite-at-rest encryption (libsql encrypted database). Owns the system lock state.

## File layout

```text
apps/api/src/modules/encryption/
  encryption.routes.ts       # status / init / unlock / challenge / meta / rotate-dek / change-master
  encryption.service.ts      # initEncryption / unlockSystem / rotateDek / changeMasterKey
  state.ts                   # in-memory lock + ECIES challenge state + onUnlock callback
  meta.ts                    # reads/writes encryption sidecar metadata
  bootstrap.ts               # boot-time wiring; toggles app from locked to unlocked
  index.ts
```

## Lifecycle

The API has two boot states:

- **Locked**: `publicRoutes` and `setupRoutes` mount. Encryption status, init, unlock, the unlock-challenge mint, and `/health` are reachable.
- **Unlocked**: `protectedRoutes` mounts in place of `setupRoutes`. Triggered by the persistent `setOnUnlock` callback inside `app.ts` when the DB becomes available.

`bootstrapEncryption(...)` wires the meta + state pair at startup. The unlock callback is persistent, so DEK rotation and master-key changes can re-fire it to rebuild the app context with a fresh database handle. Both `rotate-dek` and `change-master` acquire the operation lock (`beginOperation()`) to serialize concurrent admin invocations.

## Database

No tables. Persistence is through the libsql encryption metadata sidecar (`meta.ts`).

## Routes

| Method | Path | Group | Access | Description |
|---|---|---|---|---|
| GET | `/api/encryption/status` | public | Public | Returns `{initialized, locked, status, dbError}` only. |
| POST | `/api/encryption/unlock-challenge` | setup | Public when locked, per-IP rate-limited | Returns `{challenge, encryptedDek, kdfSalt}` so the SPA can perform an unlock attempt. |
| POST | `/api/encryption/init` | setup | Public until initialized, bootstrap-token gated | Initializes encryption and creates the DEK. |
| POST | `/api/encryption/unlock` | setup | Public when locked, per-IP rate-limited | Decrypts the DEK with the master key, opens the DB, swaps the app to `unlocked`. |
| POST | `/api/encryption/challenge` | protected | Admin | Issues an ECIES ephemeral key for sensitive admin operations (rotate / export). |
| GET | `/api/encryption/meta` | protected | Admin | Returns `{encryptedDek, kdfSalt}` (null when uninitialized) for admin tooling. |
| POST | `/api/encryption/rotate-dek` | protected | Admin (operation-locked) | **EXPERIMENTAL** — rotates the DEK and rewrites the libsql key. Gated behind `ENABLE_EXPERIMENTAL_DEK_ROTATION=true`; with the flag off the route returns 501 Not Implemented. Currently fails with `SQLITE_IOERR` under busy WAL; prefer `change-master` until the tracked fix lands. |
| POST | `/api/encryption/change-master` | protected | Admin (operation-locked) | Re-wraps the DEK under a new master key. |

## Audit

`encryption.dek_rotation_started` (recorded before rotation begins, since the live db handle is closed during rotation) and `encryption.master_changed`. Init and unlock are not audited (the DB may be inaccessible at the time). Rotation failures land in the structured logger.

## Out of scope

- HSM-backed master key.
- Key splitting / Shamir secret sharing.
- Per-table encryption (DB-level only).
