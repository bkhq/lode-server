# Audit Module

The audit module stores immutable records for significant platform actions and exposes admin-only query endpoints.

Code layout:

```text
apps/api/src/modules/audit/
  schema.ts             # `audit_events` table
  audit.routes.ts
  audit.service.ts
  retention.ts          # background sweep that prunes old events
  index.ts
```

## Routes

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/audit` | Admin | Lists audit events with filters and pagination. |
| GET | `/api/audit/:id` | Admin | Returns one audit event. |

## Query Filters

`GET /api/audit` accepts:

| Parameter | Description |
|---|---|
| `actor_id` | Filters by actor user ID. |
| `action` | Filters by action string. |
| `resource_type` | Filters by resource type. |
| `resource_id` | Filters by resource ID. |
| `result` | `success` or `failure`. |
| `from` | Inclusive ISO timestamp lower bound. |
| `to` | Inclusive ISO timestamp upper bound. |
| `page` | Page number. |
| `limit` | Page size, up to 200. |

## Event Shape

Audit records are stored in `audit_events` with actor, action, resource, request metadata, result, and optional JSON detail.

The service is used by account, policy, settings, encryption, and backup code paths.

## Retention

The retention sweep is controlled by `AUDIT_RETENTION_DAYS`:

| Value | Behaviour |
|---|---|
| `0` (default) | Keep events forever. Sweep is not started. |
| `> 0` | Drop events older than the configured number of days. The sweep fires at boot and every hour thereafter. |

Set this in production to avoid unbounded table growth (a moderately busy box accrues ~10k rows/day). The sweep deletes via `WHERE created_at < cutoff` so it is index-friendly; deletion counts are logged at `info` level when non-zero.

The sweep runs only on an unlocked database — locked instances skip it because the API never enters `buildFullApp`.
