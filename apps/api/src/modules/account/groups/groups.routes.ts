import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { getUserById } from "@/modules/account/users/users.service";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError, NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupByName,
  getGroupMembers,
  listGroups,
  removeGroupMember,
  updateGroup,
} from "./groups.service";

const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  source: z.enum(["local", "idp"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const groupMemberSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string(),
  avatar: z.string().nullable(),
  role: z.enum(["admin", "user"]),
  status: z.enum(["active", "disabled"]),
  joinedAt: z.string(),
});

const groupIdParam = z.object({ id: z.string() });

const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
});

const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
}).refine(d => d.name !== undefined || d.description !== undefined, {
  message: "At least one of name or description must be provided",
});

const addMemberSchema = z.object({
  userId: z.string().min(1),
});

// Memberships of an IdP-managed group are rewritten from the groups claim at
// every login, so a manual edit would be undone silently; a rename would cut
// the group off from the claim value it mirrors.
function assertLocallyManaged(group: { readonly source: string }, what: string): void {
  if (group.source === "idp")
    throw new AppError(`This group is managed by the identity provider; its ${what} cannot be changed here`, 409, "GROUP_MANAGED_BY_IDP");
}

export function groupRoutes() {
  const router = new Hono<AppEnv>();

  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/account/groups/*", authRequired);

  // GET /groups — list all groups
  router.get(
    "/account/groups",
    describeRoute({
      tags: [TAGS.Account],
      summary: "List groups",
      description: "All groups with member counts. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(groupSchema.extend({ memberCount: z.number() })), "Groups"),
        ...errors(401, 403),
      },
    }),
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const data = await listGroups(db);
      return c.json({ success: true, data });
    },
  );

  // POST /groups — create group
  router.post(
    "/account/groups",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Create group",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(groupSchema, "Group created"),
        ...errors(401, 403, 409, 422),
      },
    }),
    adminRequired,
    validator("json", createGroupSchema),
    async (c) => {
      const db = c.get("db");
      const body = c.req.valid("json");

      const existing = await getGroupByName(db, body.name);
      if (existing) {
        throw new AppError(`Group name "${body.name}" already exists`, 409, "CONFLICT");
      }

      const group = await createGroup(db, {
        name: body.name,
        ...body.description ? { description: body.description } : {},
      });
      const actor = c.get("user")!;
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "group.created",
        resourceType: "group",
        resourceId: group.id,
        resourceName: group.name,
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });
      return c.json({ success: true, data: group }, 201);
    },
  );

  // GET /groups/:id — group detail
  router.get(
    "/account/groups/:id",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Get group",
      security: SECURITY.session,
      responses: {
        ...jsonOk(groupSchema, "Group"),
        ...errors(401, 403, 404),
      },
    }),
    adminRequired,
    validator("param", groupIdParam),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const group = await getGroupById(db, id);
      if (!group) {
        throw new NotFoundError("Group", id);
      }
      return c.json({ success: true, data: group });
    },
  );

  // PATCH /groups/:id — update group
  router.patch(
    "/account/groups/:id",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Update group",
      security: SECURITY.session,
      responses: {
        ...jsonOk(groupSchema, "Group updated"),
        ...errors(401, 403, 404, 409, 422),
      },
    }),
    adminRequired,
    validator("param", groupIdParam),
    validator("json", updateGroupSchema),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      const existing = await getGroupById(db, id);
      if (!existing) {
        throw new NotFoundError("Group", id);
      }

      const body = c.req.valid("json");

      if (body.name && body.name !== existing.name) {
        assertLocallyManaged(existing, "name");
        const nameConflict = await getGroupByName(db, body.name);
        if (nameConflict) {
          throw new AppError(`Group name "${body.name}" already exists`, 409, "CONFLICT");
        }
      }

      const updated = await updateGroup(db, id, {
        ...body.name ? { name: body.name } : {},
        ...body.description !== undefined ? { description: body.description } : {},
      });
      const actor = c.get("user")!;
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "group.updated",
        resourceType: "group",
        resourceId: id,
        resourceName: existing.name,
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });
      return c.json({ success: true, data: updated });
    },
  );

  // DELETE /groups/:id — delete group
  router.delete(
    "/account/groups/:id",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Delete group",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Group deleted"),
        ...errors(401, 403, 404),
      },
    }),
    adminRequired,
    validator("param", groupIdParam),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      const existing = await getGroupById(db, id);
      if (!existing) {
        throw new NotFoundError("Group", id);
      }

      await deleteGroup(db, id);
      const actor = c.get("user")!;
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "group.deleted",
        resourceType: "group",
        resourceId: id,
        resourceName: existing.name,
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );

  // GET /groups/:id/members — member list
  router.get(
    "/account/groups/:id/members",
    describeRoute({
      tags: [TAGS.Account],
      summary: "List group members",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(groupMemberSchema), "Group members"),
        ...errors(401, 403, 404),
      },
    }),
    adminRequired,
    validator("param", groupIdParam),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      const group = await getGroupById(db, id);
      if (!group) {
        throw new NotFoundError("Group", id);
      }

      const members = await getGroupMembers(db, id);
      return c.json({ success: true, data: members });
    },
  );

  // POST /groups/:id/members — add member
  router.post(
    "/account/groups/:id/members",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Add group member",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(z.null(), "Member added"),
        ...errors(401, 403, 404, 409, 422),
      },
    }),
    adminRequired,
    validator("param", groupIdParam),
    validator("json", addMemberSchema),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");

      const group = await getGroupById(db, id);
      if (!group) {
        throw new NotFoundError("Group", id);
      }
      assertLocallyManaged(group, "members");

      const body = c.req.valid("json");
      const user = await getUserById(db, body.userId);
      if (!user) {
        throw new NotFoundError("User", body.userId);
      }

      const added = await addGroupMember(db, id, body.userId);
      if (!added) {
        throw new AppError("User is already a member of this group", 409, "CONFLICT");
      }

      const actor = c.get("user")!;
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "group.member_added",
        resourceType: "group",
        resourceId: id,
        resourceName: group.name,
        detail: { userId: body.userId, userName: user.name },
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });
      return c.json({ success: true, data: null }, 201);
    },
  );

  // DELETE /groups/:id/members/:userId — remove member
  router.delete(
    "/account/groups/:id/members/:userId",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Remove group member",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Member removed"),
        ...errors(401, 403, 404, 409),
      },
    }),
    adminRequired,
    validator("param", z.object({ id: z.string(), userId: z.string() })),
    async (c) => {
      const db = c.get("db");
      const { id, userId } = c.req.valid("param");

      const group = await getGroupById(db, id);
      if (!group) {
        throw new NotFoundError("Group", id);
      }
      assertLocallyManaged(group, "members");

      const removed = await removeGroupMember(db, id, userId);
      if (!removed) {
        throw new NotFoundError("Member", userId);
      }

      const actor = c.get("user")!;
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "group.member_removed",
        resourceType: "group",
        resourceId: id,
        resourceName: group.name,
        detail: { userId },
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );

  return router;
}
