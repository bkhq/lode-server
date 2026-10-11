import type { AppDatabase } from "@/db";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { errorHandler } from "@/shared/middleware/error-handler";
import { policyMiddleware } from "./middleware";
import { registerRouteBinding } from "./route-registry";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-policy-mw-${Date.now()}-${nanoid()}`);
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

async function seedUser(role: "admin" | "user") {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: `user-${id}`,
    name: `User ${id}`,
    email: `${id}@test.com`,
    role,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return (await db.select().from(users).where(eq(users.id, id)).get())!;
}

describe("policyMiddleware — binding without a registered resource", () => {
  // The binding table is a process-wide singleton shared with every other
  // test file, so register under a path nothing else can match instead of
  // resetting the registry.
  const resourceName = `orphan-${nanoid()}`;
  const path = `/${resourceName}/:id`;
  registerRouteBinding({ resourceName, method: "GET", path, action: "read" });

  function buildApp(user: Awaited<ReturnType<typeof seedUser>>): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      c.set("user", user);
      await next();
    });
    app.use("*", policyMiddleware());
    app.get(path, c => c.json({ reached: true }));
    app.onError(errorHandler);
    return app;
  }

  test("fails closed for a non-admin actor instead of running the handler", async () => {
    const app = buildApp(await seedUser("user"));
    const res = await app.request(`/${resourceName}/x`);
    expect(res.status).toBe(500);
  });

  test("still short-circuits for admins", async () => {
    const app = buildApp(await seedUser("admin"));
    const res = await app.request(`/${resourceName}/x`);
    expect(res.status).toBe(200);
  });
});
