import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { coarsenPath, loggingMiddleware } from "./logging";

interface LogCall {
  ctx: Record<string, unknown>;
  msg: string;
}

function buildApp(): { app: Hono<AppEnv>; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const stub: Logger = {
    debug: () => {},
    info: (ctx: unknown, msg?: string) => calls.push({ ctx: ctx as Record<string, unknown>, msg: msg ?? "" }),
    warn: () => {},
    error: () => {},
    fatal: () => {},
    flush: () => {},
  } as unknown as Logger;

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("logger", stub);
    c.set("requestId", "test-rid");
    return next();
  });
  app.use("*", loggingMiddleware());
  app.get("/p", c => c.json({ ok: true }));
  app.get("/api/health", c => c.json({ status: "ok" }));
  app.get("/api/health/ready", c => c.json({ status: "ready" }));
  app.options("/p", c => c.body(null, 204));
  app.get("/boom", () => {
    throw new Error("boom");
  });
  return { app, calls };
}

describe("loggingMiddleware", () => {
  test("logs method, path, status, duration, requestId on success", async () => {
    const { app, calls } = buildApp();
    const res = await app.request("/p");
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    const c = calls[0]!;
    expect(c.msg).toBe("request completed");
    expect(c.ctx.method).toBe("GET");
    expect(c.ctx.path).toBe("/p");
    expect(c.ctx.status).toBe(200);
    expect(c.ctx.requestId).toBe("test-rid");
    expect(typeof c.ctx.duration).toBe("number");
    expect(c.ctx.duration as number).toBeGreaterThanOrEqual(0);
  });

  test("does not log /api/health, /api/health/ready, or OPTIONS preflights", async () => {
    const { app, calls } = buildApp();
    await app.request("/api/health");
    await app.request("/api/health/ready");
    await app.request("/p", { method: "OPTIONS" });
    expect(calls.length).toBe(0);
  });

  test("logs even when the handler throws", async () => {
    const { app, calls } = buildApp();
    app.onError((_err, c) => c.json({ error: { code: "X", message: "x" } }, 500));
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(calls.length).toBe(1);
    expect(calls[0]!.ctx.path).toBe("/boom");
  });
});

describe("coarsenPath", () => {
  test("preserves alphabetic route names", () => {
    expect(coarsenPath("/api/encryption/challenge")).toBe("/api/encryption/challenge");
    expect(coarsenPath("/api/account/auth/callback")).toBe("/api/account/auth/callback");
    expect(coarsenPath("/api/cron/actions")).toBe("/api/cron/actions");
    expect(coarsenPath("/api/backup/import")).toBe("/api/backup/import");
  });

  test("replaces 32+ hex segments (UUID / SHA / encrypted-blob hash)", () => {
    expect(coarsenPath("/api/files/abcdef0123456789abcdef0123456789")).toBe("/api/files/:id");
    expect(coarsenPath("/api/docs/00112233445566778899aabbccddeeff")).toBe("/api/docs/:id");
  });

  test("replaces all-digit segments of 4+ chars", () => {
    expect(coarsenPath("/api/issues/12345")).toBe("/api/issues/:id");
    expect(coarsenPath("/api/docs/9999/comments")).toBe("/api/docs/:id/comments");
  });

  test("preserves all-digit segments shorter than 4 chars (page numbers, etc.)", () => {
    expect(coarsenPath("/api/items/v2")).toBe("/api/items/v2");
    expect(coarsenPath("/api/x/123")).toBe("/api/x/123");
  });

  test("replaces 8+ char mixed-alphanum segments (nanoid / ULID)", () => {
    expect(coarsenPath("/api/jobs/abc123de")).toBe("/api/jobs/:id");
    expect(coarsenPath("/api/u/01H8XGJWBK1234567890abcd")).toBe("/api/u/:id");
  });

  test("preserves all-alpha segments even when 8+ chars", () => {
    expect(coarsenPath("/api/something")).toBe("/api/something");
    expect(coarsenPath("/api/encryption/challenge")).toBe("/api/encryption/challenge");
  });

  test("handles multiple replacements in one path", () => {
    expect(coarsenPath("/api/docs/abc123de/comments/9876"))
      .toBe("/api/docs/:id/comments/:id");
  });
});
