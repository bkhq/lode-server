import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { users } from "@/modules/account/users/schema";
import { errorHandler } from "@/shared/middleware/error-handler";
import { systemRoutes } from "./system.routes";
import "@/modules/account";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);
const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

let db: AppDatabase;
let dbPath: string;

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-system-routes-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

function buildApp(opts: { locked?: boolean; metricsToken?: string } = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", { NODE_ENV: "test", TRUST_PROXY: false, MAX_UPLOAD_BYTES: 1024, MAX_ATTACHMENTS_PER_RESOURCE: 5, UPLOADS_TOTAL_BYTES: 0, SERVICE_TOKEN_METRICS: opts.metricsToken } as unknown as Config);
    c.set("logger", noopLogger);
    c.set("encryption", { isSystemLocked: () => opts.locked ?? false } as unknown as AppEnv["Variables"]["encryption"]);
    await next();
  });
  app.route("/", systemRoutes());
  app.onError(errorHandler);
  return app;
}

async function sessionFor(role: "admin" | "user"): Promise<string> {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({ id, oauthSub: `sub-${id}`, username: `u-${id}`, name: id, email: `${id}@t.io`, role, status: "active", createdAt: now, updatedAt: now }).run();
  return `session_id=${await createSession(db, id, "tok", undefined, 3600)}`;
}

describe("probes", () => {
  test("/health is a plain 200 with no auth", async () => {
    const res = await buildApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("/health/ready is 200 when unlocked and 503 'locked' while the system is locked", async () => {
    const ready = await buildApp().request("/health/ready");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });

    const locked = await buildApp({ locked: true }).request("/health/ready");
    expect(locked.status).toBe(503);
    expect(((await locked.json()) as { status: string }).status).toBe("locked");
  });
});

describe("guard layer", () => {
  test.each([
    ["GET", "/system/version"],
    ["POST", "/system/lode/restart"],
    ["POST", "/system/lode/update"],
    ["POST", "/system/lode/rollback"],
    ["POST", "/system/lode/hold"],
  ])("%s %s → 401 anonymous, 403 for a non-admin", async (method, path) => {
    const app = buildApp();
    expect((await app.request(path, { method })).status).toBe(401);
    const user = await sessionFor("user");
    expect((await app.request(path, { method, headers: { Cookie: user } })).status).toBe(403);
  });

  test("GET /system/version serves build info to an admin", async () => {
    const admin = await sessionFor("admin");
    const res = await buildApp().request("/system/version", { headers: { Cookie: admin } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { commit: string; version: string } };
    expect(typeof body.data.commit).toBe("string");
    expect(typeof body.data.version).toBe("string");
  });

  test("/metrics needs the metrics service token", async () => {
    expect((await buildApp().request("/metrics")).status).not.toBe(200);
    const withToken = buildApp({ metricsToken: "m".repeat(32) });
    expect((await withToken.request("/metrics")).status).toBe(401);
    expect((await withToken.request("/metrics", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await withToken.request("/metrics", { headers: { Authorization: `Bearer ${"m".repeat(32)}` } })).status).toBe(200);
  });

  test("/system/upload-limits needs a session", async () => {
    expect((await buildApp().request("/system/upload-limits")).status).toBe(401);
    const user = await sessionFor("user");
    expect((await buildApp().request("/system/upload-limits", { headers: { Cookie: user } })).status).toBe(200);
  });
});
