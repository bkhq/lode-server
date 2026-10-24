import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { users } from "@/modules/account/users/schema";
import { nanoid } from "@/shared/lib/id";
import { errorHandler } from "@/shared/middleware/error-handler";
import { protectedRoutes } from "./protected";

const noop = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  flush() {},
} as unknown as Logger;

let db: AppDatabase;
let dbPath: string;

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-protected-${Date.now()}-${nanoid()}`);
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

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", { NODE_ENV: "test", TRUST_PROXY: false, BASE_PATH: "" } as unknown as Config);
    c.set("logger", noop);
    c.set("encryption", {
      isSystemLocked: () => false,
    } as unknown as AppEnv["Variables"]["encryption"]);
    await next();
  });
  app.route("/", protectedRoutes());
  app.onError(errorHandler);
  return app;
}

async function sessionFor(role: "admin" | "user"): Promise<string> {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: `u-${id}`,
    name: id,
    email: `${id}@t.io`,
    role,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return `session_id=${await createSession(db, id, "tok", undefined, 3600)}`;
}

describe("protectedRoutes composition", () => {
  // Hono merges a sub-router's `use("*")` into the parent, where it applies
  // to every router mounted afterwards. A router-level admin guard must
  // therefore never be registered on "*" — it would silently make later
  // routers admin-only.
  test("a non-admin reaches routers mounted after cron (404 from the route, not 403 from cron's guard)", async () => {
    const user = await sessionFor("user");
    const res = await buildApp().request("/files/nope/metadata?ref=nope", {
      headers: { Cookie: user },
    });
    expect(res.status).toBe(404);
  });

  test("no module's auth guard reaches a public route mounted after the protected ones", async () => {
    // Every protected module used to guard with `use("*", authRequired)`,
    // which Hono merges into the parent as a guard on everything mounted
    // afterwards. A route that should be public had to be squeezed into
    // public.ts, ahead of them all. Guards are now scoped to each module's
    // own paths, so a route mounted later is left alone.
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("config", { NODE_ENV: "test", TRUST_PROXY: false, BASE_PATH: "" } as unknown as Config);
      c.set("logger", noop);
      c.set("encryption", {
        isSystemLocked: () => false,
      } as unknown as AppEnv["Variables"]["encryption"]);
      await next();
    });
    app.route("/", protectedRoutes());
    app.get("/probe/public", c => c.json({ ok: true }));
    app.onError(errorHandler);

    const res = await app.request("/probe/public");
    expect(res.status).toBe(200);
  });

  test("scoping the guards leaves every protected module guarded", async () => {
    const anonymous = buildApp();
    for (const path of [
      "/account/me",
      "/account/users",
      "/account/visible-users",
      "/account/groups",
      "/issues",
      "/documents",
      "/settings",
      "/audit",
      "/backup/modules",
      "/encryption/meta",
    ]) {
      const res = await anonymous.request(path);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });

  test("the backup sidecar reaches its export with a service token and no session", async () => {
    // It authenticates with a service token, not a session. The session
    // guards of the modules mounted before backup used to leak onto it, so
    // the sidecar got 401 however valid its token was.
    const token = "t".repeat(40);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("config", {
        NODE_ENV: "test",
        TRUST_PROXY: false,
        BASE_PATH: "",
        SERVICE_TOKEN_BACKUP: token,
        BACKUP_EXPORT_MIN_INTERVAL_SECONDS: 0,
      } as unknown as Config);
      c.set("logger", noop);
      c.set("encryption", {
        isSystemLocked: () => false,
      } as unknown as AppEnv["Variables"]["encryption"]);
      await next();
    });
    app.route("/", protectedRoutes());
    app.onError(errorHandler);

    const res = await app.request("/backup/export-via-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  test("cron itself stays admin-only", async () => {
    const user = await sessionFor("user");
    expect((await buildApp().request("/cron/actions", {
      headers: { Cookie: user },
    })).status).toBe(403);
    const admin = await sessionFor("admin");
    expect((await buildApp().request("/cron/actions", {
      headers: { Cookie: admin },
    })).status).toBe(200);
  });
});
