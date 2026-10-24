import type { PolicyContext, TupleKey } from "@/modules/policy";
import { and, eq, isNull } from "drizzle-orm";
import { audit } from "@/modules/audit/audit.service";
import { items } from "@/modules/item/schema";
import { defineResource } from "@/modules/policy";
import { check } from "@/modules/policy/zanzibar.engine";

async function isAdminOrOwner(ctx: PolicyContext, objectId: string): Promise<boolean> {
  if (ctx.actor.role === "admin")
    return true;
  const result = await check(ctx.db, "item", objectId, "owner", "user", ctx.actor.id);
  return result.allowed;
}

async function emitShareAudit(
  ctx: PolicyContext,
  action: "document.share_added" | "document.share_removed",
  key: Pick<TupleKey, "objectId" | "relation" | "subjectNamespace" | "subjectId">,
): Promise<void> {
  const row = await ctx.db
    .select({ title: items.title, shortId: items.shortId })
    .from(items)
    .where(eq(items.id, key.objectId))
    .get();
  await audit(ctx.db, ctx.logger, {
    actorId: ctx.actor.id,
    actorName: ctx.actor.name ?? ctx.actor.id,
    action,
    resourceType: "document",
    resourceId: row?.shortId ?? key.objectId,
    resourceName: row?.title ?? "",
    detail: {
      targetType: key.subjectNamespace,
      targetId: key.subjectId,
      permission: key.relation,
    },
    ip: ctx.request?.ip ?? "unknown",
    userAgent: ctx.request?.userAgent ?? "unknown",
    result: "success",
  });
}

export const documentAccess = defineResource({
  name: "document",
  namespace: "item",
  description: "Markdown documents with parent-chain inheritance and explicit sharing.",
  actions: {
    "document:read": "viewer",
    "document:download": "viewer",
    "document:read_comments": "viewer",
    "document:update": "editor",
    "document:upload": "editor",
    "document:delete_attachment": "editor",
    "document:comment": "viewer",
    "document:delete": "owner",
    "document:manage": "owner",
  } as const,
  routes: [
    { method: "GET", path: "/documents/:id", action: "document:read" },
    { method: "PATCH", path: "/documents/:id", action: "document:update" },
    { method: "PATCH", path: "/documents/:id/move", action: "document:update" },
    { method: "DELETE", path: "/documents/:id", action: "document:delete" },
    { method: "POST", path: "/documents/:id/attachments", action: "document:upload" },
    { method: "GET", path: "/documents/:id/attachments", action: "document:read" },
    { method: "GET", path: "/documents/:id/attachments/:aid", action: "document:download" },
    { method: "DELETE", path: "/documents/:id/attachments/:aid", action: "document:delete_attachment" },
    { method: "GET", path: "/documents/:id/shares", action: "document:manage" },
    { method: "POST", path: "/documents/:id/shares", action: "document:manage" },
    { method: "DELETE", path: "/documents/:id/shares/:shareId", action: "document:manage" },
  ] as const,
  // `document:update` admits editors, but only owners may flip the
  // comment lock. The field rule keeps the rest of the patch payload
  // editor-writable in one PATCH without splitting endpoints.
  fields: {
    write: {
      commentsLocked: "owner",
    },
  },
  hooks: {
    bypass: ctx => ctx.actor.role === "admin",
    resolveObjectId: async (c, params) => {
      const shortId = params.id;
      if (!shortId)
        return null;
      const row = await c.get("db")
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.shortId, shortId), eq(items.type, "document"), isNull(items.deletedAt)))
        .get();
      return row?.id ?? null;
    },
    resolveEntity: async (db, itemId) => {
      const row = await db
        .select({ title: items.title, shortId: items.shortId })
        .from(items)
        .where(eq(items.id, itemId))
        .get();
      return row
        ? { name: row.title, type: "document", url: `/documents/${row.shortId}` }
        : null;
    },
    canGrant: (ctx, params) => isAdminOrOwner(ctx, params.objectId),
    canRevoke: (ctx, params) => isAdminOrOwner(ctx, params.objectId),
    onGranted: (ctx, tuple) => emitShareAudit(ctx, "document.share_added", tuple),
    onRevoked: (ctx, key) => emitShareAudit(ctx, "document.share_removed", key),
  },
});
