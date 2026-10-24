import type { AppDatabase } from "@/db";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit, auditMeta } from "@/modules/audit/audit.service";
import {
  getOwnedReference,
  listAttachmentsByOwner,
  makeAttachmentView,
  readUploadedFile,
  releaseReference,
  sendAttachment,
  uploadAndReference,
} from "@/modules/file";
import { mountItemCommentRoutes } from "@/modules/item/comment.routes";
import { NOOP_POLICY_LOGGER, policyContext } from "@/modules/policy";
import { AppError, ForbiddenError, NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, jsonPaged, raw, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { authRequired } from "@/shared/middleware/auth";
import { issueAccess } from "./issue.permission";
import {
  createIssue,
  getIssueByShortId,
  getUserById,
  listIssues,
  listMyIssues,
  resolveIssueItem,
  softDeleteIssue,
  updateIssue,
} from "./issue.service";

const createSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().min(1).optional(),
  dueDate: z.string().max(30).optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum([
    "open",
    "in_progress",
    "done",
    "cancelled",
  ]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  dueDate: z.string().max(30).nullable().optional(),
}).refine(d => Object.values(d).some(v => v !== undefined), {
  message: "At least one field must be provided",
});

const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum([
    "open",
    "in_progress",
    "done",
    "cancelled",
  ]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  creatorId: z.string(),
  assigneeId: z.string().nullable(),
  dueDate: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const attachmentViewSchema = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number(),
  mimetype: z.string(),
  createdAt: z.string(),
});

/** Resolve the `item` row behind an issue short id; 404 when absent. */
async function requireItem(db: AppDatabase, shortId: string) {
  const item = await resolveIssueItem(db, shortId);
  if (!item)
    throw new NotFoundError("Issue", shortId);
  return item;
}

export function issueRoutes() {
  const router = new Hono<AppEnv>();
  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/issues/*", authRequired);

  // ─── List ──────────────────────────────────────────────────────────
  router.get(
    "/issues",
    describeRoute({
      tags: [TAGS.Issue],
      summary: "List issues",
      description: "Paginated, filterable issues. Admins see all; others see issues they created or are assigned.",
      security: SECURITY.session,
      responses: {
        ...jsonPaged(issueSchema, "Issues"),
        ...errors(401),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const q = c.req.query("q");
      const status = c.req.query("status");
      const priority = c.req.query("priority");
      const assigneeId = c.req.query("assignee_id");
      const creatorId = c.req.query("creator_id");
      const page = Math.max(1, Math.floor(Number.parseInt(c.req.query("page") ?? "", 10)) || 1);
      const limit = Math.min(100, Math.max(1, Math.floor(Number.parseInt(c.req.query("limit") ?? "", 10)) || 20));

      const isAdmin = user.role === "admin";
      const result = isAdmin
        ? await listIssues(db, {
            q,
            status,
            priority,
            assigneeId,
            creatorId,
            page,
            limit,
          })
        : await listMyIssues(db, {
            userId: user.id,
            q,
            status,
            priority,
            page,
            limit,
          });

      return c.json({
        success: true,
        data: result.data,
        meta: { total: result.total, page, limit },
      });
    },
  );

  // ─── Create ────────────────────────────────────────────────────────
  router.post(
    "/issues",
    describeRoute({
      tags: [TAGS.Issue],
      summary: "Create issue",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(issueSchema, "Created issue"),
        ...errors(401, 404, 422),
      },
    }),
    validator("json", createSchema),
    async (c) => {
      const db = c.get("db");
      const body = c.req.valid("json");
      const actor = c.get("user")!;

      if (body.assigneeId) {
        const assignee = await getUserById(db, body.assigneeId);
        if (!assignee)
          throw new NotFoundError("User", body.assigneeId);
      }

      const issue = await createIssue(db, { ...body, creatorId: actor.id });

      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "issue.created",
        resourceType: "issue",
        resourceId: issue.id,
        resourceName: issue.title,
        ...(body.assigneeId
          ? {
              detail: { assigneeId: body.assigneeId },
            }
          : {}),
        ...auditMeta(c),
        result: "success",
      });

      if (body.assigneeId) {
        await audit(db, c.get("logger"), {
          actorId: actor.id,
          actorName: actor.name,
          action: "issue.assigned",
          resourceType: "issue",
          resourceId: issue.id,
          resourceName: issue.title,
          detail: { from: null, to: body.assigneeId },
          ...auditMeta(c),
          result: "success",
        });
      }

      return c.json({ success: true, data: issue }, 201);
    },
  );

  // ─── Detail ────────────────────────────────────────────────────────
  router.get(
    "/issues/:id",
    describeRoute({
      tags: [TAGS.Issue],
      summary: "Get issue",
      security: SECURITY.session,
      responses: {
        ...jsonOk(issueSchema, "Issue"),
        ...errors(401, 403, 404),
      },
    }),
    validator("param", z.object({
      id: z.string(),
    })),
    async (c) => {
      const db = c.get("db");
      const id = c.req.valid("param").id;
      const issue = await getIssueByShortId(db, id);
      if (!issue)
        throw new NotFoundError("Issue", id);
      await issueAccess.assert(policyContext(c)!, "issue:read", (await requireItem(db, id)).id);
      return c.json({ success: true, data: issue });
    },
  );

  // ─── Update ────────────────────────────────────────────────────────
  router.patch(
    "/issues/:id",
    describeRoute({
      tags: [TAGS.Issue],
      summary: "Update issue",
      description: "Admins and creators may update any field; assignees may update status only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(issueSchema, "Updated issue"),
        ...errors(401, 403, 404, 422),
      },
    }),
    validator("param", z.object({
      id: z.string(),
    })),
    validator("json", updateSchema),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.valid("param").id;
      const existing = await getIssueByShortId(db, id);
      if (!existing)
        throw new NotFoundError("Issue", id);

      const body = c.req.valid("json");
      const ctx = policyContext(c)!;
      const itemId = (await requireItem(db, id)).id;
      // Whole-record edits need `editor`; a status-only payload is the
      // handler's job and is also open to `assignee`.
      const statusOnly = Object.keys(body).every(k => k === "status");
      const allowed = await issueAccess.can(ctx, "issue:update", itemId)
        || (statusOnly && await issueAccess.can(ctx, "issue:transition", itemId));
      if (!allowed) {
        throw statusOnly
          ? new ForbiddenError()
          : new AppError("Assignees can only update status", 403, "FORBIDDEN");
      }

      if (body.assigneeId) {
        const assignee = await getUserById(db, body.assigneeId);
        if (!assignee)
          throw new NotFoundError("User", body.assigneeId);
      }

      const updated = await updateIssue(db, id, body);

      const detail: Record<string, unknown> = {};
      if (body.status && body.status !== existing.status) {
        detail.previousStatus = existing.status;
        detail.newStatus = body.status;
      }

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "issue.updated",
        resourceType: "issue",
        resourceId: id,
        resourceName: existing.title,
        ...(Object.keys(detail).length > 0
          ? { detail }
          : {}),
        ...auditMeta(c),
        result: "success",
      });

      if (body.status && body.status !== existing.status) {
        await audit(db, c.get("logger"), {
          actorId: user.id,
          actorName: user.name,
          action: "issue.status_changed",
          resourceType: "issue",
          resourceId: id,
          resourceName: existing.title,
          detail: { previous: existing.status, new: body.status },
          ...auditMeta(c),
          result: "success",
        });
      }

      if (body.assigneeId !== undefined && body.assigneeId !== existing.assigneeId) {
        await audit(db, c.get("logger"), {
          actorId: user.id,
          actorName: user.name,
          action: "issue.assigned",
          resourceType: "issue",
          resourceId: id,
          resourceName: existing.title,
          detail: { from: existing.assigneeId, to: body.assigneeId },
          ...auditMeta(c),
          result: "success",
        });
      }

      return c.json({ success: true, data: updated });
    },
  );

  // ─── Delete (soft) ─────────────────────────────────────────────────
  router.delete(
    "/issues/:id",
    describeRoute({
      tags: [TAGS.Issue],
      summary: "Delete issue",
      description: "Soft delete. Admins and creators only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Deleted"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id");
      const existing = await getIssueByShortId(db, id);
      if (!existing)
        throw new NotFoundError("Issue", id);
      await issueAccess.assert(policyContext(c)!, "issue:delete", (await requireItem(db, id)).id);
      await softDeleteIssue(db, id);
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "issue.deleted",
        resourceType: "issue",
        resourceId: id,
        resourceName: existing.title,
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );

  // ─── Attachments (delegating to mod-file) ─────────────────────────
  router.post(
    "/issues/:id/attachments",
    describeRoute({
      tags: [TAGS.Issue],
      summary: "Upload issue attachment",
      description: "Multipart form upload (`file` field).",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(attachmentViewSchema, "Uploaded attachment"),
        ...errors(400, 401, 403, 404, 413),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id");
      const issue = await getIssueByShortId(db, id);
      if (!issue)
        throw new NotFoundError("Issue", id);
      await issueAccess.assert(policyContext(c)!, "issue:manage_attachments", (await requireItem(db, id)).id);
      const item = await resolveIssueItem(db, id);
      if (!item)
        throw new NotFoundError("Issue", id);

      const config = c.get("config");
      const file = await readUploadedFile(c);

      const { reference, file: uploaded } = await uploadAndReference(db, config, {
        file,
        ownerType: "item_attachment",
        ownerId: item.id,
        uploadedBy: user.id,
      });
      const view = makeAttachmentView(reference, uploaded);

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "issue.attachment_uploaded",
        resourceType: "issue",
        resourceId: id,
        resourceName: issue.title,
        detail: { attachmentId: reference.id, filename: file.name, size: file.size },
        ...auditMeta(c),
        result: "success",
      });

      return c.json({ success: true, data: view }, 201);
    },
  );

  router.get(
    "/issues/:id/attachments",
    describeRoute({
      tags: [TAGS.Issue],
      summary: "List issue attachments",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(attachmentViewSchema), "Attachments"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const id = c.req.param("id");
      const issue = await getIssueByShortId(db, id);
      if (!issue)
        throw new NotFoundError("Issue", id);
      await issueAccess.assert(policyContext(c)!, "issue:read", (await requireItem(db, id)).id);
      const item = await resolveIssueItem(db, id);
      if (!item)
        throw new NotFoundError("Issue", id);
      const data = await listAttachmentsByOwner(db, "item_attachment", item.id);
      return c.json({ success: true, data });
    },
  );

  router.get(
    "/issues/:id/attachments/:aid",
    describeRoute({
      tags: [TAGS.Issue],
      summary: "Download issue attachment",
      description: "Streams the attachment binary. `?inline=true` serves it inline.",
      security: SECURITY.session,
      responses: {
        ...raw(200, "application/octet-stream", "Attachment content"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const id = c.req.param("id");
      const aid = c.req.param("aid");
      const issue = await getIssueByShortId(db, id);
      if (!issue)
        throw new NotFoundError("Issue", id);
      await issueAccess.assert(policyContext(c)!, "issue:download", (await requireItem(db, id)).id);
      const item = await resolveIssueItem(db, id);
      if (!item)
        throw new NotFoundError("Issue", id);
      const ref = await getOwnedReference(db, aid, "item_attachment", item.id);
      return await sendAttachment(c, ref);
    },
  );

  router.delete(
    "/issues/:id/attachments/:aid",
    describeRoute({
      tags: [TAGS.Issue],
      summary: "Delete issue attachment",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Deleted"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id");
      const aid = c.req.param("aid");
      const issue = await getIssueByShortId(db, id);
      if (!issue)
        throw new NotFoundError("Issue", id);
      await issueAccess.assert(policyContext(c)!, "issue:manage_attachments", (await requireItem(db, id)).id);
      const item = await resolveIssueItem(db, id);
      if (!item)
        throw new NotFoundError("Issue", id);
      const ref = await getOwnedReference(db, aid, "item_attachment", item.id);
      if (user.role !== "admin" && issue.creatorId !== user.id && ref.createdBy !== user.id) {
        throw new ForbiddenError();
      }
      await releaseReference(db, c.get("config"), { referenceId: aid });
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "issue.attachment_deleted",
        resourceType: "issue",
        resourceId: id,
        resourceName: issue.title,
        detail: { attachmentId: aid, filename: ref.filename },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );
  // ─── Comments + attachments (delegated to mod-item) ───────────────
  mountItemCommentRoutes(router, {
    routePrefix: "/issues",
    resourceType: "issue",
    async resolve(db, idParam) {
      const issue = await getIssueByShortId(db, idParam);
      if (!issue)
        return null;
      const item = await resolveIssueItem(db, idParam);
      if (!item)
        return null;
      return {
        item,
        resource: issue,
        externalId: idParam,
        resourceName: issue.title,
      };
    },
    async permissions(db, user, subject) {
      // Same shape as document.routes: a minimal context so the framework
      // (and its per-request cache) answers, not a hand-rolled column rule.
      const ctx = {
        db,
        logger: NOOP_POLICY_LOGGER,
        actor: { id: user.id, type: "user", role: user.role },
      };
      const canRead = await issueAccess.can(ctx, "issue:read", subject.item.id);
      const isHandler = await issueAccess.can(ctx, "issue:transition", subject.item.id);
      return {
        canRead,
        canPost: canRead,
        includeInternal: isHandler,
        canDelete: authorId => user.role === "admin" || authorId === user.id,
      };
    },
  });

  return router;
}
