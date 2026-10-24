import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { users } from "@/modules/account/users/schema";
import { auditEvents } from "@/modules/audit/schema";
import { nanoid } from "@/shared/lib/id";
import { errorHandler } from "@/shared/middleware/error-handler";
import { policyRoutes } from "./policy.routes";
import { DIRECT_SUBJECT, relationTuples } from "./schema";
// Importing the account module registers the session-cookie auth provider
// that `authRequired` resolves through — without it the middleware throws.
import "@/modules/account";

const stubLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
} as unknown as Logger;

function baseConfig(): Config {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    HOST: "127.0.0.1",
    DB_PATH: "data/db/app.db",
    DB_ENCRYPTION: false,
    APP_NAME: "app",
    APP_DISPLAY_NAME: "App",
    BASE_PATH: "",
    LOG_LEVEL: "info",
    LOG_FILE: "data/logs/app.log",
    LOG_TO_STDOUT: false,
    CORS_ORIGIN: undefined,
    TRUST_PROXY: false,
    TRUSTED_PROXY_IPS: "",
    ENABLE_EXPERIMENTAL_DEK_ROTATION: false,
    CRON_ENABLED: false,
    CRON_ACTIONS_ENABLED: [],
    HTTP_ACTION_ALLOW_PRIVATE: false,
    HTTP_ACTION_TIMEOUT_SECONDS: 30,
    SHELL_ACTION_TIMEOUT_SECONDS: 300,
    OAUTH_CLIENT_ID: undefined,
    OAUTH_CLIENT_SECRET: undefined,
    OAUTH_ISSUER: undefined,
    OAUTH_AUTHORIZE_URL: undefined,
    OAUTH_TOKEN_URL: undefined,
    OAUTH_USERINFO_URL: undefined,
    OAUTH_PKCE: true,
    OAUTH_SCOPES: "openid profile email",
    HOME_PAGE: "off",
    LOCAL_LOGIN: false,
    SESSION_MAX_AGE: 86400,
    AUDIT_RETENTION_DAYS: 0,
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
    MAX_ATTACHMENTS_PER_RESOURCE: 20,
    UPLOADS_TOTAL_BYTES: 0,
    FILE_STORAGE_DRIVER: "local",
    FILE_STORAGE_LOCAL_ROOT: "data/uploads/files",
    FILE_GC_MODE: "async",
    FILE_GC_INTERVAL_SECONDS: 3600,
    FILE_PRESIGN_ENABLED: true,
    FILE_PRESIGN_TTL_SECONDS: 300,
    DEFAULT_ADMIN: "",
    SINGLE_USER_MODE: false,
    SINGLE_USER_USERNAME: undefined,
    SINGLE_USER_PASSWORD_HASH: undefined,
    SINGLE_USER_PASSWORD_HASH_FILE: undefined,
    SINGLE_USER_NAME: undefined,
    SINGLE_USER_EMAIL: undefined,
    APP_URL: undefined,
    OIDC_LOGOUT_URL: undefined,
    SERVICE_TOKEN_METRICS: undefined,
    SERVICE_TOKEN_BACKUP: undefined,
    BACKUP_EXPORT_MIN_INTERVAL_SECONDS: 0,
    MASTER_PASSWORD_FILE: undefined,
  } as unknown as Config;
}

function buildApp(db: AppDatabase): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", baseConfig());
    c.set("logger", stubLogger);
    await next();
  });
  app.route("/", policyRoutes());
  app.onError(errorHandler);
  return app;
}

let db: AppDatabase;
let dbPath: string;

async function seedUser(role: "admin" | "user"): Promise<string> {
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
  return id;
}

/** Seed a user + a live session and return the Cookie header for it. */
async function sessionCookieFor(role: "admin" | "user"): Promise<{ userId: string; cookie: string }> {
  const userId = await seedUser(role);
  const sessionId = await createSession(db, userId, "test-access-token", undefined, 3600);
  return { userId, cookie: `session_id=${sessionId}` };
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-policy-routes-${Date.now()}-${nanoid()}`);
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

describe("auth/admin gating", () => {
  test("GET /policy/resource-groups → 401 without a session", async () => {
    const app = buildApp(db);
    const res = await app.request("/policy/resource-groups");
    expect(res.status).toBe(401);
  });

  test("GET /policy/resource-groups → 403 for a non-admin user", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("user");
    const res = await app.request("/policy/resource-groups", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  test("POST /policy/resource-groups → 401 without a session", async () => {
    const app = buildApp(db);
    const res = await app.request("/policy/resource-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("PATCH /policy/resource-groups/:id → 403 for a non-admin user", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("user");
    const res = await app.request("/policy/resource-groups/abc12345", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("GET /policy/resource-groups/:id/members → 401 without a session", async () => {
    const app = buildApp(db);
    const res = await app.request("/policy/resource-groups/abc12345/members");
    expect(res.status).toBe(401);
  });

  test("POST /policy/resource-groups/:id/members → 403 for a non-admin user", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("user");
    const res = await app.request("/policy/resource-groups/abc12345/members", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ namespace: "item", objectId: "i-1" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /policy/resource-groups", () => {
  test("creates a resource group, returns 201 envelope, and writes an audit row", async () => {
    const app = buildApp(db);
    const { userId, cookie } = await sessionCookieFor("admin");

    const res = await app.request("/policy/resource-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ name: "prod", description: "production" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { success: boolean; data: { id: string; name: string; description: string | null } };
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("prod");
    expect(body.data.description).toBe("production");
    expect(body.data.id).toHaveLength(8);

    const auditRow = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "resource_group.created"), eq(auditEvents.actorId, userId)))
      .get();
    expect(auditRow).toBeDefined();
    expect(auditRow!.resourceId).toBe(body.data.id);
    expect(auditRow!.result).toBe("success");
  });

  test("rejects an invalid body with 422 (zod validation)", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("admin");
    const res = await app.request("/policy/resource-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json() as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("PATCH /policy/resource-groups/:id", () => {
  async function createGroup(cookie: string, app: Hono<AppEnv>): Promise<string> {
    const res = await app.request("/policy/resource-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ name: `g-${nanoid()}` }),
    });
    const body = await res.json() as { data: { id: string } };
    return body.data.id;
  }

  test("updates a resource group, returns the envelope, and writes an audit row", async () => {
    const app = buildApp(db);
    const { userId, cookie } = await sessionCookieFor("admin");
    const id = await createGroup(cookie, app);

    const res = await app.request(`/policy/resource-groups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ name: "renamed", description: "new desc" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { id: string; name: string; description: string | null } };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(id);
    expect(body.data.name).toBe("renamed");
    expect(body.data.description).toBe("new desc");

    const auditRow = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "resource_group.updated"), eq(auditEvents.actorId, userId)))
      .get();
    expect(auditRow).toBeDefined();
    expect(auditRow!.resourceId).toBe(id);
  });

  test("404s when the resource group does not exist", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("admin");
    const res = await app.request("/policy/resource-groups/missing1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  test("422s on an invalid body", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("admin");
    const id = await createGroup(cookie, app);
    const res = await app.request(`/policy/resource-groups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({
        name: "x".repeat(101),
      }),
    });
    expect(res.status).toBe(422);
  });
});

describe("resource-group members", () => {
  async function createGroup(cookie: string, app: Hono<AppEnv>): Promise<string> {
    const res = await app.request("/policy/resource-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ name: `g-${nanoid()}` }),
    });
    return (await res.json() as { data: { id: string } }).data.id;
  }

  test("GET members returns an empty list for a fresh group", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("admin");
    const id = await createGroup(cookie, app);

    const res = await app.request(`/policy/resource-groups/${id}/members`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test("POST member adds a member (201), writes audit, then GET lists it", async () => {
    const app = buildApp(db);
    const { userId, cookie } = await sessionCookieFor("admin");
    const id = await createGroup(cookie, app);

    const addRes = await app.request(`/policy/resource-groups/${id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      // `item` is a registered namespace (loaded by namespace-config defaults).
      body: JSON.stringify({ namespace: "item", objectId: "item-1" }),
    });
    expect(addRes.status).toBe(201);
    const addBody = await addRes.json() as { success: boolean; data: { tupleId: string; namespace: string; objectId: string } };
    expect(addBody.success).toBe(true);
    expect(addBody.data.namespace).toBe("item");
    expect(addBody.data.objectId).toBe("item-1");

    const auditRow = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "resource_group.member_added"), eq(auditEvents.actorId, userId)))
      .get();
    expect(auditRow).toBeDefined();
    expect(auditRow!.resourceId).toBe(id);

    const listRes = await app.request(`/policy/resource-groups/${id}/members`, {
      headers: { Cookie: cookie },
    });
    const listBody = await listRes.json() as { data: { objectId: string }[] };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]!.objectId).toBe("item-1");
  });

  test("POST member rejects an invalid namespace with 422", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("admin");
    const id = await createGroup(cookie, app);

    const res = await app.request(`/policy/resource-groups/${id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ namespace: "user", objectId: "u-1" }),
    });
    // Service throws ValidationError → AppError mapped to 422.
    expect(res.status).toBe(422);
  });

  test("POST member 404s for a non-existent group", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("admin");
    const res = await app.request("/policy/resource-groups/missing1/members", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ namespace: "item", objectId: "i-1" }),
    });
    expect(res.status).toBe(404);
  });

  test("DELETE member removes it (200), writes audit, and 404s the second time", async () => {
    const app = buildApp(db);
    const { userId, cookie } = await sessionCookieFor("admin");
    const id = await createGroup(cookie, app);

    const addRes = await app.request(`/policy/resource-groups/${id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ namespace: "item", objectId: "item-9" }),
    });
    const tupleId = (await addRes.json() as { data: { tupleId: string } }).data.tupleId;

    const delRes = await app.request(`/policy/resource-groups/${id}/members/${tupleId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json() as { success: boolean; data: null };
    expect(delBody.success).toBe(true);
    expect(delBody.data).toBeNull();

    const auditRow = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "resource_group.member_removed"), eq(auditEvents.actorId, userId)))
      .get();
    expect(auditRow).toBeDefined();
    expect(auditRow!.resourceName).toBe(tupleId);

    // tuple is gone
    const remaining = await db
      .select()
      .from(relationTuples)
      .where(eq(relationTuples.id, tupleId))
      .get();
    expect(remaining).toBeUndefined();

    const delAgain = await app.request(`/policy/resource-groups/${id}/members/${tupleId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(delAgain.status).toBe(404);
  });

  test("DELETE member → 401 without a session", async () => {
    const app = buildApp(db);
    const res = await app.request("/policy/resource-groups/g/members/t", { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /policy/tuples/:id", () => {
  let app: Hono<AppEnv> | undefined;
  beforeEach(() => {
    app = buildApp(db);
  });

  async function seedTuple(cookie: string, relation = "viewer"): Promise<string> {
    const res = await app!.request("/policy/tuples", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({
        namespace: "item",
        objectId: "doc-1",
        relation,
        subjectNamespace: "user",
        subjectId: "u1",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string } };
    return body.data.id;
  }

  async function patchRelation(cookie: string, id: string, relation: string) {
    return await app!.request(`/policy/tuples/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({ relation }),
    });
  }

  test("rewrites the relation and drops the old row", async () => {
    const { cookie } = await sessionCookieFor("admin");
    const id = await seedTuple(cookie);

    const res = await patchRelation(cookie, id, "editor");
    expect(res.status).toBe(200);

    const rows = await db.select().from(relationTuples).where(eq(relationTuples.objectId, "doc-1")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relation).toBe("editor");
  });

  test("an invalid relation is a 422 and leaves the original tuple untouched", async () => {
    const { cookie } = await sessionCookieFor("admin");
    const id = await seedTuple(cookie);

    const res = await patchRelation(cookie, id, "not-a-relation");
    expect(res.status).toBe(422);

    const row = await db.select().from(relationTuples).where(eq(relationTuples.id, id)).get();
    expect(row?.relation).toBe("viewer");
  });

  test("a relation that already exists for the same subject is a 422 and leaves the original untouched", async () => {
    const { cookie } = await sessionCookieFor("admin");
    const id = await seedTuple(cookie, "viewer");
    await seedTuple(cookie, "editor");

    const res = await patchRelation(cookie, id, "editor");
    expect(res.status).toBe(422);

    const rows = await db.select().from(relationTuples).where(eq(relationTuples.objectId, "doc-1")).all();
    expect(rows.map(r => r.relation).sort()).toEqual(["editor", "viewer"]);
  });

  test("refuses to rewrite a row into group:X#member like POST does", async () => {
    const { cookie, userId } = await sessionCookieFor("admin");
    // Legacy row from before group membership moved to group_members —
    // nothing can create one through the API any more, so seed it directly.
    const id = nanoid();
    await db.insert(relationTuples).values({
      id,
      namespace: "group",
      objectId: "g1",
      relation: "member",
      subjectNamespace: "user",
      subjectId: "u1",
      subjectRelation: DIRECT_SUBJECT,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    }).run();

    const res = await patchRelation(cookie, id, "member");
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/group membership/i);
  });
});

describe("POST /policy/tuples — group membership guard", () => {
  test("rejects group:X#member writes with 422 and points to the account route", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("admin");

    const res = await app.request("/policy/tuples", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({
        namespace: "group",
        objectId: "g1",
        relation: "member",
        subjectNamespace: "user",
        subjectId: "u1",
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json() as { success: boolean; error: { code: string; message: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/group membership/i);
  });

  test("batch endpoint rejects a payload that includes a group:X#member create", async () => {
    const app = buildApp(db);
    const { cookie } = await sessionCookieFor("admin");

    const res = await app.request("/policy/tuples/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie },
      body: JSON.stringify({
        create: [
          {
            namespace: "group",
            objectId: "g1",
            relation: "member",
            subjectNamespace: "user",
            subjectId: "u1",
          },
        ],
      }),
    });

    expect(res.status).toBe(422);
  });
});
