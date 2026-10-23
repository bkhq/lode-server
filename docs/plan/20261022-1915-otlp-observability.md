# 20261022-1915-otlp-observability Accept lode status reports over OTLP/HTTP

- **status**: completed
- **createdAt**: 2026-10-22 19:15
- **approvedAt**: 2026-10-22 19:30
- **relatedTask**: 20261022-1915-otlp-observability

## Context

- The read feed lives under `READ_FEED_PREFIX = "/r"` (`modules/registry/feed.routes.ts`):
  `/r/:ns/:pkg/manifest.json` and `/r/:ns/:pkg/:ver/:asset`, public anonymously,
  private with a `pat_…` token holding a `read` grant (`resolveReadToken`).
- The database is the SQLite inside one Durable Object; cron jobs run through
  `modules/cron`.
- lode reports with OTLP/HTTP JSON (no vendor fields). Resource attributes:
  `service.name` = package slug (= lode `[global].app` = manifest `name`),
  optional `service.namespace` (only when the operator sets it), `service.version`,
  `service.instance.id`, `host.name`, `host.arch`, `os.type`, plus `lode.*`
  attributes and operator labels. Default interval 300 s.

## Proposal

### 1. Ingest routes

- `POST /r/otlp/v1/metrics` and `POST /r/otlp/v1/logs` (OTLP/HTTP default paths
  under the base `…/r/otlp`). No clash with the feed routes (`/r/:ns/:pkg/manifest.json`
  needs `manifest.json`; assets need four segments); `otlp` is still reserved as
  a namespace slug so `/r/otlp/…` can never mean a package.
- `Content-Type: application/json` only (OTLP JSON encoding: lowerCamelCase keys,
  hex trace ids not used, int64 as strings). Protobuf answers `415` for now.
- Body cap 1 MiB (`413`); `Content-Encoding: gzip` accepted.
- Answers per OTLP: `200` with `{}`; `{ "partialSuccess": { "rejectedDataPoints" |
  "rejectedLogRecords": n, "errorMessage": "…" } }` when some resources were refused;
  `400` for an unparsable body; `401` with no token; `429` + `Retry-After` when
  rate-limited.

### 2. Auth and matching

- One rule for every sender (lode or any OTel exporter); nothing in the payload is
  lode-specific. Each `resourceMetrics` / `resourceLogs` entry is matched to a
  package by `service.name` = package slug, in the namespace named by
  `service.namespace` when present, else the namespace of the token's owner
  (one namespace per user, and a token's grants only cover its owner's
  packages, so token + slug is unambiguous). The bearer `pat_…` must hold a
  `read` grant (or higher) on that package — for public packages too (no
  anonymous reports). Unmatched or unauthorised entries are dropped and counted
  in `partialSuccess`; a request where nothing matched answers `200` with the
  full count rejected (OTLP: do not retry).
- Rate limit per token: 60 requests/min (configurable env).

### 3. Storage (new Drizzle migration)

- `registry_instances`: `package_id`, `instance_id` (`service.instance.id`,
  ≤ 128 chars), `version`, `status`, `host_name`, `os_type`, `host_arch`,
  `lode_version`, `attributes` (JSON, ≤ 4 KiB), `metrics` (JSON snapshot of the
  latest `lode.*` gauges), `first_seen_at`, `last_seen_at`. PK
  (`package_id`, `instance_id`). Upserted per export.
- `registry_instance_events`: `id`, `package_id`, `instance_id`, `name`
  (`event.name`), `version`, `body`, `attributes` (JSON), `at`. Index
  (`package_id`, `at`).
- Cron: delete events older than `REGISTRY_EVENT_RETENTION_DAYS` (default 30) and
  instances unseen for the same period. Not in backups.
- Cap instances per package (default 1000) and attribute sizes; excess is
  rejected through `partialSuccess`.

### 4. API and UI

- `GET /api/registry/packages/:ns/:pkg/instances` (session / token `read`):
  instances with `online` = `last_seen_at` within 3 × interval (interval taken
  from the `lode.report.interval` attribute, default 300 s).
- `GET /api/registry/packages/:ns/:pkg/events?before=&limit=`.
- Web: an "Observability" tab on the package page — instance table (instance,
  host, version, status, last seen, online), version distribution, event
  timeline. i18n strings in both locales.

### 5. Tests

- Route tests: valid export upserts; `partialSuccess` for an unknown package and
  a token without a grant; public package without a token → `401`; 413/415;
  gzip body.
- Service tests: online/offline computation, retention sweep, caps.
- Web: tab renders instances/events from fixtures.

## Risks

- Write load on the single Durable Object: one upsert per instance per
  interval; 300 s default keeps 1000 instances at ~3.3 writes/s.
- OTLP JSON quirks (int64 as string, `AnyValue` unions) — parse defensively.

## Scope

API module `registry` (routes, service, schema, migration, cron sweep), web
package page, docs (`docs/reference/api.md`, `docs/modules/registry.md`,
env reference), changelog. No change to existing feed routes.

## Alternatives

- `/r/:ns/:pkg/otlp`: rejected by the owner; one endpoint lets a single OTel
  Collector forward for many packages.
- Anonymous reports for public packages: refused — anyone could forge instances.
- Protobuf now: deferred; lode sends JSON.

## Annotations

Decisions (2026-10-22): single endpoint `/r/otlp`; package resolved from the
payload; default interval 300 s, configurable on the lode side. No lode-server
switch on the lode side: lode is configured exactly as for any OTLP backend
(`endpoint = "<origin>/r/otlp"` + an `Authorization` header), so self-hosted
registries work the same; the server resolves the namespace from
`service.namespace` or the token owner.

Implementation notes (2026-10-22):

- No per-token rate limit: `/r/otlp` shares the raw per-IP bucket
  (`RAW_API_RATE_LIMIT_PER_MINUTE`) with the read feed; the 300 s default
  interval and `REGISTRY_OBSERVE_MAX_INSTANCES` bound the write load.
- No `otlp` slug reservation: namespace slugs are system-assigned 8-character
  ids, so `/r/otlp` cannot collide with `/r/:ns/...`.
- `service.namespace` only changes the outcome for an administrator's token
  with a grant on another user's package; other tokens only reach their
  owner's packages.
- Observation tables are left out of the registry backup contribution.
