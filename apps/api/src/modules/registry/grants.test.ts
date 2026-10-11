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
import { configSchema } from "@/config/schema";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { apiTokens } from "@/modules/account/tokens/schema";
import { users } from "@/modules/account/users/schema";
import { auditEvents } from "@/modules/audit/schema";
import { policyMiddleware } from "@/modules/policy";
import { tokenScopesAllow } from "@/shared/lib/token-scopes";
import { errorHandler } from "@/shared/middleware/error-handler";
import { assertUploadAllowed, getUsage, registryRoutes, resolveReadToken } from ".";
import {
  registryAssets,
  registryNamespaces,
  registryPackages,
  registryQuotas,
  registryTokenGrants,
  registryUploads,
  registryVersions,
} from "./schema";
import { deriveScopes } from "./token.service";
import "@/modules/account";

// A raw 32-byte ed25519 public key, base64url.
const KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

let dir: string;
let db: AppDatabase;
let config: Config;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "registry-grants-"));
  db = await createDb(resolve(dir, "app.db"));
  config = configSchema.parse({ NODE_ENV: "test", REGISTRY_MAX_PACKAGES_PER_USER: "3" });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Shaped like the real `/api` sub-app: request context, the global policy
// middleware, then the module's routes.
function app(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("logger", noop);
    await next();
  });
  api.use("*", policyMiddleware({ basePath: "/api" }));
  api.route("/", registryRoutes());
  api.onError(errorHandler);
  const root = new Hono<AppEnv>();
  root.route("/api", api);
  return root;
}

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

interface Client {
  readonly id: string;
  readonly call: Call;
}

function caller(headers: Record<string, string>): Call {
  return async (method, path, body) => await app().request(`/api/registry${path}`, {
    method,
    headers: { ...headers, "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function seedUser(id: string, role: "user" | "admin" = "user"): Promise<Client> {
  const now = new Date().toISOString();
  await db.insert(users).values({ id, oauthSub: `sub-${id}`, username: id, name: id, email: `${id}@t.io`, role, status: "active", createdAt: now, updatedAt: now }).run();
  const session = await createSession(db, id, "access", undefined, 3600);
  return { id, call: caller({ Cookie: `session_id=${session}` }) };
}

/**
 * A user who has a namespace and owns `packages` (given by slug). The
 * namespace id is pinned to the user's id, so the paths below read well; the
 * assigned form is covered in registry.test.ts.
 */
async function seedPublisher(id: string, packages: readonly string[] = [], role: "user" | "admin" = "user"): Promise<Client> {
  const client = await seedUser(id, role);
  await db.insert(registryNamespaces).values({ id: `ns-${id}`, slug: id, ownerUserId: id }).run();
  for (const slug of packages)
    expect((await client.call("POST", "/packages", { slug, name: `The ${slug}`, visibility: "private" })).status).toBe(201);
  return client;
}

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

interface Token {
  readonly id: string;
  readonly secret: string;
  readonly call: Call;
}

async function mint(owner: Client, grants: unknown, extra: Record<string, unknown> = {}): Promise<Token> {
  const res = await owner.call("POST", "/tokens", { name: "ci", grants, ...extra });
  expect(res.status).toBe(201);
  const created = await data<{ id: string; token: string }>(res);
  return { id: created.id, secret: created.token, call: caller({ Authorization: `Bearer ${created.token}` }) };
}

async function scopesOf(tokenId: string): Promise<string[]> {
  return JSON.parse((await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId)).get())!.scopes) as string[];
}

async function packageId(slug: string): Promise<string> {
  return (await db.select().from(registryPackages).where(eq(registryPackages.slug, slug)).get())!.id;
}

/** Give a package one stored asset and one upload in flight. */
async function seedStorage(pkg: string, assetSize: number, uploadSize: number): Promise<void> {
  const versionId = `v-${pkg}`;
  await db.insert(registryVersions).values({ id: versionId, packageId: await packageId(pkg), version: "1.0.0" }).run();
  await db.insert(registryAssets).values({ id: `a-${pkg}`, versionId, name: "bin", size: assetSize, sha256: "0".repeat(64), blobKey: `k-${pkg}` }).run();
  await db.insert(registryUploads).values({ id: `u-${pkg}`, versionId, assetName: "big", size: uploadSize, sha256: "0".repeat(64), r2UploadId: "r2", expiresAt: new Date(Date.now() + 60_000).toISOString() }).run();
}

describe("token scopes", () => {
  test("scopes follow the highest level granted", () => {
    expect(deriveScopes([])).toEqual([]);
    expect(deriveScopes({ all: "read" })).toEqual(["packages:read"]);
    expect(deriveScopes([{ package: "a/b", access: "read" }, { package: "a/c", access: "write" }])).toEqual(["packages:read", "packages:write"]);
    expect(deriveScopes({ all: "admin" })).toEqual(["packages:read", "packages:write", "packages:admin"]);
  });

  // The release routes are not implemented yet; the route table already
  // decides what a token may call once they are.
  const release: (readonly [string, string])[] = [
    ["POST", "/registry/packages/a/b/versions"],
    ["PUT", "/registry/packages/a/b/versions/1.0.0/assets/tool-linux"],
    ["POST", "/registry/packages/a/b/versions/1.0.0/uploads"],
    ["PUT", "/registry/uploads/u1/parts/3"],
    ["POST", "/registry/uploads/u1/complete"],
    ["DELETE", "/registry/uploads/u1"],
    ["POST", "/registry/packages/a/b/versions/1.0.0/publish"],
    ["PUT", "/registry/packages/a/b/channels/stable"],
    ["DELETE", "/registry/packages/a/b/versions/1.0.0"],
  ];
  const manage: (readonly [string, string])[] = [
    ["PATCH", "/registry/packages/a/b"],
    ["POST", "/registry/packages/a/b/versions/1.0.0/yank"],
    ["POST", "/registry/packages/a/b/versions/1.0.0/restore"],
  ];
  const reads: (readonly [string, string])[] = [
    ["GET", "/registry/packages"],
    ["GET", "/registry/packages/a/b"],
    ["GET", "/registry/packages/a/b/versions"],
    ["GET", "/registry/packages/a/b/versions/1.0.0/assets"],
    ["GET", "/registry/packages/a/b/keys"],
    ["GET", "/registry/packages/a/b/manifest-signature"],
  ];
  const keys: (readonly [string, string])[] = [
    ["POST", "/registry/packages/a/b/keys"],
    ["PUT", "/registry/packages/a/b/manifest-signature"],
    ["DELETE", "/registry/packages/a/b/manifest-signature"],
  ];

  test("a read grant reads and cannot create a draft, upload or publish", () => {
    const scopes = deriveScopes({ all: "read" });
    for (const [method, path] of reads)
      expect(`${method} ${path} ${tokenScopesAllow(scopes, method, path)}`).toBe(`${method} ${path} true`);
    for (const [method, path] of [...release, ...manage, ...keys])
      expect(`${method} ${path} ${tokenScopesAllow(scopes, method, path)}`).toBe(`${method} ${path} false`);
  });

  test("a write grant releases, registers signing keys and cannot change settings, yank or restore", () => {
    const scopes = deriveScopes({ all: "write" });
    for (const [method, path] of [...reads, ...release, ...keys])
      expect(`${method} ${path} ${tokenScopesAllow(scopes, method, path)}`).toBe(`${method} ${path} true`);
    for (const [method, path] of manage)
      expect(`${method} ${path} ${tokenScopesAllow(scopes, method, path)}`).toBe(`${method} ${path} false`);
  });

  test("an admin grant manages, and no scope opens a session-only route", () => {
    const scopes = deriveScopes({ all: "admin" });
    for (const [method, path] of [...reads, ...release, ...manage])
      expect(`${method} ${path} ${tokenScopesAllow(scopes, method, path)}`).toBe(`${method} ${path} true`);
    const sessionOnly: (readonly [string, string])[] = [
      ["POST", "/registry/packages"],
      ["DELETE", "/registry/packages/a/b"],
      ["DELETE", "/registry/packages/a/b/keys/k1"],
      ["GET", "/registry/tokens"],
      ["POST", "/registry/tokens"],
      ["PUT", "/registry/tokens/t1"],
      ["DELETE", "/registry/tokens/t1"],
      ["GET", "/registry/namespace"],
      ["GET", "/registry/quota"],
      ["GET", "/registry/admin/namespaces"],
      ["POST", "/registry/admin/namespaces/a/suspend"],
      ["GET", "/registry/admin/packages"],
      ["PUT", "/registry/admin/users/u1/quota"],
      ["DELETE", "/registry/admin/tokens/t1"],
    ];
    for (const [method, path] of sessionOnly)
      expect(`${method} ${path} ${tokenScopesAllow(scopes, method, path)}`).toBe(`${method} ${path} false`);
  });
});

describe("token management", () => {
  test("creates a token with package grants and returns the secret once", async () => {
    const alice = await seedPublisher("alice", ["tool", "lib"]);
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    const res = await alice.call("POST", "/tokens", {
      name: "ci",
      expires_at: expires,
      grants: [{ package: "alice/tool", access: "write" }, { package: "alice/lib", access: "read" }],
    });
    expect(res.status).toBe(201);
    const created = await data<{ id: string; token: string }>(res);
    expect(created.token).toStartWith("pat_");
    const view = {
      id: created.id,
      user_id: alice.id,
      name: "ci",
      grants: [{ package: "alice/lib", access: "read" }, { package: "alice/tool", access: "write" }],
      expires_at: expires,
      last_used_at: null,
    };
    expect(created).toMatchObject(view);
    expect(await scopesOf(created.id)).toEqual(["packages:read", "packages:write"]);

    const listed = await data<Record<string, unknown>[]>(await alice.call("GET", "/tokens"));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject(view);
    expect(listed[0]).not.toHaveProperty("token");
  });

  test("an all-packages grant is one row with no package", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, { all: "admin" });
    expect(await db.select().from(registryTokenGrants).all()).toEqual([{ tokenId: token.id, packageId: null, access: "admin" }]);
    expect(await data<unknown[]>(await alice.call("GET", "/tokens"))).toMatchObject([{ grants: { all: "admin" } }]);
    expect(await scopesOf(token.id)).toEqual(["packages:read", "packages:write", "packages:admin"]);
  });

  test("replacing grants keeps the secret and derives the scopes again", async () => {
    const alice = await seedPublisher("alice", ["tool", "lib"]);
    const token = await mint(alice, [{ package: "alice/tool", access: "admin" }]);
    expect((await token.call("PATCH", "/packages/alice/tool", { description: "x" })).status).toBe(200);

    const res = await alice.call("PUT", `/tokens/${token.id}`, { grants: [{ package: "alice/lib", access: "read" }] });
    expect(await data(res)).toMatchObject({ id: token.id, grants: [{ package: "alice/lib", access: "read" }] });
    expect(await scopesOf(token.id)).toEqual(["packages:read"]);

    // The same secret, now with the new grants only.
    expect((await token.call("GET", "/packages/alice/lib")).status).toBe(200);
    expect((await token.call("GET", "/packages/alice/tool")).status).toBe(404);
    expect((await token.call("PATCH", "/packages/alice/lib", { description: "x" })).status).toBe(403);
  });

  test("replacing grants leaves a token's other scopes alone", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, { all: "write" });
    await db.update(apiTokens).set({ scopes: JSON.stringify(["account:read", "packages:read", "packages:write"]) }).run();
    await alice.call("PUT", `/tokens/${token.id}`, { grants: { all: "read" } });
    expect(await scopesOf(token.id)).toEqual(["account:read", "packages:read"]);
  });

  test("a grant naming another user's package, or none at all, is refused", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const bob = await seedPublisher("bob", ["mine"]);
    await alice.call("POST", "/packages", { slug: "open", name: "open", visibility: "public" });
    const token = await mint(bob, [{ package: "bob/mine", access: "read" }]);

    for (const pkg of ["alice/tool", "alice/open", "alice/nope", "nobody/x", "bob", "bob/mine/extra"]) {
      const created = await bob.call("POST", "/tokens", { name: "x", grants: [{ package: pkg, access: "read" }] });
      expect(`${pkg} ${created.status} ${await errorCode(created)}`).toBe(`${pkg} 422 INVALID_GRANT`);
      const replaced = await bob.call("PUT", `/tokens/${token.id}`, { grants: [{ package: pkg, access: "read" }] });
      expect(`${pkg} ${replaced.status}`).toBe(`${pkg} 422`);
    }
    // Nothing was created or changed on the way.
    expect(await data<unknown[]>(await bob.call("GET", "/tokens"))).toMatchObject([{ id: token.id, grants: [{ package: "bob/mine", access: "read" }] }]);
  });

  test("malformed grants are refused", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const bad = [
      { all: "owner" },
      { all: "read", extra: 1 },
      [{ package: "alice/tool", access: "owner" }],
      [{ package: "alice/tool", access: "read" }, { package: "alice/tool", access: "write" }],
      "read",
    ];
    for (const grants of bad)
      expect((await alice.call("POST", "/tokens", { name: "x", grants })).status).toBe(422);
    expect((await alice.call("POST", "/tokens", { name: "x", grants: [], expires_at: "2001-01-01T00:00:00Z" })).status).toBe(422);
    expect((await alice.call("POST", "/tokens", { name: "x" })).status).toBe(422);
  });

  test("a user cannot re-grant or revoke another user's token", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const bob = await seedPublisher("bob", ["mine"]);
    const token = await mint(alice, { all: "read" });
    expect((await bob.call("PUT", `/tokens/${token.id}`, { grants: { all: "admin" } })).status).toBe(404);
    expect((await bob.call("DELETE", `/tokens/${token.id}`)).status).toBe(404);
    expect(await data<unknown[]>(await bob.call("GET", "/tokens"))).toEqual([]);
    expect((await token.call("GET", "/packages/alice/tool")).status).toBe(200);
  });

  test("a revoked token stops working and takes its grants with it", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, { all: "read" });
    expect((await alice.call("DELETE", `/tokens/${token.id}`)).status).toBe(200);
    expect((await token.call("GET", "/packages/alice/tool")).status).toBe(401);
    expect(await db.select().from(registryTokenGrants).all()).toEqual([]);
  });

  test("token mutations are audited", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, { all: "read" });
    await alice.call("PUT", `/tokens/${token.id}`, { grants: [{ package: "alice/tool", access: "write" }] });
    await alice.call("DELETE", `/tokens/${token.id}`);
    const events = (await db.select().from(auditEvents).all()).filter(e => e.action.startsWith("registry.token."));
    expect(events.map(e => e.action)).toEqual(["registry.token.created", "registry.token.grants_replaced", "registry.token.revoked"]);
    for (const event of events)
      expect(event).toMatchObject({ actorId: alice.id, resourceType: "api_token", resourceId: token.id, result: "success" });
    expect(JSON.parse(events[1]!.detail!)).toEqual({ grants: [{ package: "alice/tool", access: "write" }] });
  });
});

describe("grant check", () => {
  test("a token is refused on a package it has no grant for", async () => {
    const alice = await seedPublisher("alice", ["tool", "other"]);
    await alice.call("POST", "/packages", { slug: "open", name: "open", visibility: "public" });
    const token = await mint(alice, [{ package: "alice/tool", access: "admin" }]);

    expect((await token.call("GET", "/packages/alice/tool")).status).toBe(200);
    // Private and not granted: as if it did not exist. Public: refused.
    expect((await token.call("GET", "/packages/alice/other")).status).toBe(404);
    expect((await token.call("PATCH", "/packages/alice/other", { description: "x" })).status).toBe(404);
    expect((await token.call("GET", "/packages/alice/open")).status).toBe(403);
    expect((await token.call("PATCH", "/packages/alice/open", { description: "x" })).status).toBe(403);
    expect(await data(await alice.call("GET", "/packages/alice/other"))).toMatchObject({ description: null });

    // The list shows granted packages only.
    expect((await data<{ slug: string }[]>(await token.call("GET", "/packages"))).map(p => p.slug)).toEqual(["tool"]);
  });

  test("a token with no grant reaches no package", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, []);
    expect(await scopesOf(token.id)).toEqual([]);
    expect((await token.call("GET", "/packages")).status).toBe(403);
    expect((await token.call("GET", "/packages/alice/tool")).status).toBe(403);
  });

  test("read and write grants cannot change settings; an admin grant can, but cannot delete", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    for (const level of ["read", "write"] as const) {
      const token = await mint(alice, [{ package: "alice/tool", access: level }]);
      expect((await token.call("GET", "/packages/alice/tool")).status).toBe(200);
      expect((await token.call("PATCH", "/packages/alice/tool", { description: "x" })).status).toBe(403);
      expect((await token.call("DELETE", "/packages/alice/tool")).status).toBe(403);
    }
    const admin = await mint(alice, [{ package: "alice/tool", access: "admin" }]);
    expect(await data(await admin.call("PATCH", "/packages/alice/tool", { description: "by token" }))).toMatchObject({ description: "by token" });
    expect((await admin.call("DELETE", "/packages/alice/tool")).status).toBe(403);
    expect(await db.select().from(registryPackages).all()).toHaveLength(1);
  });

  test("the scopes alone do not lift a lower grant on another package", async () => {
    // One admin grant gives the token the packages:admin scope; the grant
    // check still holds the other package at read.
    const alice = await seedPublisher("alice", ["tool", "lib"]);
    const token = await mint(alice, [{ package: "alice/tool", access: "admin" }, { package: "alice/lib", access: "read" }]);
    expect((await token.call("PATCH", "/packages/alice/tool", { description: "x" })).status).toBe(200);
    expect((await token.call("PATCH", "/packages/alice/lib", { description: "x" })).status).toBe(403);
  });

  test("no token, even all=admin, reaches a session-only route", async () => {
    const root = await seedPublisher("root1", ["tool"], "admin");
    const token = await mint(root, { all: "admin" });
    const routes: (readonly [string, string])[] = [
      ["POST", "/packages"],
      ["DELETE", "/packages/root1/tool"],
      ["DELETE", "/packages/root1/tool/keys/k1"],
      ["GET", "/tokens"],
      ["POST", "/tokens"],
      ["PUT", `/tokens/${token.id}`],
      ["DELETE", `/tokens/${token.id}`],
      ["GET", "/namespace"],
      ["GET", "/quota"],
      ["GET", "/admin/namespaces"],
      ["POST", "/admin/namespaces/root1/suspend"],
      ["POST", "/admin/namespaces/root1/restore"],
      ["GET", "/admin/packages"],
      ["GET", "/admin/users/root1/quota"],
      ["PUT", "/admin/users/root1/quota"],
      ["GET", "/admin/tokens"],
      ["DELETE", `/admin/tokens/${token.id}`],
    ];
    for (const [method, path] of routes) {
      const res = await token.call(method, path, method === "GET" || method === "DELETE" ? undefined : {});
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 403`);
    }
    // The token and the package are still there.
    expect((await token.call("GET", "/packages/root1/tool")).status).toBe(200);
  });

  test("an all-packages grant covers a package created after the token", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, { all: "admin" });
    expect((await alice.call("POST", "/packages", { slug: "later", name: "later", visibility: "private" })).status).toBe(201);
    expect((await token.call("PATCH", "/packages/alice/later", { description: "x" })).status).toBe(200);
    expect((await data<{ slug: string }[]>(await token.call("GET", "/packages"))).map(p => p.slug)).toEqual(["later", "tool"]);
  });

  test("an all-packages grant stops at the owner's own namespace", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const root = await seedPublisher("root1", ["mine"], "admin");
    const all = await mint(root, { all: "admin" });
    expect((await all.call("GET", "/packages/alice/tool")).status).toBe(404);
    expect((await data<{ slug: string }[]>(await all.call("GET", "/packages"))).map(p => p.slug)).toEqual(["mine"]);

    // An administrator may name any package in a grant.
    const named = await mint(root, [{ package: "alice/tool", access: "read" }]);
    expect((await named.call("GET", "/packages/alice/tool")).status).toBe(200);
    expect((await data<{ namespace: string }[]>(await named.call("GET", "/packages"))).map(p => p.namespace)).toEqual(["alice"]);
    expect(alice.id).toBe("alice");
  });

  test("a grant disappears with its package", async () => {
    const alice = await seedPublisher("alice", ["tool", "lib"]);
    const token = await mint(alice, [{ package: "alice/tool", access: "write" }, { package: "alice/lib", access: "read" }]);
    expect((await alice.call("DELETE", "/packages/alice/tool")).status).toBe(200);
    expect(await db.select().from(registryTokenGrants).all()).toEqual([{ tokenId: token.id, packageId: await packageId("lib"), access: "read" }]);
    expect(await data<unknown[]>(await alice.call("GET", "/tokens"))).toMatchObject([{ grants: [{ package: "alice/lib", access: "read" }] }]);

    // A package of the same slug created later is not covered by the old grant.
    expect((await alice.call("POST", "/packages", { slug: "tool", name: "tool", visibility: "private" })).status).toBe(201);
    expect((await token.call("GET", "/packages/alice/tool")).status).toBe(404);
  });

  test("a suspended namespace disables its owner's tokens", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, { all: "admin" });
    await db.update(registryNamespaces).set({ status: "suspended" }).run();
    for (const [method, path] of [["GET", "/packages"], ["GET", "/packages/alice/tool"], ["PATCH", "/packages/alice/tool"], ["GET", "/packages/alice/nope"]] as const) {
      const res = await token.call(method, path, method === "PATCH" ? { description: "x" } : undefined);
      expect(`${method} ${path} ${res.status} ${await errorCode(res)}`).toBe(`${method} ${path} 403 NAMESPACE_SUSPENDED`);
    }
    expect(await resolveReadToken(db, `Bearer ${token.secret}`, await packageId("tool"))).toBe(false);

    await db.update(registryNamespaces).set({ status: "active" }).run();
    expect((await token.call("GET", "/packages/alice/tool")).status).toBe(200);
  });

  test("a disabled owner disables the token", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, { all: "admin" });
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, alice.id)).run();
    expect((await token.call("GET", "/packages/alice/tool")).status).toBe(401);
    expect((await token.call("PATCH", "/packages/alice/tool", { description: "x" })).status).toBe(401);
    expect(await resolveReadToken(db, `Bearer ${token.secret}`, await packageId("tool"))).toBe(false);
  });

  test("a token request records the token id in the audit entry", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, { all: "admin" });
    await token.call("PATCH", "/packages/alice/tool", { description: "by token" });
    await alice.call("PATCH", "/packages/alice/tool", { description: "by session" });
    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "registry.package.updated")).all();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ actorId: alice.id });
    expect(JSON.parse(events[0]!.detail!)).toMatchObject({ token_id: token.id, owner_user_id: alice.id });
    expect(JSON.parse(events[1]!.detail!)).not.toHaveProperty("token_id");
  });
});

describe("signing keys through a token", () => {
  const TOOL = "/packages/alice/tool/keys";

  test("a write grant registers the package's keys, and cannot revoke one", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, [{ package: "alice/tool", access: "write" }]);

    const created = await token.call("POST", TOOL, { public_key: KEY, name: "ci" });
    expect(created.status).toBe(201);
    const { id } = await data<{ id: string }>(created);
    // Registering it again is what a second CI run does.
    const again = await token.call("POST", TOOL, { public_key: KEY, name: "ci" });
    expect(`${again.status} ${await errorCode(again)}`).toBe("409 KEY_EXISTS");

    expect(await data<unknown[]>(await token.call("GET", TOOL))).toHaveLength(1);
    expect(await data<unknown[]>(await alice.call("GET", TOOL))).toHaveLength(1);
    expect((await token.call("DELETE", `${TOOL}/${id}`)).status).toBe(403);
    expect((await alice.call("DELETE", `${TOOL}/${id}`)).status).toBe(200);
  });

  test("a read grant only lists them; a grant on another package does neither", async () => {
    const alice = await seedPublisher("alice", ["tool", "lib"]);
    const reader = await mint(alice, { all: "read" });
    expect((await reader.call("POST", TOOL, { public_key: KEY, name: "ci" })).status).toBe(403);
    expect((await reader.call("GET", TOOL)).status).toBe(200);

    // A private package the token has no grant on does not exist to it.
    const elsewhere = await mint(alice, [{ package: "alice/lib", access: "admin" }]);
    expect((await elsewhere.call("POST", TOOL, { public_key: KEY, name: "ci" })).status).toBe(404);
    expect((await elsewhere.call("GET", TOOL)).status).toBe(404);
    expect((await elsewhere.call("POST", "/packages/alice/lib/keys", { public_key: KEY, name: "ci" })).status).toBe(201);
  });

  test("not even an admin grant revokes", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const { id } = await data<{ id: string }>(await alice.call("POST", TOOL, { public_key: KEY, name: "ci" }));
    const token = await mint(alice, { all: "admin" });
    expect((await token.call("DELETE", `${TOOL}/${id}`)).status).toBe(403);
  });

  test("a suspended namespace stops it", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const token = await mint(alice, { all: "write" });
    await db.update(registryNamespaces).set({ status: "suspended" }).run();
    const res = await token.call("POST", TOOL, { public_key: KEY, name: "ci" });
    expect(`${res.status} ${await errorCode(res)}`).toBe("403 NAMESPACE_SUSPENDED");
  });
});

describe("a user without a namespace yet", () => {
  test("reads report nothing and no namespace is assigned by them", async () => {
    const carol = await seedUser("carol");
    const root = await seedUser("root1", "admin");
    expect(await data<unknown>(await carol.call("GET", "/packages"))).toEqual([]);
    expect(await data(await carol.call("GET", "/quota"))).toMatchObject({ usage: { packages: 0, storage_bytes: 0 } });
    expect(await data<unknown>(await carol.call("GET", "/tokens"))).toEqual([]);
    expect(await data<unknown>(await root.call("GET", "/admin/namespaces"))).toEqual([]);
    expect(await data<unknown>(await root.call("GET", "/admin/packages"))).toEqual([]);
    expect(await data(await root.call("GET", "/admin/users/carol/quota"))).toMatchObject({ usage: { packages: 0, storage_bytes: 0 } });
    expect(await db.select().from(registryNamespaces).all()).toEqual([]);
  });

  test("an all-packages token works before and after the first package", async () => {
    const carol = await seedUser("carol");
    const token = await mint(carol, { all: "admin" });
    expect(await data<unknown>(await token.call("GET", "/packages"))).toEqual([]);
    expect(await db.select().from(registryNamespaces).all()).toEqual([]);

    const pkg = await data<{ namespace: string }>(await carol.call("POST", "/packages", { slug: "tool", name: "Tool", visibility: "private" }));
    expect((await token.call("PATCH", `/packages/${pkg.namespace}/tool`, { description: "x" })).status).toBe(200);
    expect(await resolveReadToken(db, `Bearer ${token.secret}`, await packageId("tool"))).toBe(true);
  });

  test("a grant cannot name a package under a namespace that does not exist", async () => {
    const carol = await seedUser("carol");
    const res = await carol.call("POST", "/tokens", { name: "x", grants: [{ package: "carol/tool", access: "read" }] });
    expect(`${res.status} ${await errorCode(res)}`).toBe("422 INVALID_GRANT");
  });
});

describe("resolveReadToken", () => {
  test("is true only for a live token with a grant on the package", async () => {
    const alice = await seedPublisher("alice", ["tool", "other"]);
    const bob = await seedPublisher("bob", ["mine"]);
    const tool = await packageId("tool");
    const named = await mint(alice, [{ package: "alice/tool", access: "read" }]);
    const all = await mint(alice, { all: "write" });
    const none = await mint(alice, []);
    const foreign = await mint(bob, { all: "admin" });
    const expired = await mint(alice, { all: "read" });
    await db.update(apiTokens).set({ expiresAt: "2001-01-01T00:00:00.000Z" }).where(eq(apiTokens.id, expired.id)).run();

    expect(await resolveReadToken(db, `Bearer ${named.secret}`, tool)).toBe(true);
    expect(await resolveReadToken(db, `Bearer ${all.secret}`, tool)).toBe(true);
    expect(await resolveReadToken(db, `Bearer ${named.secret}`, await packageId("other"))).toBe(false);
    expect(await resolveReadToken(db, `Bearer ${none.secret}`, tool)).toBe(false);
    expect(await resolveReadToken(db, `Bearer ${foreign.secret}`, tool)).toBe(false);
    expect(await resolveReadToken(db, `Bearer ${expired.secret}`, tool)).toBe(false);
    expect(await resolveReadToken(db, `Bearer ${named.secret}`, "missing")).toBe(false);
    expect(await resolveReadToken(db, "Bearer pat_unknown", tool)).toBe(false);
    expect(await resolveReadToken(db, named.secret, tool)).toBe(false);
    expect(await resolveReadToken(db, "Basic abc", tool)).toBe(false);
    expect(await resolveReadToken(db, undefined, tool)).toBe(false);
  });
});

describe("private packages", () => {
  test("a token answers 404 for a private package it cannot read, like a session", async () => {
    await seedPublisher("alice", ["secret"]);
    const bob = await seedPublisher("bob", ["mine"]);
    const token = await mint(bob, { all: "admin" });
    for (const [method, body] of [["GET", undefined], ["PATCH", { description: "x" }]] as const) {
      const hidden = await token.call(method, "/packages/alice/secret", body);
      const missing = await token.call(method, "/packages/alice/nope", body);
      expect(`${method} ${hidden.status}`).toBe(`${method} 404`);
      expect(await hidden.json()).toEqual(await missing.json());
    }
  });
});

describe("suspended namespace", () => {
  test("its owner can read but not change anything; an administrator can", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const root = await seedUser("root1", "admin");
    await db.update(registryNamespaces).set({ status: "suspended" }).run();

    expect((await alice.call("GET", "/packages")).status).toBe(200);
    expect((await alice.call("GET", "/packages/alice/tool")).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/packages", { slug: "more", name: "more" }],
      ["PATCH", "/packages/alice/tool", { description: "x" }],
      ["DELETE", "/packages/alice/tool", undefined],
    ] as const) {
      const res = await alice.call(method, path, body);
      expect(`${method} ${path} ${res.status} ${await errorCode(res)}`).toBe(`${method} ${path} 403 NAMESPACE_SUSPENDED`);
    }

    expect((await root.call("PATCH", "/packages/alice/tool", { description: "taken down" })).status).toBe(200);
    expect((await root.call("DELETE", "/packages/alice/tool")).status).toBe(200);
  });
});

describe("package quota", () => {
  test("concurrent creates cannot pass the limit together", async () => {
    const alice = await seedPublisher("alice");
    const results = await Promise.all(["a1", "a2", "a3", "a4", "a5", "a6"].map(async slug => (await alice.call("POST", "/packages", { slug, name: slug })).status));
    expect(results.filter(s => s === 201)).toHaveLength(3);
    expect(results.filter(s => s === 409)).toHaveLength(3);
    expect(await db.select().from(registryPackages).all()).toHaveLength(3);
  });
});

describe("quota and usage", () => {
  test("reports limits and usage, counting stored assets and uploads in flight", async () => {
    const alice = await seedPublisher("alice", ["tool", "lib"]);
    const bob = await seedPublisher("bob", ["mine"]);
    expect(await data<unknown>(await alice.call("GET", "/quota"))).toEqual({
      limits: { max_packages: 3, max_storage_bytes: 10737418240, max_asset_bytes: 524288000 },
      usage: { packages: 2, storage_bytes: 0 },
    });

    await seedStorage("tool", 1000, 200);
    await seedStorage("lib", 30, 4);
    await seedStorage("mine", 7, 0);
    expect(await getUsage(db, alice.id)).toEqual({ packages: 2, storageBytes: 1234 });
    expect(await getUsage(db, bob.id)).toEqual({ packages: 1, storageBytes: 7 });
    expect(await getUsage(db, "nobody")).toEqual({ packages: 0, storageBytes: 0 });
    expect(await data(await alice.call("GET", "/quota"))).toMatchObject({ usage: { packages: 2, storage_bytes: 1234 } });
  });

  test("an upload is refused before it starts when it is too large or over quota", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await seedStorage("tool", 1000, 200);
    await db.insert(registryQuotas).values({ userId: alice.id, maxStorageBytes: 2000, maxAssetBytes: 700 }).run();

    await assertUploadAllowed(db, alice.id, 700, config);
    await expect(assertUploadAllowed(db, alice.id, 701, config)).rejects.toMatchObject({ statusCode: 413, code: "ASSET_TOO_LARGE" });
    await db.update(registryQuotas).set({ maxAssetBytes: null }).run();
    await assertUploadAllowed(db, alice.id, 800, config);
    await expect(assertUploadAllowed(db, alice.id, 801, config)).rejects.toMatchObject({ statusCode: 409, code: "STORAGE_QUOTA_EXCEEDED" });
  });
});

describe("platform administration", () => {
  const adminRoutes: (readonly [string, string, unknown?])[] = [
    ["GET", "/admin/namespaces"],
    ["POST", "/admin/namespaces/alice/suspend"],
    ["POST", "/admin/namespaces/alice/restore"],
    ["GET", "/admin/packages"],
    ["GET", "/admin/users/alice/quota"],
    ["PUT", "/admin/users/alice/quota", { max_packages: 99 }],
    ["GET", "/admin/tokens"],
    ["DELETE", "/admin/tokens/t1"],
  ];

  test("a non-admin session gets 403 on every admin route", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    for (const [method, path, body] of adminRoutes) {
      const res = await alice.call(method, path, body);
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 403`);
    }
    expect(await db.select().from(registryQuotas).all()).toEqual([]);
    expect((await db.select().from(registryNamespaces).get())!.status).toBe("active");
  });

  test("admin routes need a session", async () => {
    for (const [method, path] of adminRoutes)
      expect((await app().request(`/api/registry${path}`, { method })).status).toBe(401);
  });

  test("lists every namespace and package with owner and storage usage", async () => {
    await seedPublisher("alice", ["tool", "lib"]);
    await seedPublisher("bob");
    const root = await seedUser("root1", "admin");
    await seedStorage("tool", 1000, 200);

    const owner = { id: "alice", username: "alice", name: "alice" };
    expect(await data(await root.call("GET", "/admin/namespaces"))).toMatchObject([
      { slug: "alice", status: "active", owner, packages: 2, storage_bytes: 1200 },
      { slug: "bob", status: "active", owner: { id: "bob" }, packages: 0, storage_bytes: 0 },
    ]);
    expect(await data(await root.call("GET", "/admin/packages"))).toMatchObject([
      { namespace: "alice", slug: "lib", name: "The lib", visibility: "private", owner, storage_bytes: 0 },
      { namespace: "alice", slug: "tool", name: "The tool", visibility: "private", owner, storage_bytes: 1200 },
    ]);
  });

  test("suspends and restores a namespace, audited with the owner", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const root = await seedUser("root1", "admin");

    expect(await data(await root.call("POST", "/admin/namespaces/alice/suspend"))).toMatchObject({ slug: "alice", status: "suspended" });
    expect(await errorCode(await alice.call("PATCH", "/packages/alice/tool", { description: "x" }))).toBe("NAMESPACE_SUSPENDED");
    // Suspending twice changes nothing and is not audited again.
    expect((await root.call("POST", "/admin/namespaces/alice/suspend")).status).toBe(200);
    expect(await data(await root.call("POST", "/admin/namespaces/alice/restore"))).toMatchObject({ status: "active" });
    expect((await alice.call("PATCH", "/packages/alice/tool", { description: "x" })).status).toBe(200);
    expect((await root.call("POST", "/admin/namespaces/nobody/suspend")).status).toBe(404);

    const events = (await db.select().from(auditEvents).all()).filter(e => e.resourceType === "registry_namespace");
    expect(events.map(e => e.action)).toEqual(["registry.namespace.suspended", "registry.namespace.restored"]);
    for (const event of events) {
      expect(event).toMatchObject({ actorId: root.id, resourceName: "alice" });
      expect(JSON.parse(event.detail!)).toEqual({ owner_user_id: alice.id });
    }
  });

  test("a quota override changes the enforced package limit", async () => {
    const alice = await seedPublisher("alice", ["one", "two", "three"]);
    const root = await seedUser("root1", "admin");
    expect(await errorCode(await alice.call("POST", "/packages", { slug: "four", name: "four" }))).toBe("PACKAGE_QUOTA_EXCEEDED");

    const set = await root.call("PUT", "/admin/users/alice/quota", { max_packages: 4, max_storage_bytes: null });
    expect(await data<unknown>(set)).toEqual({
      user_id: alice.id,
      override: { max_packages: 4, max_storage_bytes: null, max_asset_bytes: null },
      limits: { max_packages: 4, max_storage_bytes: 10737418240, max_asset_bytes: 524288000 },
      usage: { packages: 3, storage_bytes: 0 },
    });
    expect((await alice.call("POST", "/packages", { slug: "four", name: "four" })).status).toBe(201);
    expect((await alice.call("POST", "/packages", { slug: "five", name: "five" })).status).toBe(409);
    expect(await data(await alice.call("GET", "/quota"))).toMatchObject({ limits: { max_packages: 4 }, usage: { packages: 4 } });

    // Lowering it below what is held refuses new packages and keeps the old.
    await root.call("PUT", "/admin/users/alice/quota", { max_packages: 1 });
    expect((await alice.call("POST", "/packages", { slug: "five", name: "five" })).status).toBe(409);
    expect(await data(await root.call("GET", "/admin/users/alice/quota"))).toMatchObject({ override: { max_packages: 1 }, usage: { packages: 4 } });

    // Nulls clear the override: the row goes and the defaults apply again.
    expect(await data(await root.call("PUT", "/admin/users/alice/quota", { max_packages: null, max_storage_bytes: null, max_asset_bytes: null })))
      .toMatchObject({ override: { max_packages: null }, limits: { max_packages: 3 } });
    expect(await db.select().from(registryQuotas).all()).toEqual([]);

    const event = (await db.select().from(auditEvents).where(eq(auditEvents.action, "registry.quota.updated")).all())[0]!;
    expect(event).toMatchObject({ actorId: root.id, resourceId: alice.id });
    expect(JSON.parse(event.detail!)).toEqual({ owner_user_id: alice.id, override: { max_packages: 4, max_storage_bytes: null, max_asset_bytes: null } });
  });

  test("quota input is validated", async () => {
    await seedPublisher("alice");
    const root = await seedUser("root1", "admin");
    for (const body of [{ max_asset_bytes: 524288001 }, { max_packages: -1 }, { max_packages: 1.5 }, { max_storage_bytes: "1" }, { unknown: 1 }])
      expect((await root.call("PUT", "/admin/users/alice/quota", body)).status).toBe(422);
    expect((await root.call("PUT", "/admin/users/nobody/quota", { max_packages: 1 })).status).toBe(404);
    expect((await root.call("GET", "/admin/users/nobody/quota")).status).toBe(404);
  });

  test("lists and revokes another user's token", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const bob = await seedPublisher("bob", ["mine"]);
    const root = await seedUser("root1", "admin");
    const aliceToken = await mint(alice, [{ package: "alice/tool", access: "write" }]);
    const bobToken = await mint(bob, { all: "read" });

    const all = await data<Record<string, unknown>[]>(await root.call("GET", "/admin/tokens"));
    expect(all).toMatchObject([
      { id: aliceToken.id, user_id: alice.id, grants: [{ package: "alice/tool", access: "write" }] },
      { id: bobToken.id, user_id: bob.id, grants: { all: "read" } },
    ]);
    expect(JSON.stringify(all)).not.toContain(aliceToken.secret);
    expect(await data(await root.call("GET", "/admin/tokens?user_id=bob"))).toMatchObject([{ id: bobToken.id }]);
    expect(await data<unknown[]>(await root.call("GET", "/admin/tokens?user_id=nobody"))).toEqual([]);

    expect((await root.call("DELETE", `/admin/tokens/${aliceToken.id}`)).status).toBe(200);
    expect((await aliceToken.call("GET", "/packages/alice/tool")).status).toBe(401);
    expect((await bobToken.call("GET", "/packages/bob/mine")).status).toBe(200);
    expect((await root.call("DELETE", `/admin/tokens/${aliceToken.id}`)).status).toBe(404);

    const event = (await db.select().from(auditEvents).where(eq(auditEvents.action, "registry.token.revoked")).get())!;
    expect(event).toMatchObject({ actorId: root.id, resourceId: aliceToken.id });
    expect(JSON.parse(event.detail!)).toEqual({ owner_user_id: alice.id });
  });
});
