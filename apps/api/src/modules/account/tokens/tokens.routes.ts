import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { getTokenScopes, isTokenScope } from "@/shared/lib/token-scopes";
import { authRequired } from "@/shared/middleware/auth";
import { createApiToken, deleteApiToken, listApiTokens } from "./tokens.service";

const tokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string()).min(1).refine(scopes => scopes.every(isTokenScope), { message: "Unknown scope" }),
  // Omitted → the token does not expire.
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

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
        ...jsonOk(z.array(z.object({ name: z.string(), description: z.string() })), "Registered scopes"),
        ...errors(401),
      },
    }),
    c => c.json({ success: true, data: getTokenScopes() }),
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
        ...jsonCreated(tokenSchema.extend({ token: z.string() }), "Token created"),
        ...errors(401, 403, 409, 422),
      },
    }),
    validator("json", createTokenSchema),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const body = c.req.valid("json");
      const expiresAt = body.expiresInDays === undefined
        ? null
        : new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString();
      const { token, record } = await createApiToken(db, user.id, { name: body.name, scopes: body.scopes, expiresAt });
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "api_token.created",
        resourceType: "api_token",
        resourceId: record.id,
        resourceName: record.name,
        detail: { scopes: record.scopes, expiresAt: record.expiresAt },
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });
      return c.json({ success: true, data: { ...record, token } }, 201);
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
    validator("param", z.object({ id: z.string() })),
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
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );

  return router;
}
