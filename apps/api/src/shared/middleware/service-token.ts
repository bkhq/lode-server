import type { AppEnv } from "@/shared/lib/types";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createMiddleware } from "hono/factory";

export type ServiceTokenScope = "metrics" | "backup";

const SCOPED_FIELD: Record<ServiceTokenScope, "SERVICE_TOKEN_METRICS" | "SERVICE_TOKEN_BACKUP"> = {
  metrics: "SERVICE_TOKEN_METRICS",
  backup: "SERVICE_TOKEN_BACKUP",
};

export function serviceTokenRequired(scope: ServiceTokenScope) {
  const field = SCOPED_FIELD[scope];
  return createMiddleware<AppEnv>(async (c, next) => {
    const expected = c.get("config")[field];
    if (!expected) {
      return c.json(
        { success: false, error: { code: "SERVICE_TOKEN_DISABLED", message: "Service-token authentication is not configured" } },
        503,
      );
    }

    const auth = c.req.header("authorization");
    const supplied = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
    if (!supplied) {
      return c.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Service token required" } },
        401,
      );
    }

    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return c.json(
        { success: false, error: { code: "UNAUTHORIZED", message: "Invalid service token" } },
        401,
      );
    }

    return next();
  });
}
