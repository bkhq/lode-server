import type { Owner } from "./admin.service";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { AppEnv } from "@/shared/lib/types";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { users } from "@/modules/account/users/schema";
import { audit } from "@/modules/audit/audit.service";
import { NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired } from "@/shared/middleware/auth";
import { getQuotaOverride, listAllNamespaces, listAllPackages, setNamespaceStatus, setQuotaOverride } from "./admin.service";
import { getEffectiveQuota, getUsage } from "./registry.service";
import { tokenView } from "./token.routes";
import { listTokens, revokeToken } from "./token.service";
import { auditMeta, limitsSchema, limitsView, namespaceSchema, namespaceView, packageSchema, packageView, tokenSchema, usageSchema, usageView } from "./wire";

const ownerSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
});

const adminNamespaceSchema = namespaceSchema.extend({
  owner: ownerSchema,
  packages: z.number(),
  storage_bytes: z.number(),
});

const adminPackageSchema = packageSchema.extend({
  owner: ownerSchema,
  storage_bytes: z.number(),
});

const MAX_ASSET_BYTES_CEILING = 500 * 1024 * 1024;

// A PUT replaces the whole override: a limit left out is cleared like a null.
const overrideSchema = z.strictObject({
  max_packages: z.number().int().nonnegative().nullable().default(null),
  max_storage_bytes: z.number().int().nonnegative().nullable().default(null),
  max_asset_bytes: z.number().int().positive().max(MAX_ASSET_BYTES_CEILING).nullable().default(null),
});

const userQuotaSchema = z.object({
  user_id: z.string(),
  override: z.object({
    max_packages: z.number().nullable(),
    max_storage_bytes: z.number().nullable(),
    max_asset_bytes: z.number().nullable(),
  }),
  limits: limitsSchema,
  usage: usageSchema,
});

const slugParamSchema = z.object({
  slug: z.string(),
});
const userParamSchema = z.object({
  userId: z.string(),
});

async function requireUser(db: AppDatabase, id: string): Promise<Owner> {
  const user = await db.select({ id: users.id, username: users.username, name: users.name }).from(users).where(eq(users.id, id)).get();
  if (!user)
    throw new NotFoundError("User", id);
  return user;
}

async function userQuotaView(db: AppDatabase, config: Config, userId: string): Promise<z.infer<typeof userQuotaSchema>> {
  const override = await getQuotaOverride(db, userId);
  return {
    user_id: userId,
    override: { max_packages: override.maxPackages, max_storage_bytes: override.maxStorageBytes, max_asset_bytes: override.maxAssetBytes },
    limits: limitsView(await getEffectiveQuota(db, userId, config)),
    usage: usageView(await getUsage(db, userId)),
  };
}

/**
 * Platform administration, mounted by `registryRoutes` behind its
 * `authRequired`. Open to the template's `admin` role only, and to no token:
 * no token scope lists a route under `/registry/admin`.
 *
 * There are no admin package routes here. An administrator passes every
 * package check, so they act on any package — settings, releases, deletion —
 * through the ordinary `/registry/packages/:ns/:pkg` routes.
 */
export function registryAdminRoutes() {
  const router = new Hono<AppEnv>();
  router.use("/registry/admin/*", adminRequired);

  // ─── Namespaces ───

  router.get(
    "/registry/admin/namespaces",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "List every namespace",
      description: "All namespaces with their owner, package count and storage usage. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(adminNamespaceSchema)),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const namespaces = await listAllNamespaces(c.get("db"));
      return c.json({
        success: true,
        data: namespaces.map(n => ({
          ...namespaceView(n.namespace),
          owner: n.owner,
          packages: n.packages,
          storage_bytes: n.storageBytes,
        })),
      });
    },
  );

  for (const [verb, status, summary, description] of [
    [
      "suspend",
      "suspended",
      "Suspend a namespace",
      "While suspended, the namespace's packages are read-only to its owner, its feed is not served and its owner's tokens are refused. Admin only.",
    ],
    [
      "restore",
      "active",
      "Restore a suspended namespace",
      "Puts a suspended namespace back in service. Admin only.",
    ],
  ] as const) {
    router.post(
      `/registry/admin/namespaces/:slug/${verb}`,
      describeRoute({
        tags: [TAGS.Registry],
        summary,
        description,
        security: SECURITY.session,
        responses: {
          ...jsonOk(namespaceSchema),
          ...errors(401, 403, 404),
        },
      }),
      validator("param", slugParamSchema),
      async (c) => {
        const db = c.get("db");
        const { slug } = c.req.valid("param");
        const result = await setNamespaceStatus(db, slug, status);
        if (!result)
          throw new NotFoundError("Namespace", slug);
        if (result.changed) {
          await audit(db, c.get("logger"), {
            ...auditMeta(c),
            action: status === "suspended"
              ? "registry.namespace.suspended"
              : "registry.namespace.restored",
            resourceType: "registry_namespace",
            resourceId: result.namespace.id,
            resourceName: result.namespace.slug,
            detail: { owner_user_id: result.namespace.ownerUserId },
          });
        }
        return c.json({
          success: true,
          data: namespaceView(result.namespace),
        });
      },
    );
  }

  // ─── Packages ───

  router.get(
    "/registry/admin/packages",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "List every package",
      description: "All packages across users with their owner and storage usage. Admin only. To change, yank from or delete any of them, an administrator uses the ordinary `/registry/packages/:ns/:pkg` routes, which they pass for every package.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(adminPackageSchema)),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const packages = await listAllPackages(c.get("db"));
      return c.json({
        success: true,
        data: packages.map(p => ({
          ...packageView(p.namespace, p.package),
          owner: p.owner,
          storage_bytes: p.storageBytes,
        })),
      });
    },
  );

  // ─── Quotas ───

  router.get(
    "/registry/admin/users/:userId/quota",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Get a user's quota",
      description: "The user's override (null where the platform default applies), the limits in effect and current usage. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(userQuotaSchema),
        ...errors(401, 403, 404),
      },
    }),
    validator("param", userParamSchema),
    async (c) => {
      const db = c.get("db");
      const user = await requireUser(db, c.req.valid("param").userId);
      return c.json({ success: true, data: await userQuotaView(db, c.get("config"), user.id) });
    },
  );

  router.put(
    "/registry/admin/users/:userId/quota",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Set a user's quota override",
      description: "Replaces the override. A null (or omitted) limit falls back to the platform default; all nulls clears the override. `max_asset_bytes` cannot exceed 524288000. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(userQuotaSchema),
        ...errors(401, 403, 404, 422),
      },
    }),
    validator("param", userParamSchema),
    validator("json", overrideSchema),
    async (c) => {
      const db = c.get("db");
      const user = await requireUser(db, c.req.valid("param").userId);
      const body = c.req.valid("json");
      await setQuotaOverride(db, user.id, {
        maxPackages: body.max_packages,
        maxStorageBytes: body.max_storage_bytes,
        maxAssetBytes: body.max_asset_bytes,
      });
      await audit(db, c.get("logger"), {
        ...auditMeta(c),
        action: "registry.quota.updated",
        resourceType: "registry_quota",
        resourceId: user.id,
        resourceName: user.username,
        detail: { owner_user_id: user.id, override: body },
      });
      return c.json({ success: true, data: await userQuotaView(db, c.get("config"), user.id) });
    },
  );

  // ─── Tokens ───

  router.get(
    "/registry/admin/tokens",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "List any user's tokens",
      description: "Personal API tokens with their package grants, without secrets; `user_id` narrows the list to one user. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(tokenSchema)),
        ...errors(401, 403, 422),
      },
    }),
    validator("query", z.object({
      user_id: z.string().min(1).optional(),
    })),
    async (c) => {
      const tokens = await listTokens(c.get("db"), c.req.valid("query").user_id);
      return c.json({
        success: true,
        data: tokens.map(tokenView),
      });
    },
  );

  router.delete(
    "/registry/admin/tokens/:id",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Revoke any user's token",
      description: "Deletes the token and its grants. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          id: z.string(),
        }), "Token revoked"),
        ...errors(401, 403, 404),
      },
    }),
    validator("param", z.object({
      id: z.string(),
    })),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const revoked = await revokeToken(db, id);
      if (!revoked)
        throw new NotFoundError("API token", id);
      await audit(db, c.get("logger"), {
        ...auditMeta(c),
        action: "registry.token.revoked",
        resourceType: "api_token",
        resourceId: id,
        resourceName: revoked.name,
        detail: { owner_user_id: revoked.userId },
      });
      return c.json({
        success: true,
        data: { id },
      });
    },
  );

  return router;
}
