# System Module

Cross-cutting endpoints: health probes, build provenance, Prometheus
metrics, upload-limit advertisement.

## File layout

```text
apps/api/src/modules/system/
  system.routes.ts        # /health, /health/ready, /system/version, /system/upload-limits, /metrics
  index.ts
```

The Prometheus counters / gauges scraped by `/metrics` are implemented
in `apps/api/src/shared/lib/metrics.ts` — system-wide, not module-owned,
so other modules can `counterAdd` / `gaugeSet` without importing
`@/modules/system`.

## Database

No tables.

## Routes

All `systemRoutes()` mount under `publicRoutes()` (Hono routing topology);
auth is enforced inside each handler by `authRequired` /
`adminRequired` / `serviceTokenRequired`.

| Method | Path                          | Access        | Description                                                                                                                            |
| ------ | ----------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                 | Public        | **Liveness**. Always `200 {status:"ok"}` unless the runtime is wedged. Used by k8s `livenessProbe` / Docker `HEALTHCHECK`.               |
| GET    | `/api/health/ready`           | Public        | **Readiness**. `200 {status:"ready"}` only when the DB is unlocked AND reachable; `503` with `status:"locked"\|"no_db"\|"db_unavailable"` otherwise. Used by k8s `readinessProbe` / load-balancer pool draining. |
| GET    | `/api/system/version`         | Admin         | Build provenance: commit hash + build time. Mirrors what `app --version` prints in the standalone binary.                                |
| GET    | `/api/system/upload-limits`   | Authenticated | `{ maxFileSize, maxAttachmentsPerResource, totalQuota }`. Frontend reads this to render correct client-side hints.                       |
| GET    | `/api/metrics`                | Service Token | Prometheus text exposition. Gated by `SERVICE_TOKEN_METRICS`; returns 503 when unset so scrape jobs fail closed.                  |

## Audit

System routes do not perform writes and emit no audit events.

## Out of scope

- Distributed tracing — `pino` logs carry a per-request `requestId` for
  manual correlation but there's no OTLP exporter wired in.
- Per-route latency histograms — the metrics module exposes counters
  and gauges only; histogram timing is left to a downstream APM if
  needed.
