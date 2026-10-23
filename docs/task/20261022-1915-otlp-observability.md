# 20261022-1915-otlp-observability Accept lode status reports over OTLP/HTTP and show them per package

- **status**: completed
- **priority**: P2
- **owner**: agent/otlp-20261022
- **createdAt**: 2026-10-22 19:15

## Description

lode is gaining a `[report]` section that pushes the host's status (app name,
running version, status, uptime, update/rollback events) as standard OTLP/HTTP
JSON to any OTLP endpoint. Operators point it at `<origin>/r/otlp` with a
`pat_…` bearer, exactly as for any other backend. Accept those exports at
`/r/otlp/v1/{metrics,logs}`, match each resource to a package by
`service.name` (namespace from `service.namespace` or the token owner), store
the latest state per instance plus an event log, and add an Observability tab
to the package page.

## ActiveForm

Adding OTLP status ingestion and package observability

## Notes

- Plan: [20261022-1915-otlp-observability](../plan/20261022-1915-otlp-observability.md)
- Counterpart in lode: `docs/task/20261022-1915-status-report.md`
