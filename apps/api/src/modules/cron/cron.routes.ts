import type { Context } from "hono";
import type { TaskConfig } from "./executor";
import type { AppEnv } from "@/shared/lib/types";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import { cronJobLogs, cronJobs } from "@/modules/cron/schema";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError, NotFoundError } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";
import { describeRoute, errors, jsonCreated, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import {
  getAction,
  getActionsCatalog,
  validateActionConfig,
} from "./actions";
import { isValidCron, normalizeCron, SUPPORTED_CRON_FORMATS } from "./cron-format";
import { getScheduler } from "./cron.service";
import { executeTask } from "./executor";
import { serializeJob } from "./serialize";

const createJobSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[\w-]+$/, "Name must be alphanumeric, underscore, or hyphen only"),
  cron: z.string().min(1).max(200),
  action: z.string().min(1).max(100),
  config: z.record(z.string(), z.unknown()).optional(),
  // Retry budget: N consecutive failures flip `enabled=false`. `0`
  // disables auto-pause for jobs that must keep retrying. Cap matches
  // the executor's intent (the limit is the LIMIT clause on the recent
  // logs read; anything wildly large just wastes pages on every retry
  // check). 100 is a generous ceiling.
  maxConsecutiveFailures: z.coerce.number().int().min(0).max(100).optional(),
});

const listQuerySchema = z.object({
  // Lifecycle filter: `deleted=only` surfaces tombstones; `deleted=true`
  // includes them; otherwise (default) only live rows are returned.
  deleted: z.enum(["false", "true", "only"]).optional(),
  // Filter by the most-recent run's outcome. Matches the value stored
  // in `cron_job_logs.status`; "running" is excluded from the SPA's
  // dropdown but accepted here for symmetry / debugging.
  lastStatus: z.enum(["success", "failed", "running"]).optional(),
  // Filter by `cron_jobs.task_type` — the action's category captured
  // at create time. Free-form string because downstream apps can
  // register their own categories (`registerAction(..., { category })`).
  taskType: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

/**
 * Resolve the query string's `deleted` filter to the boolean the WHERE
 * clause needs. `null` = no constraint; `boolean` = the row must
 * equal. Exported so the SPA's filter wiring can be tested without
 * booting the HTTP stack.
 */
export function resolveDeletedFlag(value: "false" | "true" | "only" | undefined): boolean | null {
  if (value === "only")
    return true;
  if (value === "true")
    return null;
  return false;
}

const logsQuerySchema = z.object({
  status: z.enum(["running", "success", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

// Serialized cron job shape returned by `serializeJob`; documented loosely
// because the serializer augments the Drizzle row with live scheduler state.
const jobSchema = z.object({
  id: z.string(),
  name: z.string(),
  cron: z.string(),
  taskType: z.string(),
  enabled: z.boolean(),
}).loose();

const jobLogSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  status: z.enum(["running", "success", "failed"]),
  durationMs: z.number().nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
}).loose();

function auditMeta(c: Context) {
  return {
    ip: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? "unknown",
  };
}

export function cronRoutes() {
  const router = new Hono<AppEnv>();

  // Admin-only: operators that can edit schedules can also execute
  // arbitrary actions, so the gate matches the blast radius of the
  // route. Handlers below treat `getScheduler()` as nullable — when
  // the scheduler is not running, DB writes still land and the Baker
  // side effects no-op.
  // Scoped to this router's own prefix on purpose. `protectedRoutes()`
  // mounts every module router on "/", and Hono merges a sub-router's
  // `use("*")` into the parent, where it applies to every router mounted
  // afterwards — a `use("*", adminRequired)` here made the generic
  // /files/* download path admin-only for everyone.
  router.use("/cron/*", authRequired, adminRequired);

  async function findJob(c: Context<AppEnv>, identifier: string) {
    const db = c.get("db");
    const byId = await db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.isDeleted, false), eq(cronJobs.id, identifier)))
      .get();
    if (byId)
      return byId;

    const byName = await db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.isDeleted, false), eq(cronJobs.name, identifier)))
      .get();
    return byName ?? null;
  }

  // GET /cron/actions — registered action catalog + cron-format reference + scheduler state.
  router.get(
    "/cron/actions",
    describeRoute({
      tags: [TAGS.Cron],
      summary: "List cron actions",
      description: "Registered action catalog, cron-format reference, and scheduler state. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          actions: z.array(z.unknown()),
          cronFormats: z.array(z.string()),
          schedulerEnabled: z.boolean(),
        }), "Action catalog"),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      return c.json({
        success: true,
        data: {
          actions: getActionsCatalog(),
          cronFormats: SUPPORTED_CRON_FORMATS,
          // SPA renders a status hint when this is false. Driven by the
          // singleton handle so a future hot-toggle (start/stop without
          // process restart) flips the flag immediately.
          schedulerEnabled: getScheduler() !== null,
        },
      });
    },
  );

  // GET /cron/jobs — cursor-paginated listing
  router.get(
    "/cron/jobs",
    describeRoute({
      tags: [TAGS.Cron],
      summary: "List cron jobs",
      description: "Cursor-paginated listing with lifecycle, status, and task-type filters. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          jobs: z.array(jobSchema),
          hasMore: z.boolean(),
          nextCursor: z.string().nullable(),
        }), "Cron jobs"),
        ...errors(401, 403, 422),
      },
    }),
    validator("query", listQuerySchema),
    async (c) => {
      const db = c.get("db");
      const q = c.req.valid("query");
      const pageLimit = q.limit ?? 20;

      const deletedFlag = resolveDeletedFlag(q.deleted);
      const conditions = [];
      if (deletedFlag !== null)
        conditions.push(eq(cronJobs.isDeleted, deletedFlag));
      if (q.taskType !== undefined)
        conditions.push(eq(cronJobs.taskType, q.taskType));
      if (q.cursor)
        conditions.push(lt(cronJobs.id, q.cursor));
      if (q.lastStatus !== undefined) {
        // Correlated subquery: keep the job iff its newest log row (by
        // ULID order, which is creation-time monotonic) matches the
        // requested status. Jobs with no logs at all are excluded from
        // every `lastStatus` filter because the inner SELECT is NULL.
        conditions.push(sql`(
        SELECT ${cronJobLogs.status} FROM ${cronJobLogs}
        WHERE ${cronJobLogs.jobId} = ${cronJobs.id}
        ORDER BY ${cronJobLogs.id} DESC
        LIMIT 1
      ) = ${q.lastStatus}`);
      }

      const rows = await db
        .select()
        .from(cronJobs)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(cronJobs.createdAt))
        .limit(pageLimit + 1)
        .all();

      const hasMore = rows.length > pageLimit;
      const page = hasMore ? rows.slice(0, pageLimit) : rows;
      const nextCursor = hasMore ? page.at(-1)!.id : null;

      const scheduler = getScheduler();
      const data = await Promise.all(page.map(r => serializeJob(db, scheduler?.baker ?? null, r)));

      return c.json({
        success: true,
        data: { jobs: data, hasMore, nextCursor },
      });
    },
  );

  // POST /cron/jobs — create
  router.post(
    "/cron/jobs",
    describeRoute({
      tags: [TAGS.Cron],
      summary: "Create cron job",
      description: "Register a new scheduled job. Admin only. Rejects malformed cron, duplicate names, and unknown actions.",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(jobSchema, "Created cron job"),
        ...errors(400, 401, 403, 409, 422, 500),
      },
    }),
    validator("json", createJobSchema),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const body = c.req.valid("json");

      if (!isValidCron(body.cron)) {
        throw new AppError(
          `Invalid cron expression: "${body.cron}". Supported formats: ${SUPPORTED_CRON_FORMATS.join("; ")}`,
          400,
          "INVALID_CRON",
        );
      }
      const normalized = normalizeCron(body.cron);

      const existing = await findJob(c, body.name);
      if (existing) {
        throw new AppError(`Job with name "${body.name}" already exists`, 409, "JOB_NAME_CONFLICT");
      }

      const taskConfig: TaskConfig = { ...(body.config ?? {}), action: body.action };
      const validationError = await validateActionConfig(body.action, taskConfig);
      if (validationError) {
        throw new AppError(validationError, 400, "INVALID_ACTION_CONFIG");
      }

      const actionDef = getAction(body.action);
      const id = nanoid();
      const insertValues: typeof cronJobs.$inferInsert = {
        id,
        name: body.name,
        cron: normalized,
        taskType: actionDef?.spec.category ?? "custom",
        taskConfig: JSON.stringify(taskConfig),
        enabled: true,
        ...(body.maxConsecutiveFailures !== undefined ? { maxConsecutiveFailures: body.maxConsecutiveFailures } : {}),
      };
      await db.insert(cronJobs).values(insertValues).run();

      const row = await db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
      if (!row)
        throw new AppError("Failed to create job", 500, "INTERNAL_ERROR");

      const scheduler = getScheduler();
      // When the scheduler isn't running the row still lands in the DB
      // and is picked up the next time `startCron` runs.
      await scheduler?.syncJob(body.name);

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "cron.job.created",
        resourceType: "cron_job",
        resourceId: id,
        resourceName: body.name,
        detail: {
          cron: normalized,
          action: body.action,
          maxConsecutiveFailures: row.maxConsecutiveFailures,
        },
        ...auditMeta(c),
        result: "success",
      });

      const data = await serializeJob(db, scheduler?.baker ?? null, row);
      return c.json({ success: true, data }, 201);
    },
  );

  // DELETE /cron/jobs/:id — soft delete (also detaches from Baker)
  router.delete(
    "/cron/jobs/:id",
    describeRoute({
      tags: [TAGS.Cron],
      summary: "Delete cron job",
      description: "Soft-delete a job and detach it from the scheduler. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ deleted: z.literal(true), name: z.string() }), "Deleted cron job"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const identifier = c.req.param("id");
      const row = await findJob(c, identifier);
      if (!row)
        throw new NotFoundError("Cron job", identifier);

      await db.update(cronJobs)
        .set({ isDeleted: true, enabled: false })
        .where(eq(cronJobs.id, row.id))
        .run();

      const scheduler = getScheduler();
      if (scheduler) {
        try {
          scheduler.baker.stop(row.name);
          scheduler.baker.remove(row.name);
        }
        catch {
          // Not loaded in scheduler.
        }
      }

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "cron.job.deleted",
        resourceType: "cron_job",
        resourceId: row.id,
        resourceName: row.name,
        ...auditMeta(c),
        result: "success",
      });

      return c.json({ success: true, data: { deleted: true, name: row.name } });
    },
  );

  // GET /cron/jobs/:id/logs — cursor-paginated run history
  router.get(
    "/cron/jobs/:id/logs",
    describeRoute({
      tags: [TAGS.Cron],
      summary: "List cron job logs",
      description: "Cursor-paginated run history for a single job, optionally filtered by status. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          jobName: z.string(),
          logs: z.array(jobLogSchema),
          hasMore: z.boolean(),
          nextCursor: z.string().nullable(),
        }), "Cron job logs"),
        ...errors(401, 403, 404, 422),
      },
    }),
    validator("query", logsQuerySchema),
    async (c) => {
      const db = c.get("db");
      const identifier = c.req.param("id");
      const q = c.req.valid("query");
      const pageLimit = q.limit ?? 20;

      const job = await db
        .select()
        .from(cronJobs)
        .where(eq(cronJobs.id, identifier))
        .get();

      if (!job)
        throw new NotFoundError("Cron job", identifier);

      const conditions = [eq(cronJobLogs.jobId, job.id)];
      if (q.status)
        conditions.push(eq(cronJobLogs.status, q.status));
      if (q.cursor)
        conditions.push(lt(cronJobLogs.id, q.cursor));

      const logs = await db
        .select()
        .from(cronJobLogs)
        .where(and(...conditions))
        .orderBy(desc(cronJobLogs.id))
        .limit(pageLimit + 1)
        .all();

      const hasMore = logs.length > pageLimit;
      const page = hasMore ? logs.slice(0, pageLimit) : logs;
      const nextCursor = hasMore ? page.at(-1)!.id : null;

      return c.json({
        success: true,
        data: {
          jobName: job.name,
          logs: page,
          hasMore,
          nextCursor,
        },
      });
    },
  );

  // POST /cron/jobs/:id/trigger — manual run (rejects when already running)
  router.post(
    "/cron/jobs/:id/trigger",
    describeRoute({
      tags: [TAGS.Cron],
      summary: "Trigger cron job",
      description: "Manually execute a job once, bypassing the schedule. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          triggered: z.literal(true),
          name: z.string(),
          log: z.object({
            id: z.string(),
            status: z.string(),
            durationMs: z.number().nullable(),
            result: z.string().nullable(),
            error: z.string().nullable(),
          }).nullable(),
        }), "Triggered cron job"),
        ...errors(401, 403, 404, 500),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const identifier = c.req.param("id");
      const row = await findJob(c, identifier);
      if (!row)
        throw new NotFoundError("Cron job", identifier);

      const scheduler = getScheduler();
      // No pre-flight "is it executing?" check: cronbake's `getStatus` returns
      // `"running"` for any baked-and-active job (the scheduler timer is on),
      // not "mid execution". Manual trigger bypasses Baker's overrunProtection
      // by design — operators accept that a hand-triggered run may overlap
      // with a scheduled tick. The handler itself is the right place to lock
      // if a task truly cannot run concurrently.

      let config: TaskConfig;
      try {
        config = JSON.parse(row.taskConfig) as TaskConfig;
      }
      catch {
        throw new AppError(`Job "${row.name}" has corrupt taskConfig`, 500, "CORRUPT_CONFIG");
      }

      // Without a scheduler the auto-pause path still sets
      // `enabled=false` in DB; the Baker `pause(...)` call is a no-op.
      const executorDeps = scheduler
        ? {
            db,
            logger: c.get("logger"),
            config: c.get("config"),
            onAutoPause: (jobName: string) => {
              try {
                scheduler.baker.pause(jobName);
              }
              catch {}
            },
          }
        : { db, logger: c.get("logger"), config: c.get("config") };
      const logId = await executeTask(
        executorDeps,
        row.id,
        row.name,
        config,
        row.maxConsecutiveFailures,
      );

      const log = await db.select().from(cronJobLogs).where(eq(cronJobLogs.id, logId)).get();

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "cron.job.triggered",
        resourceType: "cron_job",
        resourceId: row.id,
        resourceName: row.name,
        detail: { logId, status: log?.status },
        ...auditMeta(c),
        result: "success",
      });

      return c.json({
        success: true,
        data: {
          triggered: true,
          name: row.name,
          log: log
            ? { id: log.id, status: log.status, durationMs: log.durationMs, result: log.result, error: log.error }
            : null,
        },
      });
    },
  );

  // POST /cron/jobs/:id/pause — disable + stop ticking
  router.post(
    "/cron/jobs/:id/pause",
    describeRoute({
      tags: [TAGS.Cron],
      summary: "Pause cron job",
      description: "Disable a job and stop it ticking in the scheduler. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ paused: z.literal(true), name: z.string() }), "Paused cron job"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const identifier = c.req.param("id");
      const row = await findJob(c, identifier);
      if (!row)
        throw new NotFoundError("Cron job", identifier);

      await db.update(cronJobs).set({ enabled: false }).where(eq(cronJobs.id, row.id)).run();
      const scheduler = getScheduler();
      if (scheduler) {
        try {
          scheduler.baker.pause(row.name);
        }
        catch {}
      }

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "cron.job.paused",
        resourceType: "cron_job",
        resourceId: row.id,
        resourceName: row.name,
        ...auditMeta(c),
        result: "success",
      });

      return c.json({ success: true, data: { paused: true, name: row.name } });
    },
  );

  // POST /cron/jobs/:id/resume — re-enable + re-sync into Baker
  router.post(
    "/cron/jobs/:id/resume",
    describeRoute({
      tags: [TAGS.Cron],
      summary: "Resume cron job",
      description: "Re-enable a job and re-sync it into the scheduler. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ resumed: z.literal(true), name: z.string() }), "Resumed cron job"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const identifier = c.req.param("id");
      const row = await findJob(c, identifier);
      if (!row)
        throw new NotFoundError("Cron job", identifier);

      await db.update(cronJobs).set({ enabled: true }).where(eq(cronJobs.id, row.id)).run();
      const scheduler = getScheduler();
      await scheduler?.syncJob(row.name);

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "cron.job.resumed",
        resourceType: "cron_job",
        resourceId: row.id,
        resourceName: row.name,
        ...auditMeta(c),
        result: "success",
      });

      return c.json({ success: true, data: { resumed: true, name: row.name } });
    },
  );

  return router;
}
