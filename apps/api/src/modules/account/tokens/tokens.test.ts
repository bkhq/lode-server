import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { users } from "@/modules/account/users/schema";
import { __isolateTokenScopesForTests, registerTokenScope } from "@/shared/lib/token-scopes";
import { authRequired } from "@/shared/middleware/auth";
import { errorHandler } from "@/shared/middleware/error-handler";
import { apiTokens } from "./schema";
import { tokenRoutes } from "./tokens.routes";
import { createApiToken, deleteApiToken, listApiTokens } from "./tokens.service";
import "@/modules/account";

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

let dir: string;
let db: AppDatabase;
let restoreScopes: () => void;

async function seedUser(id: string, status: "active" | "disabled" = "active"): Promise<string> {
  const now = new Date().toISOString();
  await db.insert(users).values({ id, oauthSub: `sub-${id}`, username: id, name: id, email: `${id}@t.io`, role: "user", status, createdAt: now, updatedAt: now }).run();
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "api-tokens-"));
  db = await createDb(resolve(dir, "app.db"));
  restoreScopes = __isolateTokenScopesForTests();
  registerTokenScope({ name: "things:read", description: "Read things", routes: [{ method: "GET", path: "/things" }, { method: "GET", path: "/things/*" }] });
  registerTokenScope({ name: "things:write", description: "Change things", routes: [{ method: "POST", path: "/things" }] });
});

afterEach(() => {
  restoreScopes();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// An app shaped like the real one: bodies mounted under /api, a guarded
// module route, and the token routes themselves.
function app(basePath = ""): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", { NODE_ENV: "test", TRUST_PROXY: false, BASE_PATH: basePath } as unknown as Config);
    c.set("logger", noop);
    await next();
  });
  api.use("/things/*", authRequired);
  api.get("/things", c => c.json({ user: c.get("user")!.id }));
  api.get("/things/:id", c => c.json({ id: c.req.param("id") }));
  api.post("/things", c => c.json({ created: true }, 201));
  api.delete("/things/:id", c => c.json({ deleted: true }));
  api.route("/", tokenRoutes());
  api.onError(errorHandler);
  const root = new Hono<AppEnv>();
  root.route(`${basePath}/api`, api);
  return root;
}

function bearer(token: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } };
}

describe("api token service", () => {
  test("returns the secret once and stores only its hash", async () => {
    const u = await seedUser("u1");
    const { token, record } = await createApiToken(db, u, { name: "ci", scopes: ["things:read"], expiresAt: null });
    expect(token.startsWith("pat_")).toBe(true);
    const row = (await db.select().from(apiTokens).where(eq(apiTokens.id, record.id)).get())!;
    expect(JSON.stringify(row)).not.toContain(token.slice(4));
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const listed = await listApiTokens(db, u);
    expect(listed.map(t => t.name)).toEqual(["ci"]);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");
  });

  test("a user can delete only their own tokens", async () => {
    const a = await seedUser("a");
    const b = await seedUser("b");
    const { record } = await createApiToken(db, a, { name: "ci", scopes: ["things:read"], expiresAt: null });
    expect(await deleteApiToken(db, b, record.id)).toBeUndefined();
    expect((await deleteApiToken(db, a, record.id))?.name).toBe("ci");
  });
});

describe("api token authentication", () => {
  test("a token reaches routes its scopes cover, as its user", async () => {
    const u = await seedUser("u1");
    const { token } = await createApiToken(db, u, { name: "ci", scopes: ["things:read"], expiresAt: null });
    const res = await app().request("/api/things", bearer(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: "u1" });
    expect((await app().request("/api/things/42", bearer(token))).status).toBe(200);
  });

  test("works under a BASE_PATH", async () => {
    const u = await seedUser("u1");
    const { token } = await createApiToken(db, u, { name: "ci", scopes: ["things:read"], expiresAt: null });
    expect((await app("/app").request("/app/api/things", bearer(token))).status).toBe(200);
  });

  test("a route outside the token's scopes is forbidden", async () => {
    const u = await seedUser("u1");
    const { token } = await createApiToken(db, u, { name: "ci", scopes: ["things:read"], expiresAt: null });
    expect((await app().request("/api/things", bearer(token, { method: "POST" }))).status).toBe(403);
  });

  test("a route no scope covers is forbidden to every token", async () => {
    const u = await seedUser("u1");
    const { token } = await createApiToken(db, u, { name: "ci", scopes: ["things:read", "things:write"], expiresAt: null });
    expect((await app().request("/api/things/42", bearer(token, { method: "DELETE" }))).status).toBe(403);
  });

  test("a token cannot list, create or delete tokens", async () => {
    const u = await seedUser("u1");
    const { token, record } = await createApiToken(db, u, { name: "ci", scopes: ["things:read", "things:write"], expiresAt: null });
    expect((await app().request("/api/account/me/tokens", bearer(token))).status).toBe(403);
    expect((await app().request("/api/account/me/tokens", bearer(token, { method: "POST", body: JSON.stringify({ name: "x", scopes: ["things:read"] }), headers: { "Content-Type": "application/json" } }))).status).toBe(403);
    expect((await app().request(`/api/account/me/tokens/${record.id}`, bearer(token, { method: "DELETE" }))).status).toBe(403);
  });

  test("an unknown, deleted or expired token is unauthenticated", async () => {
    const u = await seedUser("u1");
    expect((await app().request("/api/things", bearer("pat_nope"))).status).toBe(401);

    const deleted = await createApiToken(db, u, { name: "gone", scopes: ["things:read"], expiresAt: null });
    await deleteApiToken(db, u, deleted.record.id);
    expect((await app().request("/api/things", bearer(deleted.token))).status).toBe(401);

    const expired = await createApiToken(db, u, { name: "old", scopes: ["things:read"], expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await app().request("/api/things", bearer(expired.token))).status).toBe(401);
  });

  test("a disabled user's token is unauthenticated", async () => {
    const u = await seedUser("u1", "disabled");
    const { token } = await createApiToken(db, u, { name: "ci", scopes: ["things:read"], expiresAt: null });
    expect((await app().request("/api/things", bearer(token))).status).toBe(401);
  });

  test("records when a token was last used", async () => {
    const u = await seedUser("u1");
    const { token, record } = await createApiToken(db, u, { name: "ci", scopes: ["things:read"], expiresAt: null });
    expect(record.lastUsedAt).toBeNull();
    await app().request("/api/things", bearer(token));
    expect((await listApiTokens(db, u))[0]!.lastUsedAt).not.toBeNull();
  });
});

describe("token routes (session)", () => {
  async function sessionCookie(userId: string): Promise<string> {
    return `session_id=${await createSession(db, userId, "tok", undefined, 3600)}`;
  }

  test("create returns the secret once, list omits it, delete removes it", async () => {
    const u = await seedUser("u1");
    const cookie = await sessionCookie(u);
    const created = await app().request("/api/account/me/tokens", {
      method: "POST",
      headers: { "Cookie": cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ci", scopes: ["things:read"], expiresInDays: 30 }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: { token: string; id: string; expiresAt: string | null } };
    expect(body.data.token.startsWith("pat_")).toBe(true);
    expect(body.data.expiresAt).not.toBeNull();

    const list = (await (await app().request("/api/account/me/tokens", { headers: { Cookie: cookie } })).json()) as { data: Record<string, unknown>[] };
    expect(list.data.length).toBe(1);
    expect(JSON.stringify(list.data)).not.toContain(body.data.token);

    expect((await app().request(`/api/account/me/tokens/${body.data.id}`, { method: "DELETE", headers: { Cookie: cookie } })).status).toBe(200);
    expect((await app().request("/api/things", bearer(body.data.token))).status).toBe(401);
  });

  test("rejects an unregistered or empty scope list", async () => {
    const cookie = await sessionCookie(await seedUser("u1"));
    for (const scopes of [["nope:read"], []]) {
      const res = await app().request("/api/account/me/tokens", {
        method: "POST",
        headers: { "Cookie": cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ci", scopes }),
      });
      expect(res.status).toBe(422);
    }
  });

  test("lists the registered scopes", async () => {
    const cookie = await sessionCookie(await seedUser("u1"));
    const res = await app().request("/api/account/token-scopes", { headers: { Cookie: cookie } });
    const names = ((await res.json()) as { data: { name: string }[] }).data.map(s => s.name);
    expect(names).toEqual(["things:read", "things:write"]);
  });
});
