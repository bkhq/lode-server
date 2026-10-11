# Settings Module

Generic key/value settings store. Used for admin-tunable runtime knobs that are not safe to put in environment variables.

## File layout

```text
apps/api/src/modules/settings/
  schema.ts                # `settings` table
  settings.routes.ts
  settings.service.ts
  settings.backup.ts       # backup contribution
  index.ts                 # registers backup contribution
```

## Database

| Table | Purpose |
|---|---|
| `settings` | Single-row-per-key map. Columns: `key`, `value` (TEXT), `updated_by` (FK users), `updated_at`. |

## Routes

Mounted under `protectedRoutes`. All routes are admin-only.

| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Lists all settings. |
| GET | `/api/settings/:key` | Reads one setting. |
| PUT | `/api/settings/:key` | Writes one setting. |
| DELETE | `/api/settings/:key` | Deletes one setting. |

OAuth/OIDC provider settings are deliberately **not** stored here — they are read from environment at runtime.

## Audit

`setting.updated`, `setting.deleted`.

## Out of scope

- Typed schemas per setting (everything is `TEXT`).
- Setting history / rollback (each PUT overwrites in place).
- Validation of values; callers must validate before storing.
