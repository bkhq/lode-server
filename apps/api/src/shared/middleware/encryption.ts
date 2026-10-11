import type { AppEnv } from "@/shared/lib/types";
import { createMiddleware } from "hono/factory";
import { AppError } from "@/shared/lib/errors";

export const requireUnlocked = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("encryption").isSystemLocked()) {
    throw new AppError("System is locked. Provide decryption key to unlock.", 503, "SYSTEM_LOCKED");
  }
  await next();
});
