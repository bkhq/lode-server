import type { AppEnv } from "@/shared/lib/types";
import { createMiddleware } from "hono/factory";
import { getClientIp } from "@/shared/lib/client-ip";
import { ForbiddenError, UnauthorizedError } from "@/shared/lib/errors";
import { getAuthProvider } from "@/shared/middleware/auth-registry";

export const authRequired = createMiddleware<AppEnv>(async (c, next) => {
  // Idempotent: when the global `policyMiddleware` ran first it may
  // have already loaded the actor into `c.var.user` (it calls the same
  // provider). Skip the duplicate query in that case.
  if (c.get("user"))
    return next();
  const db = c.get("db");
  const user = await getAuthProvider()(db, c);
  if (!user) {
    const logger = c.get("logger");
    logger?.warn({ ip: getClientIp(c), path: c.req.path, method: c.req.method }, "auth rejected: no valid session");
    throw new UnauthorizedError();
  }
  c.set("user", user);
  return next();
});

export const adminRequired = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (!user)
    throw new UnauthorizedError();
  if (user.role !== "admin")
    throw new ForbiddenError();

  return next();
});
