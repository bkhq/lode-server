import type { Context } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { BUILD_INFO } from "@/build-info";
import { getLodeSummary, requestLodeRestart, requestLodeRollback, requestLodeUpdate, setLodeHold } from "@/lode";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError } from "@/shared/lib/errors";
import { gaugeSet, renderPrometheus } from "@/shared/lib/metrics";
import { describeRoute, errors, jsonOk, raw, resolver, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { serviceTokenRequired } from "@/shared/middleware/service-token";

// A lode version token: a concrete version or the "latest" channel pointer.
const lodeVersion = z.union([
  z.literal("latest"),
  z.string().trim().min(1).max(64).regex(/^[\w.+-]+$/, "must be a version or \"latest\""),
]);
const lodeUpdateSchema = z.object({ target: lodeVersion });
// Rollback to a specific version, or omit to use lode's recorded last_good.
const lodeRollbackSchema = z.object({ version: lodeVersion.optional() });
const lodeHoldSchema = z.object({ hold: z.boolean() });

// All four lode operations are sensitive admin actions — record an audit event.
async function auditLodeAction(c: Context<AppEnv>, action: string, detail: Record<string, unknown>): Promise<void> {
  const user = c.get("user")!;
  await audit(c.get("db"), c.get("logger"), {
    actorId: user.id,
    actorName: user.name,
    action,
    resourceType: "lode",
    resourceId: "supervisor",
    resourceName: "lode supervisor",
    detail,
    ip: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? "",
    result: "success",
  });
}

function lodeNotActive(): never {
  throw new AppError("not running under the lode supervisor", 409, "LODE_NOT_ACTIVE");
}

export function systemRoutes() {
  const router = new Hono<AppEnv>();

  // Liveness — k8s livenessProbe / Docker HEALTHCHECK.
  router.get(
    "/health",
    describeRoute({
      tags: [TAGS.System],
      summary: "Liveness probe",
      description: "Returns 200 while the process is up. Used by orchestrator liveness probes.",
      responses: {
        200: { description: "Alive", content: { "application/json": { schema: resolver(z.object({ status: z.literal("ok") })) } } },
      },
    }),
    c => c.json({ status: "ok" }),
  );

  // Readiness — DB reachable, not setup/locked. 503 drains traffic.
  router.get(
    "/health/ready",
    describeRoute({
      tags: [TAGS.System],
      summary: "Readiness probe",
      description: "200 when the DB is reachable and the system is unlocked; 503 (with a `status` reason) otherwise, to drain traffic.",
      responses: {
        200: { description: "Ready", content: { "application/json": { schema: resolver(z.object({ status: z.literal("ready") })) } } },
        503: { description: "Not ready", content: { "application/json": { schema: resolver(z.object({ status: z.enum(["locked", "no_db", "db_unavailable"]) })) } } },
      },
    }),
    async (c) => {
      if (c.get("encryption").isSystemLocked()) {
        c.status(503);
        return c.json({ status: "locked" });
      }
      const db = c.get("db");
      if (!db) {
        c.status(503);
        return c.json({ status: "no_db" });
      }
      try {
        await db.run(sql`SELECT 1`);
      }
      catch (err) {
        c.get("logger").error({ err }, "readiness probe: db ping failed");
        c.status(503);
        return c.json({ status: "db_unavailable" });
      }
      return c.json({ status: "ready" });
    },
  );

  router.get(
    "/system/version",
    describeRoute({
      tags: [TAGS.System],
      summary: "Build version and lode upgrade summary",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ commit: z.string(), buildTime: z.string(), version: z.string(), lode: z.unknown() }), "Build identifiers and lode upgrade status"),
        ...errors(401, 403),
      },
    }),
    authRequired,
    adminRequired,
    c => c.json({
      success: true,
      data: {
        ...BUILD_INFO,
        lode: getLodeSummary(),
      },
    }),
  );

  // Restart the running version via lode (also applies a pending lode.toml edit
  // — the relaunch re-reads it). Admin only; 409 when not under lode.
  router.post(
    "/system/lode/restart",
    describeRoute({
      tags: [TAGS.System],
      summary: "Restart via lode",
      description: "Bumps state.json `restart_nonce` so lode relaunches the current version (re-reading lode.toml). Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ status: z.literal("ok"), restartNonce: z.number() }), "Restart requested"),
        ...errors(401, 403, 409),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      const result = requestLodeRestart();
      if (result.status === "not_active")
        lodeNotActive();
      await auditLodeAction(c, "lode.restart", { restartNonce: result.restartNonce });
      return c.json({ success: true, data: { status: "ok", restartNonce: result.restartNonce } });
    },
  );

  // Request an up/down-grade by setting lode's `target` (a version or "latest").
  router.post(
    "/system/lode/update",
    describeRoute({
      tags: [TAGS.System],
      summary: "Update via lode",
      description: "Sets state.json `target` so lode resolves, downloads, verifies, and switches to the requested version. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ status: z.literal("ok"), target: z.string() }), "Update requested"),
        ...errors(401, 403, 409, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", lodeUpdateSchema),
    async (c) => {
      const { target } = c.req.valid("json");
      const result = requestLodeUpdate(target);
      if (result.status === "not_active")
        lodeNotActive();
      await auditLodeAction(c, "lode.update", { target: result.target });
      return c.json({ success: true, data: { status: "ok", target: result.target } });
    },
  );

  // Roll back to a version, or omit `version` to use lode's recorded last_good.
  router.post(
    "/system/lode/rollback",
    describeRoute({
      tags: [TAGS.System],
      summary: "Roll back via lode",
      description: "Sets `target` to the given version, else the recorded `last_good`, so lode switches back. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ status: z.literal("ok"), target: z.string() }), "Rollback requested"),
        ...errors(401, 403, 409, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", lodeRollbackSchema),
    async (c) => {
      const { version } = c.req.valid("json");
      const result = requestLodeRollback(version);
      if (result.status === "not_active")
        lodeNotActive();
      if (result.status === "no_target")
        throw new AppError("no rollback target: lode has not recorded a last-good version", 409, "LODE_NO_ROLLBACK_TARGET");
      await auditLodeAction(c, "lode.rollback", { target: result.target });
      return c.json({ success: true, data: { status: "ok", target: result.target } });
    },
  );

  // Set/clear the maintenance hold — lode stops (re)starting the process.
  router.post(
    "/system/lode/hold",
    describeRoute({
      tags: [TAGS.System],
      summary: "Set lode maintenance hold",
      description: "Sets state.json `hold` so lode will NOT (re)start the process (status \"held\"); clear with `hold:false`. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ status: z.literal("ok"), hold: z.boolean() }), "Hold updated"),
        ...errors(401, 403, 409, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", lodeHoldSchema),
    async (c) => {
      const { hold } = c.req.valid("json");
      const result = setLodeHold(hold);
      if (result.status === "not_active")
        lodeNotActive();
      await auditLodeAction(c, "lode.hold", { hold: result.hold });
      return c.json({ success: true, data: { status: "ok", hold: result.hold } });
    },
  );

  router.get(
    "/metrics",
    describeRoute({
      tags: [TAGS.System],
      summary: "Prometheus metrics",
      description: "Prometheus text exposition. Requires the `metrics` service token.",
      security: SECURITY.serviceToken,
      responses: {
        ...raw(200, "text/plain", "Prometheus exposition format"),
        ...errors(401, 403),
      },
    }),
    serviceTokenRequired("metrics"),
    (c) => {
      gaugeSet(
        "encryption_locked",
        "1 when the system is currently locked, 0 when unlocked.",
        c.get("encryption").isSystemLocked() ? 1 : 0,
      );
      return c.text(renderPrometheus(), 200, { "Content-Type": "text/plain; version=0.0.4" });
    },
  );

  router.get(
    "/system/upload-limits",
    describeRoute({
      tags: [TAGS.System],
      summary: "Upload limits",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          maxFileSize: z.number(),
          maxAttachmentsPerResource: z.number(),
          totalQuota: z.number().nullable(),
        }), "Effective upload limits"),
        ...errors(401),
      },
    }),
    authRequired,
    (c) => {
      const cfg = c.get("config");
      return c.json({
        success: true,
        data: {
          maxFileSize: cfg.MAX_UPLOAD_BYTES,
          maxAttachmentsPerResource: cfg.MAX_ATTACHMENTS_PER_RESOURCE,
          totalQuota: cfg.UPLOADS_TOTAL_BYTES > 0 ? cfg.UPLOADS_TOTAL_BYTES : null,
        },
      });
    },
  );

  return router;
}
