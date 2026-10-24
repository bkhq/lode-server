import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit, auditMeta } from "@/modules/audit/audit.service";
import { NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { getTokenScopes, isTokenScope } from "@/shared/lib/token-scopes";
import { authRequired } from "@/shared/middleware/auth";
import { createApiToken, deleteApiToken, listApiTokens, rotateApiToken, updateApiToken } from "./tokens.service";

const tokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

const tokenNameSchema = z.string().trim().min(1).max(100);
const tokenScopesSchema = z.array(z.string()).min(1).refine(scopes => scopes.every(isTokenScope), { message: "Unknown scope" });

// Omitted → the token does not expire.
const expiresInDaysSchema = z.number().int().min(1).max(3650).optional();

const createTokenSchema = z.object({
  name: tokenNameSchema,
  scopes: tokenScopesSchema,
  expiresInDays: expiresInDaysSchema,
});

const rotateTokenSchema = z.object({
  expiresInDays: expiresInDaysSchema,
});

function expiresAtFor(expiresInDays: number | undefined): string | null {
  return expiresInDays === undefined
    ? null
    : new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
}

const updateTokenSchema = z.object({
  name: tokenNameSchema.optional(),
  scopes: tokenScopesSchema.optional(),
}).refine(body => body.name !== undefined || body.scopes !== undefined, { message: "Nothing to update" });

/**
 * Token management. None of these routes is listed by any token scope, so
 * they are reachable only with a session: a token can never mint, list or
 * revoke tokens.
 */
export function tokenRoutes() {
  const router = new Hono<AppEnv>();

  router.use("/account/me/tokens/*", authRequired);
  router.use("/account/token-scopes/*", authRequired);

  router.get(
    "/account/token-scopes",
    describeRoute({
      tags: [TAGS.Account],
      summary: "List API token scopes",
      description: "The scopes modules have registered, to choose from when creating a token.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(z.object({
          name: z.string(),
          description: z.string(),
        })), "Registered scopes"),
        ...errors(401),
      },
    }),
    c => c.json({
      success: true,
      data: getTokenScopes(),
    }),
  );

  router.get(
    "/account/me/tokens",
    describeRoute({
      tags: [TAGS.Account],
      summary: "List my API tokens",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(tokenSchema), "Tokens, without their secrets"),
        ...errors(401, 403),
      },
    }),
    async c => c.json({ success: true, data: await listApiTokens(c.get("db"), c.get("user")!.id) }),
  );

  router.post(
    "/account/me/tokens",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Create an API token",
      description: "Returns the token once, in `token`. Only its hash is stored.",
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
      const user = c.get("user")!;
      const body = c.req.valid("json");
      const { token, record } = await createApiToken(db, user.id, {
        name: body.name,
        scopes: body.scopes,
        expiresAt: expiresAtFor(body.expiresInDays),
      });
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "api_token.created",
        resourceType: "api_token",
        resourceId: record.id,
        resourceName: record.name,
        detail: { scopes: record.scopes, expiresAt: record.expiresAt },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({
        success: true,
        data: { ...record, token },
      }, 201);
    },
  );

  router.patch(
    "/account/me/tokens/:id",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Update an API token",
      description: "Renames or rescopes a token. The secret is unchanged; new scopes apply from its next request.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(tokenSchema, "Token updated"),
        ...errors(401, 403, 404, 422),
      },
    }),
    validator("param", z.object({
      id: z.string(),
    })),
    validator("json", updateTokenSchema),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const { id } = c.req.valid("param");
      const updated = await updateApiToken(db, user.id, id, c.req.valid("json"));
      if (!updated)
        throw new NotFoundError("API token", id);
      const { before, after } = updated;
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "api_token.updated",
        resourceType: "api_token",
        resourceId: id,
        resourceName: after.name,
        detail: {
          ...(before.name !== after.name
            ? {
                name: { from: before.name, to: after.name },
              }
            : {}),
          ...(before.scopes.join() !== after.scopes.join()
            ? {
                scopes: { from: before.scopes, to: after.scopes },
              }
            : {}),
        },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: after });
    },
  );

  router.post(
    "/account/me/tokens/:id/rotate",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Rotate an API token",
      description: "Replaces the token's secret and returns the new one once, in `token`. The old secret stops working at once; name and scopes are kept, and the expiry is set anew as at creation.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(tokenSchema.extend({
          token: z.string(),
        }), "Token rotated"),
        ...errors(401, 403, 404, 422),
      },
    }),
    validator("param", z.object({
      id: z.string(),
    })),
    validator("json", rotateTokenSchema),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const { id } = c.req.valid("param");
      const rotated = await rotateApiToken(db, user.id, id, expiresAtFor(c.req.valid("json").expiresInDays));
      if (!rotated)
        throw new NotFoundError("API token", id);
      const { token, record } = rotated;
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "api_token.rotated",
        resourceType: "api_token",
        resourceId: record.id,
        resourceName: record.name,
        detail: { expiresAt: record.expiresAt },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({
        success: true,
        data: { ...record, token },
      });
    },
  );

  router.delete(
    "/account/me/tokens/:id",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Revoke an API token",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Token revoked"),
        ...errors(401, 403, 404),
      },
    }),
    validator("param", z.object({
      id: z.string(),
    })),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const { id } = c.req.valid("param");
      const revoked = await deleteApiToken(db, user.id, id);
      if (!revoked)
        throw new NotFoundError("API token", id);
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "api_token.revoked",
        resourceType: "api_token",
        resourceId: id,
        resourceName: revoked.name,
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );

  return router;
}
