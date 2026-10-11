import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "@/shared/lib/types";
import { ZodError } from "zod";
import { findAppError, isConstraintViolation } from "@/shared/lib/errors";

export function errorHandler(err: Error, c: Context<AppEnv>) {
  // Walk the cause chain: an AppError raised beneath a query arrives wrapped.
  const appError = findAppError(err);
  if (appError) {
    return c.json(appError.toJSON(), appError.statusCode as ContentfulStatusCode);
  }

  if (err instanceof ZodError) {
    return c.json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Validation failed", details: err.flatten() },
    }, 422);
  }

  // SQLite/libsql constraint violations are the DB-level backstop for
  // check-then-write races (group/cron unique name, relation tuples).
  // Surface them as an actionable 409 instead of an opaque 500. The raw
  // message can name columns, so keep the response generic. Drizzle wraps
  // the driver error in DrizzleQueryError, so the code/message live on
  // `.cause` — walk the chain instead of trusting the outer error.
  if (isConstraintViolation(err)) {
    return c.json({
      success: false,
      error: { code: "CONFLICT", message: "Resource already exists or violates a constraint" },
    }, 409);
  }

  c.get("logger").error({ err }, "unhandled error");
  return c.json({ success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
}
