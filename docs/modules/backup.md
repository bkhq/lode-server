# Backup Module

Database export / restore in JSON form, scoped to selected data modules with dependency resolution.

## File layout

```text
apps/api/src/modules/backup/
  backup.routes.ts      # aggregator: mounts export + restore
  registry.ts           # self-registration API (BackupContribution, registerBackupContribution, ...)
  export.routes.ts
  export.service.ts     # streamJsonBackup / verifyDek
  restore.routes.ts
  restore.service.ts    # validateBackupData / validateFileSize / importJsonBackup
  index.ts
```

## Database

No own tables. Each data-bearing module declares a `BackupContribution` from its own `<module>.backup.ts` and registers it from its `index.ts`. The backup module never imports module schemas — it only enumerates whatever modules have registered themselves at boot.

See [`develop/module/standards.md` §2.8 — Backup contribution](../develop/module/standards.md#28-backup-contribution-mandatory-for-modules-that-own-tables) for the rule new modules must follow.

## Routes

Mounted under `protectedRoutes`. Most routes require admin; the
`export-via-token` route accepts a bearer instead of a session cookie.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/backup/modules` | Admin | Lists data-module names available for backup. |
| POST | `/api/backup/export` | Admin | Streams a JSON backup of selected modules. Requires DEK challenge when DB encryption is enabled. |
| POST | `/api/backup/export-via-token` | Service Token | Same JSON output, gated by `SERVICE_TOKEN_BACKUP` instead of session — for non-interactive backup tooling. No DEK challenge. |
| POST | `/api/backup/import` | Admin | Validates and applies a JSON backup. Requires DEK challenge when DB encryption is enabled. |

Encryption verification flow: client first calls `POST /api/encryption/challenge` to get an ephemeral pubkey, ECIES-encrypts the DEK with it, and submits both `challengeId` and `encryptedDek` in the export/import body.

## Audit

`backup.export`, `backup.import`.

## Out of scope

- Incremental / differential backups.
- Scheduled / off-site backups.
- Backups newer than the running build (`version` > the build's
  `CURRENT_BACKUP_VERSION`). Older dumps are migrated forward on import:
  v1 → v2 coerces a `null` `relation_tuples.subjectRelation` to the
  direct-subject sentinel and lifts `resource_group … #__meta__` tuples into
  `resource_groups` rows.
