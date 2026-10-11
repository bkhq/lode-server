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
import { users } from "@/modules/account/users/schema";
import { errorHandler } from "@/shared/middleware/error-handler";
import { groupRoutes } from "./groups.routes";
import { addGroupMember, createGroup, getGroupByName, getGroupMembers } from "./groups.service";
import { syncIdpGroups } from "./idp-sync";
import "@/modules/account";

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

let dir: string;
let db: AppDatabase;
let cookie: string;

async function seedUser(id: string, role: "admin" | "user"): Promise<string> {
  const now = new Date().toISOString();
  await db.insert(users).values({ id, oauthSub: `sub-${id}`, username: id, name: id, email: `${id}@t.io`, role, status: "active", createdAt: now, updatedAt: now }).run();
  return id;
}

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "groups-routes-"));
  db = await createDb(resolve(dir, "app.db"));
  const admin = await seedUser("admin", "admin");
  cookie = `session_id=${await createSession(db, admin, "tok", undefined, 3600)}`;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function app(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", { NODE_ENV: "test", TRUST_PROXY: false, BASE_PATH: "" } as unknown as Config);
    c.set("logger", noop);
    await next();
  });
  a.route("/", groupRoutes());
  a.onError(errorHandler);
  return a;
}

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return Promise.resolve(app().request(path, {
    method,
    headers: { "Cookie": cookie, "Content-Type": "application/json" },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  }));
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("IdP-managed groups", () => {
  // Every login rewrites these memberships from the IdP claim, so a manual
  // edit would be silently undone; a rename would detach the group from the
  // claim value it mirrors. Both are refused up front.
  test("refuse adding a member by hand", async () => {
    const u = await seedUser("u1", "user");
    await syncIdpGroups(db, "admin", ["eng"], noop);
    const group = (await getGroupByName(db, "eng"))!;
    const res = await send("POST", `/account/groups/${group.id}/members`, { userId: u });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("GROUP_MANAGED_BY_IDP");
    expect((await getGroupMembers(db, group.id)).map(m => m.id)).toEqual(["admin"]);
  });

  test("refuse removing a member by hand", async () => {
    await syncIdpGroups(db, "admin", ["eng"], noop);
    const group = (await getGroupByName(db, "eng"))!;
    const res = await send("DELETE", `/account/groups/${group.id}/members/admin`);
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("GROUP_MANAGED_BY_IDP");
  });

  test("refuse a rename but allow a description edit", async () => {
    await syncIdpGroups(db, "admin", ["eng"], noop);
    const group = (await getGroupByName(db, "eng"))!;
    const rename = await send("PATCH", `/account/groups/${group.id}`, { name: "engineering" });
    expect(rename.status).toBe(409);
    expect(await errorCode(rename)).toBe("GROUP_MANAGED_BY_IDP");
    const describe = await send("PATCH", `/account/groups/${group.id}`, { description: "from the IdP" });
    expect(describe.status).toBe(200);
  });

  test("report their source", async () => {
    await syncIdpGroups(db, "admin", ["eng"], noop);
    await createGroup(db, { name: "local-team" });
    const res = await send("GET", "/account/groups");
    const list = ((await res.json()) as { data: { name: string; source: string }[] }).data;
    expect(Object.fromEntries(list.map(g => [g.name, g.source]))).toEqual({ "eng": "idp", "local-team": "local" });
  });

  test("local groups still take manual edits", async () => {
    const u = await seedUser("u1", "user");
    const group = await createGroup(db, { name: "local-team" });
    expect((await send("POST", `/account/groups/${group.id}/members`, { userId: u })).status).toBe(201);
    await addGroupMember(db, group.id, "admin");
    expect((await send("DELETE", `/account/groups/${group.id}/members/admin`)).status).toBe(200);
    expect((await send("PATCH", `/account/groups/${group.id}`, { name: "renamed" })).status).toBe(200);
  });
});
