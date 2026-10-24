import type { RegistryToken } from "./token.service";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import { policyContext } from "@/modules/policy";
import { NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { createToken, getToken, listTokens, replaceGrants, revokeToken } from "./token.service";
import { auditMeta, grantsSchema, tokenSchema } from "./wire";

export function tokenView(token: RegistryToken): z.infer<typeof tokenSchema> {
  return {
    id: token.id,
    user_id: token.userId,
    name: token.name,
    prefix: token.prefix,
    // A fresh array: the service's is read-only.
    grants: "all" in token.grants
      ? token.grants
      : [...token.grants],
    expires_at: token.expiresAt,
    last_used_at: token.lastUsedAt,
    created_at: token.createdAt,
  };
}

const tokenNameSchema = z.string().trim().min(1).max(100);

const createTokenSchema = z.object({
  name: tokenNameSchema,
  // Omitted or null: the token does not expire.
  expires_at: z.iso.datetime({ offset: true }).refine(value => Date.parse(value) > Date.now(), "Must be in the future").nullable().optional(),
  grants: grantsSchema,
});

const tokenParamSchema = z.object({
  id: z.string(),
});

/**
 * Token management, mounted by `registryRoutes` behind its `authRequired`.
 * No token scope lists these routes, so they are reachable only with a
 * session: a token can never mint, re-grant or revoke tokens.
 */
export function registryTokenRoutes() {
  const router = new Hono<AppEnv>();

  router.get(
    "/registry/tokens",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "List my tokens",
      description: "The caller's personal API tokens with their package grants, expiry and last use. `grants` is `{ all }` for every package the caller owns, or a list of `{ package, access }` where `package` is `<namespace>/<package slug>`. Session only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(tokenSchema), "Tokens, without their secrets"),
        ...errors(401, 403),
      },
    }),
    async (c) => {
      const tokens = await listTokens(c.get("db"), c.get("user")!.id);
      return c.json({
        success: true,
        data: tokens.map(tokenView),
      });
    },
  );

  router.post(
    "/registry/tokens",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Create a token with package grants",
      description: "Creates a personal API token narrowed to packages and returns the secret once, in `token`. A grant can only name a package the caller may manage; `{ all }` covers every package the caller owns, including future ones. Session only.",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(tokenSchema.extend({
          token: z.string(),
        }), "Token created"),
        ...errors(401, 403, 409, 422),
      },
    }),
    validator("json", createTokenSchema),
    async (c) => {
      const db = c.get("db");
      const body = c.req.valid("json");
      const { token, record } = await createToken(policyContext(c)!, {
        name: body.name,
        expiresAt: body.expires_at == null
          ? null
          : new Date(body.expires_at).toISOString(),
        grants: body.grants,
      });
      await audit(db, c.get("logger"), {
        ...auditMeta(c),
        action: "registry.token.created",
        resourceType: "api_token",
        resourceId: record.id,
        resourceName: record.name,
        detail: { grants: record.grants, expires_at: record.expiresAt },
      });
      return c.json({
        success: true,
        data: {
          ...tokenView(record),
          token,
        },
      }, 201);
    },
  );

  router.put(
    "/registry/tokens/:id",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Replace a token's grants",
      description: "Replaces every grant of the token, and its name when `name` is given; the secret is not reissued. Session only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(tokenSchema),
        ...errors(401, 403, 404, 422),
      },
    }),
    validator("param", tokenParamSchema),
    validator("json", z.object({
      name: tokenNameSchema.optional(),
      grants: grantsSchema,
    })),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const { name, grants } = c.req.valid("json");
      const previous = name === undefined
        ? undefined
        : await getToken(db, id);
      const record = await replaceGrants(policyContext(c)!, id, grants, name);
      if (!record)
        throw new NotFoundError("API token", id);
      const renamed = previous !== undefined && previous.name !== record.name;
      await audit(db, c.get("logger"), {
        ...auditMeta(c),
        action: "registry.token.grants_replaced",
        resourceType: "api_token",
        resourceId: record.id,
        resourceName: record.name,
        detail: {
          grants: record.grants,
          ...(renamed
            ? { name: record.name, previous_name: previous.name }
            : {}),
        },
      });
      return c.json({
        success: true,
        data: tokenView(record),
      });
    },
  );

  router.delete(
    "/registry/tokens/:id",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Revoke a token",
      description: "Deletes the token and its grants. Session only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          id: z.string(),
        }), "Token revoked"),
        ...errors(401, 403, 404),
      },
    }),
    validator("param", tokenParamSchema),
    async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const revoked = await revokeToken(db, id, c.get("user")!.id);
      if (!revoked)
        throw new NotFoundError("API token", id);
      await audit(db, c.get("logger"), {
        ...auditMeta(c),
        action: "registry.token.revoked",
        resourceType: "api_token",
        resourceId: id,
        resourceName: revoked.name,
      });
      return c.json({
        success: true,
        data: { id },
      });
    },
  );

  return router;
}
