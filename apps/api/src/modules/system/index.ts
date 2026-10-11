// System module — health probes, build-version, Prometheus metrics,
// upload-limit reads. Schemaless (owns no tables) and so does not
// register a backup contribution. Mounted from `routes/public.ts`
// rather than `protected.ts` because the health endpoints must be
// callable without authentication for orchestrator probes.
//
// The aggregator is intentionally a single re-export — kept distinct
// from data-bearing modules so reviewers can see at a glance that
// `system` adds no DB schema and no backup contribution.

export { systemRoutes } from "./system.routes";
