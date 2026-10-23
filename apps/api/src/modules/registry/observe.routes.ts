import type { Context } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { AppError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { findReportPackage, requirePackageAccess, resolveReportToken } from "./access";
import { readLogs, readMetrics } from "./observe.otlp";
import { listEvents, listInstances, recordEvents, recordMetrics } from "./observe.service";

/** Largest export accepted, compressed or not, and after decompression. */
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;
const EVENTS_PAGE = 100;

/** The body as text, gunzipped when `Content-Encoding: gzip`, refused past the caps. */
async function readBody(c: Context<AppEnv>): Promise<string> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES)
    throw new AppError("Export too large", 413, "PAYLOAD_TOO_LARGE");
  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES)
    throw new AppError("Export too large", 413, "PAYLOAD_TOO_LARGE");
  const encoding = (c.req.header("content-encoding") ?? "identity").toLowerCase();
  if (encoding === "identity")
    return new TextDecoder().decode(raw);
  if (encoding !== "gzip")
    throw new AppError("Unsupported Content-Encoding", 415, "UNSUPPORTED_ENCODING");
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read().catch(() => {
      throw new AppError("Invalid gzip body", 400, "INVALID_BODY");
    });
    if (done)
      break;
    size += value.byteLength;
    if (size > MAX_INFLATED_BYTES) {
      await reader.cancel();
      throw new AppError("Export too large", 413, "PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(out);
}

/** The parsed JSON export, with its token resolved. */
async function readExport(c: Context<AppEnv>) {
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json")
    throw new AppError("Only OTLP JSON (application/json) is accepted", 415, "UNSUPPORTED_MEDIA_TYPE");
  const token = await resolveReportToken(c.get("db"), c.req.header("authorization"));
  if (!token)
    throw new AppError("A personal API token with a read grant on the package is required", 401, "UNAUTHORIZED");
  let body: unknown;
  try {
    body = JSON.parse(await readBody(c));
  }
  catch (err) {
    if (err instanceof AppError)
      throw err;
    throw new AppError("The body is not JSON", 400, "INVALID_BODY");
  }
  return { token, body };
}

function namespaceAttr(resource: Record<string, unknown>): string | undefined {
  const ns = resource["service.namespace"];
  return typeof ns === "string" && ns !== "" ? ns : undefined;
}

function nameAttr(resource: Record<string, unknown>): string | undefined {
  const name = resource["service.name"];
  return typeof name === "string" && name !== "" ? name : undefined;
}

/** OTLP's answer: `{}`, or `partialSuccess` naming what was refused. */
function exportAnswer(c: Context<AppEnv>, field: "rejectedDataPoints" | "rejectedLogRecords", rejected: number) {
  if (rejected === 0)
    return c.json({});
  return c.json({ partialSuccess: { [field]: String(rejected), errorMessage: "Resources with no matching package, no granted package, no instance id, or past the instance limit were dropped" } });
}

const INGEST_NOTE = [
  "OTLP/HTTP with the JSON encoding (`Content-Type: application/json`, optionally `Content-Encoding: gzip`, at most 1 MiB on the wire and 4 MiB inflated). Protobuf answers 415.",
  "Needs `Authorization: Bearer pat_…`. Each resource is matched to a package by `service.name` (the package slug), in the namespace `service.namespace` names, else in the namespace of the token's owner; the token must hold a grant (any level) on it. The instance is `service.instance.id`, else `host.name`.",
  "Resources that match no such package, name no instance, or would exceed `REGISTRY_OBSERVE_MAX_INSTANCES` for the package are dropped and counted in `partialSuccess`, as OTLP specifies; the rest are stored.",
].join("\n\n");

/** OTLP/HTTP ingest, mounted in the read feed at `/r/otlp`: no session, CSRF or policy middleware. */
export function registryOtlpRoutes() {
  const router = new Hono<AppEnv>();

  router.post(
    "/v1/metrics",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Ingest OTLP metrics",
      description: [
        "Served at `/r/otlp/v1/metrics`, outside `/api`: an OTLP `ExportMetricsServiceRequest`. Each resource refreshes its instance: version (`service.version`), host, lode version, the latest gauge and sum values, and the status a `lode.app.status` gauge names.",
        INGEST_NOTE,
      ].join("\n\n"),
      responses: { 200: { description: "`{}` or `{ partialSuccess }`" }, ...errors(400, 401, 413, 415, 429) },
    }),
    async (c) => {
      const { token, body } = await readExport(c);
      const db = c.get("db");
      const max = c.get("config").REGISTRY_OBSERVE_MAX_INSTANCES;
      const now = new Date().toISOString();
      let rejected = 0;
      for (const entry of readMetrics(body)) {
        const name = nameAttr(entry.resource);
        const pkg = name === undefined ? undefined : await findReportPackage(db, token, name, namespaceAttr(entry.resource));
        if (!pkg || !(await recordMetrics(db, pkg.id, entry.resource, entry.metrics, now, max)))
          rejected += entry.points;
      }
      return exportAnswer(c, "rejectedDataPoints", rejected);
    },
  );

  router.post(
    "/v1/logs",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Ingest OTLP logs as events",
      description: [
        "Served at `/r/otlp/v1/logs`, outside `/api`: an OTLP `ExportLogsServiceRequest`. Each log record becomes an event of the instance, named by its `eventName`, else its `event.name` attribute, else `log`; at most 100 per resource and export, the rest counted as rejected. The instance is refreshed as for metrics.",
        INGEST_NOTE,
      ].join("\n\n"),
      responses: { 200: { description: "`{}` or `{ partialSuccess }`" }, ...errors(400, 401, 413, 415, 429) },
    }),
    async (c) => {
      const { token, body } = await readExport(c);
      const db = c.get("db");
      const max = c.get("config").REGISTRY_OBSERVE_MAX_INSTANCES;
      const now = new Date().toISOString();
      let rejected = 0;
      for (const entry of readLogs(body)) {
        const name = nameAttr(entry.resource);
        const pkg = name === undefined ? undefined : await findReportPackage(db, token, name, namespaceAttr(entry.resource));
        const stored = pkg ? await recordEvents(db, pkg.id, entry.resource, entry.events, now, max) : undefined;
        rejected += entry.events.length - (stored ?? 0);
      }
      return exportAnswer(c, "rejectedLogRecords", rejected);
    },
  );

  return router;
}

const packageParamSchema = z.object({ ns: z.string(), pkg: z.string() });

const instanceSchema = z.object({
  instance_id: z.string(),
  version: z.string().nullable(),
  status: z.string().nullable(),
  host_name: z.string().nullable(),
  os_type: z.string().nullable(),
  host_arch: z.string().nullable(),
  lode_version: z.string().nullable(),
  interval_seconds: z.number(),
  online: z.boolean(),
  attributes: z.record(z.string(), z.unknown()),
  metrics: z.record(z.string(), z.unknown()),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});

const eventSchema = z.object({
  id: z.string(),
  instance_id: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  body: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  at: z.string(),
});

/** What hosts reported for a package, under `/api/registry/packages/:ns/:pkg`. */
export function registryObserveRoutes() {
  const router = new Hono<AppEnv>();

  router.get(
    "/registry/packages/:ns/:pkg/instances",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "List a package's reporting instances",
      description: "The instances that reported to `/r/otlp` for this package, most recently seen first, with their latest snapshot. `online` is false once an instance reported `stopped` or has been silent for three of its report intervals (`lode.report.interval`, default 300 s). For anyone who can read the package.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.array(instanceSchema)), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const { package: pkg } = await requirePackageAccess(c, "read");
      return c.json({ success: true, data: await listInstances(c.get("db"), pkg.id) });
    },
  );

  router.get(
    "/registry/packages/:ns/:pkg/events",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "List a package's reported events",
      description: `Events reported to \`/r/otlp/v1/logs\` for this package, newest first, ${EVENTS_PAGE} at most; pass the last \`at\` as \`before\` for the next page. For anyone who can read the package.`,
      security: SECURITY.session,
      responses: { ...jsonOk(z.array(eventSchema)), ...errors(401, 403, 404, 422) },
    }),
    validator("param", packageParamSchema),
    validator("query", z.object({ before: z.string().datetime().optional() })),
    async (c) => {
      const { package: pkg } = await requirePackageAccess(c, "read");
      const { before } = c.req.valid("query");
      return c.json({ success: true, data: await listEvents(c.get("db"), pkg.id, { before, limit: EVENTS_PAGE }) });
    },
  );

  return router;
}
