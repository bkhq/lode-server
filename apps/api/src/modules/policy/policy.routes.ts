import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { listGroups } from "@/modules/account/groups/groups.service";
import { listUsers } from "@/modules/account/users/users.service";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { NotFoundError, ValidationError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, jsonPaged, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import {
  batchCreateTuples,
  batchDeleteTuples,
  createTuple,
  deleteTuple,
  getTupleById,
  getTuplesBySubject,
  listTuples,
  updateTupleRelation,
} from "./policy.service";
import { getPermissionManifest } from "./registry";
import {
  addResourceGroupMember,
  createResourceGroup,
  deleteResourceGroup,
  getResourceGroupMembers,
  listResourceGroups,
  removeResourceGroupMember,
  updateResourceGroup,
} from "./resource-group.service";
import { getRouteBindingsForResource } from "./route-registry";
import { check, expand } from "./zanzibar.engine";

const tupleSchema = z.object({
  namespace: z.string().min(1),
  objectId: z.string().min(1),
  relation: z.string().min(1),
  subjectNamespace: z.string().min(1),
  subjectId: z.string().min(1),
  subjectRelation: z.string().nullable().optional(),
});

const checkSchema = z.object({
  namespace: z.string().min(1),
  objectId: z.string().min(1),
  relation: z.string().min(1),
  subjectNamespace: z.string().min(1),
  subjectId: z.string().min(1),
});

const expandSchema = z.object({
  namespace: z.string().min(1),
  objectId: z.string().min(1),
  relation: z.string().min(1),
});

const batchSchema = z.object({
  create: z.array(tupleSchema).optional(),
  delete: z.array(z.string()).optional(),
});

const tupleRowSchema = z.object({
  id: z.string(),
  namespace: z.string(),
  objectId: z.string(),
  relation: z.string(),
  subjectNamespace: z.string(),
  subjectId: z.string(),
  subjectRelation: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

const resourceGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});

/**
 * Group-membership rows live in `account.group_members`, not `relation_tuples`.
 * Block any attempt to write them through the generic tuple endpoint so the
 * two stores never disagree — callers should use `/api/account/groups/:id/members`.
 */
function rejectGroupMembershipTuple(input: { readonly namespace: string; readonly relation: string }): void {
  if (input.namespace === "group" && input.relation === "member") {
    throw new ValidationError(
      "Group membership cannot be written through /policy/tuples",
      { tuple: "Use POST /api/account/groups/:id/members instead." },
    );
  }
}

export function policyRoutes() {
  const router = new Hono<AppEnv>();

  // GET /policy/tuples — list relation tuples (admin)
  router.get(
    "/policy/tuples",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "List relation tuples",
      description: "Paginated, filterable list of relation tuples. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonPaged(tupleRowSchema, "Relation tuples"),
        ...errors(401, 403),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const query = c.req.query();

      const page = Math.max(1, Math.floor(Number.parseInt(query.page ?? "", 10)) || 1);
      const limit = Math.min(100, Math.max(1, Math.floor(Number.parseInt(query.limit ?? "", 10)) || 50));

      const result = await listTuples(db, {
        namespace: query.namespace,
        objectId: query.object_id,
        relation: query.relation,
        subjectNamespace: query.subject_namespace,
        subjectId: query.subject_id,
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

  // POST /policy/tuples — create relation tuple (admin)
  router.post(
    "/policy/tuples",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Create relation tuple",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(tupleRowSchema, "Created tuple"),
        ...errors(401, 403, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", tupleSchema),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const body = c.req.valid("json");

      rejectGroupMembershipTuple(body);

      // Auto-fill subjectRelation for group subjects
      const tupleInput = {
        ...body,
        subjectRelation: body.subjectNamespace === "group" && !body.subjectRelation ? "member" : body.subjectRelation,
      };

      const tuple = await createTuple(db, tupleInput, user.id);

      const tupleStr = `${tupleInput.namespace}:${tupleInput.objectId}#${tupleInput.relation}@${tupleInput.subjectNamespace}:${tupleInput.subjectId}${tupleInput.subjectRelation ? `#${tupleInput.subjectRelation}` : ""}`;
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "tuple.created",
        resourceType: body.namespace,
        resourceId: body.objectId,
        resourceName: tupleStr,
        detail: { tuple: tupleStr, ...body },
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });
      return c.json({ success: true, data: tuple }, 201);
    },
  );

  // DELETE /policy/tuples/:id — delete relation tuple (admin)
  router.delete(
    "/policy/tuples/:id",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Delete relation tuple",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Deleted"),
        ...errors(401, 403, 404),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id");

      const existing = await getTupleById(db, id);
      const deleted = await deleteTuple(db, id);
      if (!deleted) {
        throw new NotFoundError("Tuple", id);
      }

      if (existing) {
        await audit(db, c.get("logger"), {
          actorId: user.id,
          actorName: user.name,
          action: "tuple.deleted",
          resourceType: existing.namespace,
          resourceId: existing.objectId,
          resourceName: id,
          ip: getClientIp(c),
          userAgent: c.req.header("user-agent") ?? "unknown",
          result: "success",
        });
      }
      return c.json({ success: true, data: null });
    },
  );

  // PATCH /policy/tuples/:id — update relation tuple (admin)
  router.patch(
    "/policy/tuples/:id",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Update relation tuple",
      security: SECURITY.session,
      responses: {
        ...jsonOk(tupleRowSchema, "Updated tuple"),
        ...errors(401, 403, 404, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", z.object({ relation: z.string().min(1) })),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id");

      const existing = await getTupleById(db, id);
      if (!existing) {
        throw new NotFoundError("Tuple", id);
      }

      const body = c.req.valid("json");
      rejectGroupMembershipTuple({ namespace: existing.namespace, relation: body.relation });

      const updated = await updateTupleRelation(db, id, body.relation, user.id);
      if (!updated) {
        throw new NotFoundError("Tuple", id);
      }

      const tupleStr = `${existing.namespace}:${existing.objectId}#${body.relation}@${existing.subjectNamespace}:${existing.subjectId}${existing.subjectRelation ? `#${existing.subjectRelation}` : ""}`;
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "tuple.updated",
        resourceType: existing.namespace,
        resourceId: existing.objectId,
        resourceName: tupleStr,
        detail: { previousRelation: existing.relation, newRelation: body.relation },
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });

      return c.json({ success: true, data: updated });
    },
  );

  // POST /policy/tuples/batch — batch create/delete tuples (admin)
  router.post(
    "/policy/tuples/batch",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Batch create/delete tuples",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ created: z.array(tupleRowSchema), deletedCount: z.number() }), "Batch result"),
        ...errors(401, 403, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", batchSchema),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const body = c.req.valid("json");

      if (body.create) {
        for (const input of body.create) {
          rejectGroupMembershipTuple(input);
        }
      }

      const created = body.create ? await batchCreateTuples(db, body.create, user.id) : [];
      const deletedCount = body.delete ? await batchDeleteTuples(db, body.delete) : 0;

      const ip = getClientIp(c);
      const userAgent = c.req.header("user-agent") ?? "unknown";
      if (created.length > 0) {
        const tuples = created.map(t => `${t.namespace}:${t.objectId}#${t.relation}@${t.subjectNamespace}:${t.subjectId}`);
        await audit(db, c.get("logger"), {
          actorId: user.id,
          actorName: user.name,
          action: "tuple.batch_created",
          resourceType: "tuple",
          resourceId: "batch",
          resourceName: "batch",
          detail: { count: created.length, tuples: tuples.slice(0, 5), truncated: tuples.length > 5 },
          ip,
          userAgent,
          result: "success",
        });
      }
      if (deletedCount > 0) {
        await audit(db, c.get("logger"), {
          actorId: user.id,
          actorName: user.name,
          action: "tuple.batch_deleted",
          resourceType: "tuple",
          resourceId: "batch",
          resourceName: "batch",
          detail: { count: deletedCount, ids: body.delete?.slice(0, 5) },
          ip,
          userAgent,
          result: "success",
        });
      }

      return c.json({
        success: true,
        data: { created, deletedCount },
      });
    },
  );

  // POST /policy/check — permission check (admin only)
  router.post(
    "/policy/check",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Permission check",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Check result"),
        ...errors(401, 403, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", checkSchema),
    async (c) => {
      const db = c.get("db");
      const body = c.req.valid("json");

      const result = await check(
        db,
        body.namespace,
        body.objectId,
        body.relation,
        body.subjectNamespace,
        body.subjectId,
      );

      return c.json({ success: true, data: result });
    },
  );

  // POST /policy/expand — expand relation tree
  router.post(
    "/policy/expand",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Expand relation tree",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Expanded relation tree"),
        ...errors(401, 403, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", expandSchema),
    async (c) => {
      const db = c.get("db");
      const body = c.req.valid("json");

      const tree = await expand(db, body.namespace, body.objectId, body.relation);

      return c.json({ success: true, data: tree });
    },
  );

  // GET /policy/users/:id/access — view user's all permissions (admin)
  router.get(
    "/policy/users/:id/access",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Get user access",
      description: "All relation tuples where the user is the subject. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({ tuples: z.array(tupleRowSchema) }), "User access"),
        ...errors(401, 403),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const userId = c.req.param("id");

      const tuples = await getTuplesBySubject(db, "user", userId);

      return c.json({
        success: true,
        data: { tuples },
      });
    },
  );

  // GET /policy/groups/:id/access — view group's all permissions (admin)
  router.get(
    "/policy/groups/:id/access",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Get group access",
      description: "All relation tuples where the group is the subject. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(tupleRowSchema), "Group access"),
        ...errors(401, 403),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const groupId = c.req.param("id");

      const tuples = await getTuplesBySubject(db, "group", groupId);
      return c.json({ success: true, data: tuples });
    },
  );

  // GET /policy/manifest — discovery payload describing every registered resource
  router.get(
    "/policy/manifest",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Get permission manifest",
      description: "Discovery payload describing every registered resource. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Permission manifest"),
        ...errors(401, 403),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      return c.json({ success: true, data: getPermissionManifest(getRouteBindingsForResource) });
    },
  );

  // GET /policy/entities — list all entities for policy management (admin)
  router.get(
    "/policy/entities",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "List policy entities",
      description: "Users, groups, and resource groups available for policy management. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Policy entities"),
        ...errors(401, 403),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      const db = c.get("db");

      const [usersResult, groupsList, resourceGroupsList] = await Promise.all([
        listUsers(db, { page: 1, limit: 500 }),
        listGroups(db),
        listResourceGroups(db),
      ]);

      return c.json({
        success: true,
        data: {
          user: usersResult.data.map(u => ({ id: u.id, name: u.name || u.username })),
          group: groupsList.map(g => ({ id: g.id, name: g.name })),
          resource_group: resourceGroupsList.map(rg => ({ id: rg.id, name: rg.name })),
        },
      });
    },
  );

  // --- Resource Group Management ---

  router.get(
    "/policy/resource-groups",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "List resource groups",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(resourceGroupSchema), "Resource groups"),
        ...errors(401, 403),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const groups = await listResourceGroups(db);
      return c.json({ success: true, data: groups });
    },
  );

  router.post(
    "/policy/resource-groups",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Create resource group",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(resourceGroupSchema, "Created resource group"),
        ...errors(401, 403, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).nullable().default(null),
    })),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const body = c.req.valid("json");

      const group = await createResourceGroup(db, body, user.id);

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "resource_group.created",
        resourceType: "resource_group",
        resourceId: group.id,
        resourceName: group.name,
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });

      return c.json({ success: true, data: group }, 201);
    },
  );

  router.patch(
    "/policy/resource-groups/:id",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Update resource group",
      security: SECURITY.session,
      responses: {
        ...jsonOk(resourceGroupSchema, "Updated resource group"),
        ...errors(401, 403, 404, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).nullable().default(null),
    })),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id");
      const body = c.req.valid("json");

      const group = await updateResourceGroup(db, id, body);

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "resource_group.updated",
        resourceType: "resource_group",
        resourceId: group.id,
        resourceName: group.name,
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });

      return c.json({ success: true, data: group });
    },
  );

  router.delete(
    "/policy/resource-groups/:id",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Delete resource group",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Deleted"),
        ...errors(401, 403, 404),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id");

      const deleted = await deleteResourceGroup(db, id);
      if (!deleted) {
        throw new NotFoundError("ResourceGroup", id);
      }

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "resource_group.deleted",
        resourceType: "resource_group",
        resourceId: id,
        resourceName: id,
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });

      return c.json({ success: true, data: null });
    },
  );

  router.get(
    "/policy/resource-groups/:id/members",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "List resource group members",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(z.unknown()), "Resource group members"),
        ...errors(401, 403),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const members = await getResourceGroupMembers(db, c.req.param("id"));
      return c.json({ success: true, data: members });
    },
  );

  router.post(
    "/policy/resource-groups/:id/members",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Add resource group member",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(z.unknown(), "Added member"),
        ...errors(401, 403, 404, 422),
      },
    }),
    authRequired,
    adminRequired,
    validator("json", z.object({
      namespace: z.string().min(1),
      objectId: z.string().min(1),
    })),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const groupId = c.req.param("id");
      const body = c.req.valid("json");

      const member = await addResourceGroupMember(db, groupId, body.namespace, body.objectId, user.id);

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "resource_group.member_added",
        resourceType: "resource_group",
        resourceId: groupId,
        resourceName: `${body.namespace}:${body.objectId}`,
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });

      return c.json({ success: true, data: member }, 201);
    },
  );

  router.delete(
    "/policy/resource-groups/:id/members/:tupleId",
    describeRoute({
      tags: [TAGS.Policy],
      summary: "Remove resource group member",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Removed"),
        ...errors(401, 403, 404),
      },
    }),
    authRequired,
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const groupId = c.req.param("id");
      const tupleId = c.req.param("tupleId");

      const removed = await removeResourceGroupMember(db, tupleId);
      if (!removed) {
        throw new NotFoundError("Member", tupleId);
      }

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "resource_group.member_removed",
        resourceType: "resource_group",
        resourceId: groupId,
        resourceName: tupleId,
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });

      return c.json({ success: true, data: null });
    },
  );

  return router;
}
