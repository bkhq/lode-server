import type { Context } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { listActiveUsers } from "@/modules/account/users/users.service";
import { audit, auditMeta } from "@/modules/audit/audit.service";
import {
  getOwnedReference,
  listAttachmentsByOwner,
  makeAttachmentView,
  readUploadedFile,
  releaseAllByOwner,
  releaseReference,
  sendAttachment,
  uploadAndReference,
} from "@/modules/file";
import { mountItemCommentRoutes } from "@/modules/item/comment.routes";
import { NOOP_POLICY_LOGGER, policyContext } from "@/modules/policy";
import { AppError, NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, jsonPaged, raw, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { authRequired } from "@/shared/middleware/auth";
import { documentAccess } from "./document.permission";
import {
  addDocumentShare,
  createDocument,
  getDocumentById,
  getDocumentShareById,
  getDocumentTreeForUser,
  isVersionConflict,
  listAllGroups,
  listAllTags,
  listDescendantIds,
  listDocuments,
  listDocumentSharesWithInheritance,
  listMyDocuments,
  removeDocumentShare,
  resolveDocumentItem,
  softDeleteDocument,
  updateDocument,
} from "./document.service";

const tagSchema = z.string().min(1).max(50).regex(/^[\w-]+$/);

const createSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().max(50000).optional(),
  tags: z.array(tagSchema).max(20).optional(),
  parentId: z.string().nullable().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().max(50000).optional(),
  tags: z.array(tagSchema).max(20).optional(),
  parentId: z.string().nullable().optional(),
  commentsLocked: z.boolean().optional(),
  version: z.number().int().nonnegative(),
}).refine(d => Object.entries(d).some(([k, v]) => k !== "version" && v !== undefined), {
  message: "At least one mutable field must be provided",
});

const moveSchema = z.object({
  parentId: z.string().nullable(),
});

const documentSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string().nullable(),
  tags: z.array(z.string()),
  parentId: z.string().nullable(),
  commentsLocked: z.boolean(),
  creatorId: z.string(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

async function assertMoveTargetAllowed(
  c: Context<AppEnv>,
  movingShortId: string,
  targetParentShortId: string | null,
) {
  if (targetParentShortId === null)
    return;
  if (targetParentShortId === movingShortId)
    throw new AppError("A document cannot be its own parent", 400, "INVALID_MOVE");

  await assertParentTargetAllowed(c, targetParentShortId);

  const descendants = await listDescendantIds(c.get("db"), movingShortId);
  if (descendants.includes(targetParentShortId)) {
    throw new AppError("Cannot move a document under its own descendant", 400, "INVALID_MOVE");
  }
}

async function assertParentTargetAllowed(
  c: Context<AppEnv>,
  targetParentShortId: string | null | undefined,
) {
  if (!targetParentShortId)
    return;

  const target = await resolveDocumentItem(c.get("db"), targetParentShortId);
  if (!target)
    throw new NotFoundError("Document", targetParentShortId);

  const ctx = policyContext(c)!;
  await documentAccess.assert(ctx, "document:update", target.id);
}

export function documentRoutes() {
  // Pure Hono. Permission enforcement comes from the global
  // `policyMiddleware` mounted in `app.ts`, driven by the route table
  // declared in `document.permission.ts`.
  const router = new Hono<AppEnv>();
  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/documents/*", authRequired);

  router.get(
    "/documents",
    describeRoute({
      tags: [TAGS.Document],
      summary: "List documents",
      description: "Paginated, filterable documents. Admins see all; others see their own/shared documents.",
      security: SECURITY.session,
      responses: {
        ...jsonPaged(documentSchema, "Documents"),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const q = c.req.query("q");
      const tag = c.req.query("tag");
      const creatorId = c.req.query("creator_id");
      const page = Math.max(1, Math.floor(Number.parseInt(c.req.query("page") ?? "", 10)) || 1);
      const limit = Math.min(100, Math.max(1, Math.floor(Number.parseInt(c.req.query("limit") ?? "", 10)) || 20));

      const isAdmin = user.role === "admin";
      const result = isAdmin
        ? await listDocuments(db, { q, tag, creatorId, page, limit })
        : await listMyDocuments(db, { userId: user.id, q, tag, page, limit });

      return c.json({
        success: true,
        data: result.data,
        meta: { total: result.total, page, limit },
      });
    },
  );

  router.get(
    "/documents/tree",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Document tree",
      description: "Hierarchical document tree scoped to the current user.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Document tree"),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const data = await getDocumentTreeForUser(db, user);
      return c.json({ success: true, data });
    },
  );

  router.get(
    "/documents/tags",
    describeRoute({
      tags: [TAGS.Document],
      summary: "List document tags",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(z.string()), "Tags"),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const tags = await listAllTags(db);
      return c.json({ success: true, data: tags });
    },
  );

  router.get(
    "/documents/users",
    describeRoute({
      tags: [TAGS.Document],
      summary: "List active users",
      description: "Active users available as document share targets.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Users"),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const data = await listActiveUsers(db);
      return c.json({ success: true, data });
    },
  );

  router.get(
    "/documents/groups",
    describeRoute({
      tags: [TAGS.Document],
      summary: "List groups",
      description: "Groups available as document share targets.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Groups"),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const data = await listAllGroups(db);
      return c.json({ success: true, data });
    },
  );

  router.post(
    "/documents",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Create document",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(documentSchema, "Document created"),
        ...errors(401, 403, 404, 422),
      },
    }),
    validator("json", createSchema),
    async (c) => {
      const db = c.get("db");
      const body = c.req.valid("json");
      const actor = c.get("user")!;
      await assertParentTargetAllowed(c, body.parentId);
      const doc = await createDocument(db, { ...body, creatorId: actor.id });
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "document.created",
        resourceType: "document",
        resourceId: doc.id,
        resourceName: doc.title,
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: doc }, 201);
    },
  );

  router.get(
    "/documents/:id",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Get document",
      security: SECURITY.session,
      responses: {
        ...jsonOk(documentSchema, "Document"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const id = c.req.param("id")!;
      const doc = await getDocumentById(db, id);
      if (!doc)
        throw new NotFoundError("Document", id);
      // Defense in depth: the global policyMiddleware already gates this,
      // but it falls through when the route-binding registry desyncs or
      // the id doesn't resolve there. Re-assert in-handler so object-level
      // authz never depends solely on the registry. Admin short-circuits
      // via the `bypass` hook inside `can()`.
      await documentAccess.assert(policyContext(c)!, "document:read", doc.id);
      return c.json({ success: true, data: doc });
    },
  );

  router.patch(
    "/documents/:id",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Update document",
      description: "Optimistic-concurrency update (requires `version`). 409 on version conflict.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(documentSchema, "Document updated"),
        ...errors(401, 403, 404, 409, 422),
      },
    }),
    validator("json", updateSchema),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id")!;
      const existing = await getDocumentById(db, id);
      if (!existing)
        throw new NotFoundError("Document", id);

      const body = c.req.valid("json");

      if (body.parentId !== undefined && body.parentId !== existing.parentId) {
        await assertMoveTargetAllowed(c, id, body.parentId);
      }

      // Field-level write policy: `commentsLocked` requires `owner` even
      // though the route action `document:update` admits editors. Letting
      // the framework reject the unauthorised field keeps the lock rule in
      // one place — the resource definition — rather than re-stating it
      // here every time the patch surface changes.
      const ctx = policyContext(c)!;
      const item = await resolveDocumentItem(db, id);
      if (!item)
        throw new NotFoundError("Document", id);
      const { version: expectedVersion, ...mutable } = body;
      const safe = await documentAccess.filterWritable(ctx, item.id, mutable, { onForbidden: "reject" });

      const updated = await updateDocument(db, id, { ...safe, expectedVersion });
      if (!updated)
        throw new NotFoundError("Document", id);
      if (isVersionConflict(updated)) {
        return c.json(
          {
            success: false,
            error: { code: "VERSION_CONFLICT", message: "Document was modified by another writer" },
            data: updated.current,
          },
          409,
        );
      }

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "document.updated",
        resourceType: "document",
        resourceId: id,
        resourceName: existing.title,
        ...auditMeta(c),
        result: "success",
      });

      return c.json({ success: true, data: updated });
    },
  );

  router.patch(
    "/documents/:id/move",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Move document",
      description: "Reparent a document (and its subtree) under a new parent, or to root with `parentId: null`.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(documentSchema, "Document moved"),
        ...errors(400, 401, 403, 404, 422),
      },
    }),
    validator("json", moveSchema),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id")!;
      const existing = await getDocumentById(db, id);
      if (!existing)
        throw new NotFoundError("Document", id);

      const body = c.req.valid("json");
      await assertMoveTargetAllowed(c, id, body.parentId);

      const moved = await updateDocument(db, id, { parentId: body.parentId });
      if (!moved || isVersionConflict(moved))
        throw new NotFoundError("Document", id);

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "document.updated",
        resourceType: "document",
        resourceId: id,
        resourceName: existing.title,
        detail: {
          moved: { from: existing.parentId, to: body.parentId },
        },
        ...auditMeta(c),
        result: "success",
      });

      return c.json({ success: true, data: moved });
    },
  );

  router.delete(
    "/documents/:id",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Delete document",
      description: "Soft-delete a document and its subtree, releasing attachments.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Document deleted"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id")!;
      const existing = await getDocumentById(db, id);
      if (!existing)
        throw new NotFoundError("Document", id);
      // Defense in depth (see GET /documents/:id): never let a subtree
      // delete depend solely on the global policy registry.
      const targetItem = await resolveDocumentItem(db, id);
      if (!targetItem)
        throw new NotFoundError("Document", id);
      await documentAccess.assert(policyContext(c)!, "document:delete", targetItem.id);

      const descendantIds = await listDescendantIds(db, id);
      const descendantRows = await Promise.all(descendantIds.map(d => getDocumentById(db, d)));

      // Release every attachment in the subtree before stamping deleted_at —
      // refcounts drain so the async GC reclaims any blobs that were only
      // referenced by the deleted documents.
      const item = await resolveDocumentItem(db, id);
      if (item)
        await releaseAllByOwner(db, c.get("config"), "item_attachment", item.id);
      for (const dId of descendantIds) {
        const dItem = await resolveDocumentItem(db, dId);
        if (dItem)
          await releaseAllByOwner(db, c.get("config"), "item_attachment", dItem.id);
      }

      await softDeleteDocument(db, id);

      const meta = auditMeta(c);
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "document.deleted",
        resourceType: "document",
        resourceId: id,
        resourceName: existing.title,
        ...meta,
        result: "success",
      });
      for (const d of descendantRows) {
        if (!d)
          continue;
        await audit(db, c.get("logger"), {
          actorId: user.id,
          actorName: user.name,
          action: "document.deleted",
          resourceType: "document",
          resourceId: d.id,
          resourceName: d.title,
          detail: { cascadedFrom: id },
          ...meta,
          result: "success",
        });
      }
      return c.json({ success: true, data: null });
    },
  );

  // ── Attachment endpoints ──

  router.post(
    "/documents/:id/attachments",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Upload document attachment",
      description: "Multipart form upload (`file` field). 413 when the upload exceeds the configured limit.",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(z.unknown(), "Attachment uploaded"),
        ...errors(400, 401, 403, 404, 413),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id")!;
      const doc = await getDocumentById(db, id);
      if (!doc)
        throw new NotFoundError("Document", id);
      const item = await resolveDocumentItem(db, id);
      if (!item)
        throw new NotFoundError("Document", id);
      // Defense in depth (see GET /documents/:id).
      await documentAccess.assert(policyContext(c)!, "document:upload", item.id);

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
        action: "document.attachment_uploaded",
        resourceType: "document",
        resourceId: id,
        resourceName: doc.title,
        detail: { attachmentId: reference.id, filename: file.name, size: file.size },
        ...auditMeta(c),
        result: "success",
      });

      return c.json({ success: true, data: view }, 201);
    },
  );

  router.get(
    "/documents/:id/attachments",
    describeRoute({
      tags: [TAGS.Document],
      summary: "List document attachments",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Attachments"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const id = c.req.param("id")!;
      const item = await resolveDocumentItem(db, id);
      if (!item)
        throw new NotFoundError("Document", id);
      await documentAccess.assert(policyContext(c)!, "document:read", item.id);
      const data = await listAttachmentsByOwner(db, "item_attachment", item.id);
      return c.json({ success: true, data });
    },
  );

  router.get(
    "/documents/:id/attachments/:aid",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Download document attachment",
      description: "Streams the attachment. `inline=true` serves it for in-browser viewing.",
      security: SECURITY.session,
      responses: {
        ...raw(200, "application/octet-stream", "Attachment content"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const id = c.req.param("id")!;
      const aid = c.req.param("aid")!;
      const item = await resolveDocumentItem(db, id);
      if (!item)
        throw new NotFoundError("Document", id);
      await documentAccess.assert(policyContext(c)!, "document:download", item.id);
      const ref = await getOwnedReference(db, aid, "item_attachment", item.id);
      return await sendAttachment(c, ref);
    },
  );

  router.delete(
    "/documents/:id/attachments/:aid",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Delete document attachment",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Attachment deleted"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id")!;
      const aid = c.req.param("aid")!;
      const doc = await getDocumentById(db, id);
      if (!doc)
        throw new NotFoundError("Document", id);
      const item = await resolveDocumentItem(db, id);
      if (!item)
        throw new NotFoundError("Document", id);
      // Defense in depth (see GET /documents/:id).
      await documentAccess.assert(policyContext(c)!, "document:delete_attachment", item.id);
      const ref = await getOwnedReference(db, aid, "item_attachment", item.id);
      await releaseReference(db, c.get("config"), { referenceId: aid });
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "document.attachment_deleted",
        resourceType: "document",
        resourceId: id,
        resourceName: doc.title,
        detail: { attachmentId: aid, filename: ref.filename },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );

  // ── Comments + attachments (delegated to mod-item) ──
  mountItemCommentRoutes(router, {
    routePrefix: "/documents",
    resourceType: "document",
    maxCommentLength: 10000,
    async resolve(db, idParam) {
      const doc = await getDocumentById(db, idParam);
      if (!doc)
        return null;
      const item = await resolveDocumentItem(db, idParam);
      if (!item)
        return null;
      return {
        item,
        resource: doc,
        externalId: idParam,
        resourceName: doc.title,
      };
    },
    async permissions(db, user, subject) {
      // `mountItemCommentRoutes` predates the policy framework and
      // takes a `(db, user)` hook signature instead of a PolicyContext.
      // Build a minimal ctx so we can ask the framework directly —
      // request metadata is irrelevant for read-only decisions, and
      // the read-only branch never fires onGranted/onRevoked so the
      // shared NOOP_POLICY_LOGGER keeps the type complete without
      // plumbing one in.
      const ctx = {
        db,
        logger: NOOP_POLICY_LOGGER,
        actor: { id: user.id, type: "user", role: user.role },
      };
      const canView = await documentAccess.can(ctx, "document:read_comments", subject.item.id);
      return {
        canRead: canView,
        canPost: canView && !subject.resource.commentsLocked,
        // Documents do not currently distinguish internal vs public
        // comments. `item_comments.is_internal` defaults to `false`
        // (set by ItemService.createComment), so passing `true` is safe
        // and forward-compatible — the day the sub-type wants to flip
        // some comments to internal, viewer-only callers will still be
        // shielded if this flag is recomputed.
        includeInternal: true,
        canDelete: authorId => user.role === "admin" || authorId === user.id,
      };
    },
  });

  // ── Share endpoints (policy tuples) ──

  const shareSchema = z.object({
    targetType: z.enum(["user", "group"]),
    targetId: z.string().min(1),
    permission: z.enum(["viewer", "editor"]).default("viewer"),
  });

  router.get(
    "/documents/:id/shares",
    describeRoute({
      tags: [TAGS.Document],
      summary: "List document shares",
      description: "Direct + inherited shares for a document. Owner/admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Shares"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const id = c.req.param("id")!;
      // This handler previously had NO in-handler check at all and leaked
      // the (inherited) sharing graph to any authenticated user if the
      // policy binding desynced. Resolve + assert document:manage (owner)
      // explicitly; admin short-circuits via the bypass hook.
      const item = await resolveDocumentItem(db, id);
      if (!item)
        throw new NotFoundError("Document", id);
      await documentAccess.assert(policyContext(c)!, "document:manage", item.id);
      const data = await listDocumentSharesWithInheritance(db, id);
      return c.json({ success: true, data });
    },
  );

  router.post(
    "/documents/:id/shares",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Add document share",
      description: "Grant a user/group viewer or editor access. Applies recursively to descendants.",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(z.unknown(), "Share created"),
        ...errors(401, 403, 404, 409, 422),
      },
    }),
    validator("json", shareSchema),
    async (c) => {
      const ctx = policyContext(c)!;
      const id = c.req.param("id")!;

      const body = c.req.valid("json");
      // The framework runs `canGrant` (owner-or-admin) and `onGranted`
      // (audit emission) inside `documentAccess.grant()` — no manual
      // permission check or audit call here.
      const share = await addDocumentShare(ctx, { documentId: id, ...body });

      return c.json(
        {
          success: true,
          data: share,
          note: "Share applies recursively to all descendant documents.",
        },
        201,
      );
    },
  );

  router.delete(
    "/documents/:id/shares/:shareId",
    describeRoute({
      tags: [TAGS.Document],
      summary: "Remove document share",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Share removed"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const ctx = policyContext(c)!;
      const id = c.req.param("id")!;
      const shareId = c.req.param("shareId")!;

      const share = await getDocumentShareById(c.get("db"), shareId);
      if (!share || share.documentId !== id)
        throw new NotFoundError("Share", shareId);

      // `onRevoked` audits the removal; no manual audit emission needed.
      await removeDocumentShare(ctx, shareId);

      return c.json({ success: true, data: null });
    },
  );

  return router;
}
