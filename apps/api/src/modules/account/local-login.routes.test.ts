import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { sessions } from "@/modules/account/auth/schema";
import { users, userTotpDevices } from "@/modules/account/users/schema";
import { errorHandler } from "@/shared/middleware/error-handler";
import { accountRoutes } from "./account.routes";
import { createLocalUser } from "./users/local-users.service";
import "@/modules/account";

const noop = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  flush() {},
} as unknown as Logger;
const PASSWORD = "correct horse battery";

let dir: string;
let db: AppDatabase;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "local-login-routes-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function app(overrides: Partial<Config> = {}): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", {
      NODE_ENV: "test",
      TRUST_PROXY: false,
      BASE_PATH: "",
      SESSION_MAX_AGE: 86400,
      DEFAULT_ADMIN: "",
      LOCAL_LOGIN: true,
      SINGLE_USER_MODE: false,
      ...overrides,
    } as unknown as Config);
    c.set("logger", noop);
    await next();
  });
  a.route("/", accountRoutes());
  a.onError(errorHandler);
  return a;
}

function post(a: Hono<AppEnv>, path: string, body: unknown, cookie?: string): Promise<Response> {
  return Promise.resolve(a.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...cookie
        ? { Cookie: cookie }
        : {},
    },
    body: JSON.stringify(body),
  }));
}

function cookieOf(res: Response): string {
  return (res.headers.getSetCookie()[0] ?? "").split(";")[0]!;
}

async function adminCookie(): Promise<string> {
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: "adm",
    oauthSub: "local:adm",
    username: "adm",
    name: "Adm",
    email: "adm@t.io",
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return `session_id=${await createSession(db, "adm", "tok", undefined, 3600)}`;
}

describe("POST /account/auth/login-local with LOCAL_LOGIN", () => {
  test("signs a database account in; the session then works", async () => {
    await createLocalUser(db, {
      username: "alice",
      name: "Alice",
      email: "a@t.io",
      role: "user",
      password: PASSWORD,
    });
    const res = await post(app(), "/account/auth/login-local", { username: "Alice", password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toContain("session_id=");
    const me = await app().request("/account/me", {
      headers: { Cookie: cookie },
    });
    expect(((await me.json()) as { data: { username: string } }).data.username).toBe("alice");
  });

  test("a wrong password, an unknown user and a passwordless account all answer the same 401", async () => {
    await createLocalUser(db, {
      username: "alice",
      name: "Alice",
      email: "a@t.io",
      role: "user",
      password: PASSWORD,
    });
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "idp",
      oauthSub: "s",
      username: "idp",
      name: "i",
      email: "i@t.io",
      role: "user",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    const bodies = [];
    for (const [username, password] of [
      ["alice", "wrong"],
      ["ghost", PASSWORD],
      ["idp", PASSWORD],
    ] as const) {
      const res = await post(app(), "/account/auth/login-local", { username, password });
      expect(res.status).toBe(401);
      bodies.push(await res.json());
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  test("locks the username after repeated failures", async () => {
    await createLocalUser(db, {
      username: "alice",
      name: "Alice",
      email: "a@t.io",
      role: "user",
      password: PASSWORD,
    });
    let last = 0;
    for (let i = 0; i < 10; i++)
      last = (await post(app(), "/account/auth/login-local", { username: "alice", password: "wrong" })).status;
    expect(last).toBe(429);
    expect((await post(app(), "/account/auth/login-local", { username: "alice", password: PASSWORD })).status).toBe(429);
  });

  test("with two-step verification on, no session yet: a pending challenge instead", async () => {
    const u = await createLocalUser(db, {
      username: "alice",
      name: "Alice",
      email: "a@t.io",
      role: "user",
      password: PASSWORD,
    });
    await db.insert(userTotpDevices).values({
      id: "d",
      userId: u.id,
      name: "phone",
      secret: "JBSWY3DPEHPK3PXP",
      verified: true,
    }).run();
    const res = await post(app(), "/account/auth/login-local", { username: "alice", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { totpRequired?: boolean } }).data.totpRequired).toBe(true);
    expect(res.headers.getSetCookie().join(";")).toContain("totp_pending=");
    expect(res.headers.getSetCookie().join(";")).not.toContain("session_id=");
    expect(await db.select().from(sessions).all()).toEqual([]);
  });

  test("is off unless LOCAL_LOGIN is set", async () => {
    await createLocalUser(db, {
      username: "alice",
      name: "Alice",
      email: "a@t.io",
      role: "user",
      password: PASSWORD,
    });
    const res = await post(app({ LOCAL_LOGIN: false }), "/account/auth/login-local", { username: "alice", password: PASSWORD });
    expect(res.status).toBe(404);
  });
});

describe("GET /account/auth/mode", () => {
  test("reports password login next to OAuth, which stays on offer", async () => {
    const res = await app({
      OAUTH_CLIENT_ID: "c",
      OAUTH_AUTHORIZE_URL: "https://i/a",
      OAUTH_TOKEN_URL: "https://i/t",
      OAUTH_USERINFO_URL: "https://i/u",
    }).request("/account/auth/mode");
    expect(((await res.json()) as { data: unknown }).data).toEqual({ mode: "oauth", oauthConfigured: true, localLogin: true });
  });

  test("localLogin is false when the flag is off", async () => {
    const res = await app({ LOCAL_LOGIN: false }).request("/account/auth/mode");
    expect(((await res.json()) as { data: { localLogin: boolean } }).data.localLogin).toBe(false);
  });
});

describe("admin creates users", () => {
  const input = {
    username: "bob",
    name: "Bob",
    email: "bob@t.io",
    role: "user",
    password: PASSWORD,
  };

  test("creates an account that can then sign in, and never returns the hash", async () => {
    const cookie = await adminCookie();
    const res = await post(app(), "/account/users", input, cookie);
    expect(res.status).toBe(201);
    expect(JSON.stringify(await res.json())).not.toMatch(/passwordHash|pbkdf2/);
    expect((await post(app(), "/account/auth/login-local", { username: "bob", password: PASSWORD })).status).toBe(200);
    // Nor does any read of the user directory.
    const list = await app().request("/account/users", {
      headers: { Cookie: cookie },
    });
    const one = await app().request(`/account/users/${((await (await post(app(), "/account/users", { ...input, username: "dan", email: "d@t.io" }, cookie)).json()) as { data: { id: string } }).data.id}`, {
      headers: { Cookie: cookie },
    });
    expect(await list.text()).not.toMatch(/passwordHash|password_hash|pbkdf2/);
    expect(await one.text()).not.toMatch(/passwordHash|password_hash|pbkdf2/);
  });

  test("is admin-only", async () => {
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u",
      oauthSub: "s",
      username: "u",
      name: "u",
      email: "u@t.io",
      role: "user",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    const cookie = `session_id=${await createSession(db, "u", "tok", undefined, 3600)}`;
    expect((await post(app(), "/account/users", input, cookie)).status).toBe(403);
    expect((await post(app(), "/account/users/u/password", { password: PASSWORD }, cookie)).status).toBe(403);
    expect((await post(app(), "/account/users", input)).status).toBe(401);
  });

  test("refuses a short password, a bad username, a duplicate and a deployment without LOCAL_LOGIN", async () => {
    const cookie = await adminCookie();
    expect((await post(app(), "/account/users", { ...input, password: "short" }, cookie)).status).toBe(422);
    expect((await post(app(), "/account/users", { ...input, username: "bad name!" }, cookie)).status).toBe(422);
    expect((await post(app(), "/account/users", input, cookie)).status).toBe(201);
    expect((await post(app(), "/account/users", input, cookie)).status).toBe(409);
    const off = await post(app({ LOCAL_LOGIN: false }), "/account/users", { ...input, username: "carol", email: "c@t.io" }, cookie);
    expect(off.status).toBe(409);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe("LOCAL_LOGIN_DISABLED");
  });

  test("resetting a password ends that user's sessions and swaps the credential", async () => {
    const cookie = await adminCookie();
    const created = ((await (await post(app(), "/account/users", input, cookie)).json()) as { data: { id: string } }).data;
    const bobCookie = cookieOf(await post(app(), "/account/auth/login-local", { username: "bob", password: PASSWORD }));
    expect((await app().request("/account/me", {
      headers: { Cookie: bobCookie },
    })).status).toBe(200);

    expect((await post(app(), `/account/users/${created.id}/password`, { password: "a different passphrase" }, cookie)).status).toBe(200);
    expect((await app().request("/account/me", {
      headers: { Cookie: bobCookie },
    })).status).toBe(401);
    expect((await post(app(), "/account/auth/login-local", { username: "bob", password: PASSWORD })).status).toBe(401);
    expect((await post(app(), "/account/auth/login-local", { username: "bob", password: "a different passphrase" })).status).toBe(200);
  });

  test("a password reset for an unknown user is a 404", async () => {
    const cookie = await adminCookie();
    expect((await post(app(), "/account/users/ghost/password", { password: PASSWORD }, cookie)).status).toBe(404);
  });
});
