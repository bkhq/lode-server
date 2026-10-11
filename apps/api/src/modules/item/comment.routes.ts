import type { Context, Hono } from "hono";
import type { AppDatabase } from "@/db";
import type { ItemRow } from "@/modules/item/item.service";
import type { AppEnv } from "@/shared/lib/types";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import {
  buildDownloadResponse,
  getFileById,
  getReferenceById,
  listAttachmentsByOwner,
  makeAttachmentView,
  releaseReference,
  uploadAndReference,
} from "@/modules/file";
import { createComment, deleteComment, getCommentById, listComments } from "@/modules/item/comment.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError, ForbiddenError, NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, raw, SECURITY, TAGS, validator } from "@/shared/lib/openapi";

const DEFAULT_COMMENT_MAX_LENGTH = 2000;

function buildCommentSchema(maxLength: number) {
  return z.object({
    content: z.string().min(1).max(maxLength),
    replyToId: z.string().nullish(),
  });
}

/**
 * Per-request permission read for one sub-type subject. Sub-types compute
 * these from their own access rules (creator/assignee, viewer/editor via
 * policy, commentsLocked, …) and hand the result back to the factory.
 *
 * `canDelete` is a function so the factory can pass the comment's author
 * id in (most sub-types allow "author or admin").
 */
export interface CommentPermissions {
  /** Can the actor list comments / list and download attachments? */
  readonly canRead: boolean;
  /** Can the actor post comments on this subject? `false` covers e.g. `commentsLocked`. */
  readonly canPost: boolean;
  /** Whether the listed comments include internal ones (admin / owner / assignee / approver typically true; viewers false). */
  readonly includeInternal: boolean;
  /** Can the actor delete this particular comment? */
  readonly canDelete: (commentAuthorId: string) => boolean;
}

export interface CommentSubject<TResource = unknown> {
  readonly item: ItemRow;
  /** Sub-type row data (e.g. the issue / document row). Opaque to the factory; consumed by `permissions`. */
  readonly resource: TResource;
  /** Used for `audit.resourceName`. */
  readonly resourceName: string;
  /** The sub-type's short id (the value the route param resolved to). */
  readonly externalId: string;
}

export interface MountItemCommentRoutesOptions<TResource = unknown> {
  /** URL prefix the sub-type mounts comments under, e.g. `/issues`, `/documents`. */
  readonly routePrefix: string;
  /** Audit resource type, e.g. `"issue"`, `"document"`. */
  readonly resourceType: string;
  /** Maximum comment body length in characters. Defaults to 2000. */
  readonly maxCommentLength?: number;
  /**
   * Resolve a route's `:id` to the parent subject. Return `null` when the
   * subject does not exist; the factory turns that into a `NotFoundError`.
   */
  readonly resolve: (db: AppDatabase, idParam: string) => Promise<CommentSubject<TResource> | null>;
  /** Compute the actor's permission read for this subject. */
  readonly permissions: (
    db: AppDatabase,
    user: { id: string; role: string },
    subject: CommentSubject<TResource>,
  ) => Promise<CommentPermissions>;
}

function auditMeta(c: Context) {
  return {
    ip: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? "unknown",
  };
}

/**
 * Mount the shared comment + comment-attachment route set onto a sub-type's
 * router. Owned by `mod-item` because comments hang off `items.id` and the
 * permission story (parent_item / viewer / editor) is uniform across
 * sub-types. The sub-type only wires `resolve` + `permissions`.
 */
export function mountItemCommentRoutes<TResource>(
  router: Hono<AppEnv>,
  opts: MountItemCommentRoutesOptions<TResource>,
): void {
  const { routePrefix: prefix, resourceType } = opts;
  const commentSchema = buildCommentSchema(opts.maxCommentLength ?? DEFAULT_COMMENT_MAX_LENGTH);

  async function load(
    c: Context<AppEnv>,
  ): Promise<{ db: AppDatabase; user: { id: string; role: string; name: string }; subject: CommentSubject<TResource>; perms: CommentPermissions }> {
    const db = c.get("db");
    const user = c.get("user")!;
    const subject = await opts.resolve(db, c.req.param("id")!);
    if (!subject)
      throw new NotFoundError(resourceType, c.req.param("id")!);
    const perms = await opts.permissions(db, user, subject);
    return { db, user, subject, perms };
  }

  router.get(
    `${prefix}/:id/comments`,
    describeRoute({
      tags: [TAGS.Document],
      summary: "List comments",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Comments"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const { db, subject, perms } = await load(c);
      if (!perms.canRead)
        throw new ForbiddenError();
      const data = await listComments(db, subject.item.id, { includeInternal: perms.includeInternal });
      return c.json({ success: true, data });
    },
  );

  router.post(
    `${prefix}/:id/comments`,
    describeRoute({
      tags: [TAGS.Document],
      summary: "Create comment",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(z.unknown(), "Comment created"),
        ...errors(401, 403, 404, 422),
      },
    }),
    validator("json", commentSchema),
    async (c) => {
      const { db, user, subject, perms } = await load(c);
      if (!perms.canPost)
        throw new ForbiddenError();
      const body = c.req.valid("json");
      const comment = await createComment(db, {
        itemId: subject.item.id,
        authorId: user.id,
        content: body.content,
        replyToId: body.replyToId ?? null,
      });
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: `${resourceType}.comment_added`,
        resourceType,
        resourceId: subject.externalId,
        resourceName: subject.resourceName,
        detail: { commentId: comment.id },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: comment }, 201);
    },
  );

  router.delete(
    `${prefix}/:id/comments/:cid`,
    describeRoute({
      tags: [TAGS.Document],
      summary: "Delete comment",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Comment deleted"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const { db, user, subject, perms } = await load(c);
      const cid = c.req.param("cid");
      const comment = await getCommentById(db, subject.item.id, cid);
      if (!comment)
        throw new NotFoundError("Comment", cid);
      if (!perms.canDelete(comment.authorId))
        throw new ForbiddenError();
      await deleteComment(db, cid);
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: `${resourceType}.comment_deleted`,
        resourceType,
        resourceId: subject.externalId,
        resourceName: subject.resourceName,
        detail: { commentId: cid },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );

  // ── Comment attachments (owner_type='item_comment_attachment') ──

  router.get(
    `${prefix}/:id/comments/:cid/attachments`,
    describeRoute({
      tags: [TAGS.Document],
      summary: "List comment attachments",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Attachments"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const { db, subject, perms } = await load(c);
      if (!perms.canRead)
        throw new ForbiddenError();
      const cid = c.req.param("cid");
      const comment = await getCommentById(db, subject.item.id, cid);
      if (!comment)
        throw new NotFoundError("Comment", cid);
      const data = await listAttachmentsByOwner(db, "item_comment_attachment", cid);
      return c.json({ success: true, data });
    },
  );

  router.post(
    `${prefix}/:id/comments/:cid/attachments`,
    describeRoute({
      tags: [TAGS.Document],
      summary: "Upload comment attachment",
      description: "Multipart form upload (`file` field). Only the comment author may attach files.",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(z.unknown(), "Attachment uploaded"),
        ...errors(400, 401, 403, 404, 413),
      },
    }),
    async (c) => {
      const { db, user, subject } = await load(c);
      const cid = c.req.param("cid");
      const comment = await getCommentById(db, subject.item.id, cid);
      if (!comment)
        throw new NotFoundError("Comment", cid);
      // Only the comment author can attach files to their own comment. This
      // rule is uniform across sub-types — admins also do not bypass it,
      // because the attachment is part of the author's speech.
      if (comment.authorId !== user.id)
        throw new ForbiddenError();

      const config = c.get("config");
      const contentLength = Number(c.req.header("content-length") ?? "0");
      if (contentLength > config.MAX_UPLOAD_BYTES)
        throw new AppError("Upload too large", 413, "UPLOAD_TOO_LARGE");
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!(file instanceof File))
        throw new AppError("No file provided", 400, "VALIDATION_ERROR");

      const { reference, file: uploaded } = await uploadAndReference(db, config, {
        file,
        ownerType: "item_comment_attachment",
        ownerId: cid,
        uploadedBy: user.id,
      });
      const view = makeAttachmentView(reference, uploaded);

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: `${resourceType}.comment_attachment_uploaded`,
        resourceType,
        resourceId: subject.externalId,
        resourceName: subject.resourceName,
        detail: { commentId: cid, attachmentId: reference.id, filename: file.name, size: file.size },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: view }, 201);
    },
  );

  router.get(
    `${prefix}/:id/comments/:cid/attachments/:aid`,
    describeRoute({
      tags: [TAGS.Document],
      summary: "Download comment attachment",
      description: "Streams the attachment. `inline=true` serves it for in-browser viewing.",
      security: SECURITY.session,
      responses: {
        ...raw(200, "application/octet-stream", "Attachment content"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const { db, subject, perms } = await load(c);
      if (!perms.canRead)
        throw new ForbiddenError();
      const cid = c.req.param("cid");
      const aid = c.req.param("aid");
      const comment = await getCommentById(db, subject.item.id, cid);
      if (!comment)
        throw new NotFoundError("Comment", cid);
      const ref = await getReferenceById(db, aid);
      if (!ref || ref.ownerType !== "item_comment_attachment" || ref.ownerId !== cid)
        throw new NotFoundError("Attachment", aid);
      const fileRow = await getFileById(db, ref.fileId);
      if (!fileRow)
        throw new NotFoundError("File", aid);
      const wantInline = c.req.query("inline") === "true";
      return await buildDownloadResponse(c.get("config"), fileRow, ref, { inline: wantInline });
    },
  );

  router.delete(
    `${prefix}/:id/comments/:cid/attachments/:aid`,
    describeRoute({
      tags: [TAGS.Document],
      summary: "Delete comment attachment",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Attachment deleted"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const { db, user, subject } = await load(c);
      const cid = c.req.param("cid");
      const aid = c.req.param("aid");
      const comment = await getCommentById(db, subject.item.id, cid);
      if (!comment)
        throw new NotFoundError("Comment", cid);
      const ref = await getReferenceById(db, aid);
      if (!ref || ref.ownerType !== "item_comment_attachment" || ref.ownerId !== cid)
        throw new NotFoundError("Attachment", aid);
      if (user.role !== "admin" && ref.createdBy !== user.id)
        throw new ForbiddenError();
      await releaseReference(db, c.get("config"), { referenceId: aid });
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: `${resourceType}.comment_attachment_deleted`,
        resourceType,
        resourceId: subject.externalId,
        resourceName: subject.resourceName,
        detail: { commentId: cid, attachmentId: aid, filename: ref.filename },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );
}
