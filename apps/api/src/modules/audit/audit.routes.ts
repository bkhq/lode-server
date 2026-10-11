import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonOk, jsonPaged, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { getAuditEventById, listAuditEvents } from "./audit.service";

const auditEventSchema = z.object({
  id: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  resourceName: z.string(),
  detail: z.string().nullable(),
  ip: z.string(),
  userAgent: z.string(),
  result: z.enum(["success", "failure"]),
  createdAt: z.string(),
});

const isoDatetime = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/, "Invalid ISO 8601 datetime");
const RE_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Audit `created_at` is stored as a full ISO timestamp. When the operator
 * filters by a date-only `to` (e.g. `to=2026-05-10`), a naive `lte` against
 * the row string compares lexically against `2026-05-10T...Z` and excludes
 * the entire 2026-05-10 day. Normalise to the day's last instant so the
 * inclusive intent matches what the UI shows.
 */
function normaliseToBoundary(value: string | undefined): string | undefined {
  if (value === undefined)
    return undefined;
  return RE_DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value;
}

const auditQuerySchema = z.object({
  actor_id: z.string().optional(),
  action: z.string().optional(),
  resource_type: z.string().optional(),
  resource_id: z.string().optional(),
  result: z.enum(["success", "failure"]).optional(),
  from: isoDatetime.optional(),
  to: isoDatetime.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function auditRoutes() {
  const router = new Hono<AppEnv>();

  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/audit/*", authRequired);

  router.get(
    "/audit",
    describeRoute({
      tags: [TAGS.Audit],
      summary: "List audit events",
      description: "Paginated, filterable audit log. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonPaged(auditEventSchema, "Audit events"),
        ...errors(401, 403, 422),
      },
    }),
    adminRequired,
    validator("query", auditQuerySchema),
    async (c) => {
      const db = c.get("db");
      const q = c.req.valid("query");

      const { data, total } = await listAuditEvents(db, {
        actorId: q.actor_id,
        action: q.action,
        resourceType: q.resource_type,
        resourceId: q.resource_id,
        result: q.result,
        from: q.from,
        to: normaliseToBoundary(q.to),
        page: q.page,
        limit: q.limit,
      });

      return c.json({
        success: true,
        data,
        meta: {
          total,
          page: q.page,
          limit: q.limit,
        },
      });
    },
  );

  router.get(
    "/audit/:id",
    describeRoute({
      tags: [TAGS.Audit],
      summary: "Get audit event",
      security: SECURITY.session,
      responses: {
        ...jsonOk(auditEventSchema, "Audit event"),
        ...errors(401, 403, 404),
      },
    }),
    adminRequired,
    validator("param", z.object({ id: z.string() })),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const event = await getAuditEventById(db, id);
      if (!event) {
        throw new NotFoundError("Audit event", id);
      }
      return c.json({ success: true, data: event });
    },
  );

  return router;
}
