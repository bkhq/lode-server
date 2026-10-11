import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { AppError, NotFoundError } from "@/shared/lib/errors";
import { errorHandler } from "./error-handler";

const captured: { msg: string; ctx: unknown }[] = [];
const stubLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (ctx: unknown, msg: string) => captured.push({ ctx, msg }),
  fatal: () => {},
  flush: () => {},
} as unknown as Logger;

afterEach(() => {
  captured.length = 0;
});

function buildApp(thrown: Error) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("logger", stubLogger);
    return next();
  });
  app.get("/p", () => {
    throw thrown;
  });
  app.onError(errorHandler);
  return app;
}

describe("errorHandler", () => {
  test("returns AppError.toJSON with its statusCode", async () => {
    const app = buildApp(new AppError("nope", 418, "TEAPOT"));
    const res = await app.request("/p");
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({ success: false, error: { code: "TEAPOT", message: "nope" } });
  });

  test("specialized AppError subclasses pass through", async () => {
    const app = buildApp(new NotFoundError("user", "u_1"));
    const res = await app.request("/p");
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  test("a constraint error wrapped by drizzle (code/message on .cause) still maps to 409", async () => {
    const driverErr = Object.assign(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: groups.name"), { code: "SQLITE_CONSTRAINT" });
    const wrapped = new Error("Failed query: insert into \"groups\" ...", { cause: driverErr });
    const res = await buildApp(wrapped).request("/p");
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  test("non-AppError errors return 500 INTERNAL_ERROR and log via logger.error", async () => {
    const app = buildApp(new Error("kaboom"));
    const res = await app.request("/p");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    expect(captured.length).toBe(1);
    expect(captured[0]!.msg).toBe("unhandled error");
  });
});

describe("errorHandler — an AppError wrapped by the query layer", () => {
  test("answers with the wrapped AppError's status, not 500", async () => {
    // drizzle wraps anything a driver throws in DrizzleQueryError, with the
    // original on `.cause`. An AppError raised below the query layer — the
    // write lock's DB_BUSY — must still reach the client as itself.
    const wrapped = new Error("Failed query: INSERT INTO t VALUES (1)", {
      cause: new AppError("The database is busy. Try again shortly.", 503, "DB_BUSY"),
    });
    const res = await buildApp(wrapped).request("/p");
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("DB_BUSY");
  });

  test("an error with no AppError in its chain is still a 500", async () => {
    const res = await buildApp(new Error("boom", { cause: new Error("deeper") })).request("/p");
    expect(res.status).toBe(500);
  });
});
