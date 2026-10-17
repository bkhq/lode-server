import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { configSchema } from "@/config/schema";
import { createDb } from "@/db";
import { accountBackupContribution } from "@/modules/account/account.backup";
import { createSession } from "@/modules/account/auth/auth.service";
import { apiTokens } from "@/modules/account/tokens/schema";
import { createApiToken } from "@/modules/account/tokens/tokens.service";
import { users } from "@/modules/account/users/schema";
import { auditEvents } from "@/modules/audit/schema";
import { streamJsonBackup } from "@/modules/backup/export.service";
import { registerBackupContribution } from "@/modules/backup/registry";
import { importJsonBackup, validateBackupData } from "@/modules/backup/restore.service";
import { getAllRouteBindings, policyMiddleware } from "@/modules/policy";
import { loadNamespaces } from "@/modules/policy/namespace-config";
import { policyBackupContribution } from "@/modules/policy/policy.backup";
import { relationTuples } from "@/modules/policy/schema";
import { errorHandler } from "@/shared/middleware/error-handler";
import { packageAccess, registryRoutes } from ".";
import { deriveKeyId, parsePublicKey } from "./key.service";
import { registryBackupContribution } from "./registry.backup";
import { createPackage, ensureNamespace, generateNamespaceSlug, getEffectiveQuota } from "./registry.service";
import {
  registryAssets,
  registryChannels,
  registryDelegations,
  registryKeys,
  registryManifestSignatures,
  registryNamespaces,
  registryPackages,
  registryQuotas,
  registryRetiredVersions,
  registryRevocationLists,
  registryTokenGrants,
  registryUploads,
  registryVersions,
} from "./schema";
import "@/modules/account";

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

// 32 bytes of 0x07 and 0xE0..0xFF. The second one differs between the two
// base64 alphabets, which is what makes it a useful vector.
const KEY_A = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const KEY_A_ID = "4bb06f8e4e3a7715";
const KEY_B_URL = "4OHi4-Tl5ufo6err7O3u7_Dx8vP09fb3-Pn6-_z9_v8";
const KEY_B_STD = "4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8=";
const KEY_B_ID = "9432c1a7d343fcfa";

let dir: string;
let db: AppDatabase;
let config: Config;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "registry-"));
  db = await createDb(resolve(dir, "app.db"));
  config = configSchema.parse({ NODE_ENV: "test", REGISTRY_MAX_PACKAGES_PER_USER: "2" });
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

interface Client {
  readonly id: string;
  readonly call: (method: string, path: string, body?: unknown) => Promise<Response>;
}

async function seedUser(id: string, role: "user" | "admin" = "user", username = id): Promise<Client> {
  const now = new Date().toISOString();
  await db.insert(users).values({ id, oauthSub: `sub-${id}`, username, name: id, email: `${id}@t.io`, role, status: "active", createdAt: now, updatedAt: now }).run();
  const session = await createSession(db, id, "access", undefined, 3600);
  return {
    id,
    call: async (method, path, body) => await app().request(`/api/registry${path}`, {
      method,
      headers: { "Cookie": `session_id=${session}`, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  };
}

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/**
 * A user who already has a namespace. Its id is pinned to the user's id, so
 * the paths below read well; the assigned form has tests of its own.
 */
async function seedPublisher(id: string, role: "user" | "admin" = "user"): Promise<Client> {
  const client = await seedUser(id, role);
  await db.insert(registryNamespaces).values({ id: `ns-${id}`, slug: id, ownerUserId: id }).run();
  return client;
}

/** A publisher with one private package, `<id>/tool`: what a signing key hangs off. */
async function seedOwner(id: string): Promise<Client> {
  const client = await seedPublisher(id);
  expect((await client.call("POST", "/packages", { slug: "tool", name: "tool", visibility: "private" })).status).toBe(201);
  return client;
}

const RE_ASSIGNED = /^[a-z][a-z0-9]{7}$/;

async function auditActions(): Promise<string[]> {
  return (await db.select().from(auditEvents).all()).map(e => e.action);
}

describe("registration", () => {
  test("binds the package routes for the global policy middleware", () => {
    const bound = getAllRouteBindings().filter(b => b.resourceName === "package").map(b => `${b.method} ${b.path}`);
    expect(bound).toEqual([
      "GET /registry/packages/:ns/:pkg",
      "PATCH /registry/packages/:ns/:pkg",
      "DELETE /registry/packages/:ns/:pkg",
    ]);
  });

  test("contributes its tables to the backup, parents first", () => {
    expect(registryBackupContribution.name).toBe("registry");
    expect(registryBackupContribution.deps).toEqual(["users", "policies"]);
    // Every table but `registry_token_grants`; see registry.backup.ts.
    expect(registryBackupContribution.tables).toEqual([
      registryNamespaces,
      registryPackages,
      registryRetiredVersions,
      registryKeys,
      registryVersions,
      registryAssets,
      registryChannels,
      registryManifestSignatures,
      registryDelegations,
      registryRevocationLists,
      registryUploads,
      registryQuotas,
    ]);
  });

  test("the asset size limit cannot be configured above 500 MiB", () => {
    expect(configSchema.parse({}).REGISTRY_MAX_ASSET_BYTES).toBe(524288000);
    expect(configSchema.safeParse({ REGISTRY_MAX_ASSET_BYTES: "524288001" }).success).toBe(false);
  });
});

describe("authentication", () => {
  test("every route needs a session", async () => {
    for (const [method, path] of [["GET", "/namespace"], ["GET", "/packages/a/b/keys"], ["GET", "/packages"], ["GET", "/packages/a/b"]] as const)
      expect((await app().request(`/api/registry${path}`, { method })).status).toBe(401);
  });

  test("a personal API token gets 403 on every route", async () => {
    const alice = await seedPublisher("alice");
    expect((await alice.call("POST", "/packages", { slug: "tool", name: "tool" })).status).toBe(201);
    const { token } = await createApiToken(db, alice.id, { name: "ci", scopes: ["account:read"], expiresAt: null });

    const routes: (readonly [string, string])[] = [
      ["GET", "/namespace"],
      ["GET", "/packages/alice/tool/keys"],
      ["POST", "/packages/alice/tool/keys"],
      ["DELETE", "/packages/alice/tool/keys/k1"],
      ["GET", "/packages"],
      ["POST", "/packages"],
      ["GET", "/packages/alice/tool"],
      ["PATCH", "/packages/alice/tool"],
      ["DELETE", "/packages/alice/tool"],
    ];
    for (const [method, path] of routes) {
      const res = await app().request(`/api/registry${path}`, {
        method,
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        ...(method !== "GET" && method !== "DELETE" && { body: "{}" }),
      });
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 403`);
    }
    // Nothing was deleted on the way.
    expect((await alice.call("GET", "/packages/alice/tool")).status).toBe(200);
  });
});

describe("namespace", () => {
  test("is assigned on the first read and stays the same", async () => {
    const alice = await seedUser("alice");
    const first = await data<{ namespace: { slug: string; status: string; created_at: string } }>(await alice.call("GET", "/namespace"));
    expect(Object.keys(first)).toEqual(["namespace"]);
    expect(Object.keys(first.namespace).sort()).toEqual(["created_at", "slug", "status"]);
    expect(first.namespace.slug).toMatch(RE_ASSIGNED);
    expect(first.namespace.status).toBe("active");

    expect(await data<unknown>(await alice.call("GET", "/namespace"))).toEqual(first);
    expect(await db.select().from(registryNamespaces).all()).toMatchObject([{ slug: first.namespace.slug, ownerUserId: alice.id }]);
  });

  test("says nothing about the user it belongs to", async () => {
    const alice = await seedUser("u1", "user", "alice");
    const { namespace } = await data<{ namespace: { slug: string } }>(await alice.call("GET", "/namespace"));
    expect(namespace.slug).not.toContain("alice");
    expect(namespace.slug).not.toBe(alice.id);
  });

  test("generated ids are 8 characters, lowercase letters and digits, starting with a letter", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const slug = generateNamespaceSlug();
      expect(slug).toMatch(RE_ASSIGNED);
      seen.add(slug);
    }
    expect(seen.size).toBeGreaterThan(490);
  });

  test("a collision is retried with a fresh id", async () => {
    await seedUser("alice");
    await seedUser("bob");
    const taken = await ensureNamespace(db, "alice", () => "aaaa1111");
    expect(taken).toMatchObject({ assigned: true, namespace: { slug: "aaaa1111", ownerUserId: "alice" } });

    const ids = ["aaaa1111", "aaaa1111", "bbbb2222"];
    const second = await ensureNamespace(db, "bob", () => ids.shift()!);
    expect(second).toMatchObject({ assigned: true, namespace: { slug: "bbbb2222", ownerUserId: "bob" } });
    expect(ids).toEqual([]);
  });

  test("gives up when every generated id is taken", async () => {
    await seedUser("alice");
    await seedUser("bob");
    await ensureNamespace(db, "alice", () => "aaaa1111");
    let calls = 0;
    await expect(ensureNamespace(db, "bob", () => {
      calls++;
      return "aaaa1111";
    })).rejects.toThrow();
    expect(calls).toBeGreaterThan(1);
    expect(await db.select().from(registryNamespaces).all()).toHaveLength(1);
  });

  test("an existing namespace is returned without generating", async () => {
    await seedUser("alice");
    const first = await ensureNamespace(db, "alice");
    const again = await ensureNamespace(db, "alice", () => {
      throw new Error("must not generate");
    });
    expect(again).toEqual({ namespace: first.namespace, assigned: false });
  });

  test("concurrent calls for one user yield one row", async () => {
    await seedUser("alice");
    const results = await Promise.all(Array.from({ length: 8 }, async () => await ensureNamespace(db, "alice")));
    expect(new Set(results.map(r => r.namespace.slug)).size).toBe(1);
    expect(results.filter(r => r.assigned)).toHaveLength(1);
    expect(await db.select().from(registryNamespaces).all()).toHaveLength(1);
  });

  test("no route lets a user choose or change it", async () => {
    const alice = await seedUser("alice");
    const { namespace } = await data<{ namespace: { slug: string } }>(await alice.call("GET", "/namespace"));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await alice.call(method, "/namespace", { slug: "chosen" });
      expect([404, 405]).toContain(res.status);
    }
    // A body on package creation cannot smuggle one in either.
    const pkg = await data<{ namespace: string }>(await alice.call("POST", "/packages", { slug: "tool", name: "Tool", namespace: "chosen", ns: "chosen" }));
    expect(pkg.namespace).toBe(namespace.slug);
    expect((await alice.call("PATCH", `/packages/${namespace.slug}/tool`, { namespace: "chosen" })).status).toBe(422);
    expect((await db.select().from(registryNamespaces).all()).map(n => n.slug)).toEqual([namespace.slug]);
  });

  test("the assignment is audited once", async () => {
    const alice = await seedUser("alice");
    const { namespace } = await data<{ namespace: { slug: string } }>(await alice.call("GET", "/namespace"));
    await alice.call("GET", "/namespace");
    const events = await db.select().from(auditEvents).all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "registry.namespace.assigned", actorId: alice.id, resourceType: "registry_namespace", resourceName: namespace.slug, result: "success" });
  });
});

describe("signing keys", () => {
  test("derives the key id and stores the key as unpadded base64url", async () => {
    const alice = await seedOwner("alice");
    const res = await alice.call("POST", "/packages/alice/tool/keys", { public_key: KEY_B_STD, name: "release" });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ key_id: KEY_B_ID, alg: "ed25519", public_key: KEY_B_URL, name: "release", revoked_at: null });

    const listed = await data<{ key_id: string }[]>(await alice.call("GET", "/packages/alice/tool/keys"));
    expect(listed.map(k => k.key_id)).toEqual([KEY_B_ID]);
  });

  test("accepts base64url and lode's prefixed forms", async () => {
    expect(await deriveKeyId(parsePublicKey(KEY_A))).toBe(KEY_A_ID);
    expect(await deriveKeyId(parsePublicKey(`${KEY_A}=`))).toBe(KEY_A_ID);
    expect(await deriveKeyId(parsePublicKey(`  ${KEY_B_URL}\n`))).toBe(KEY_B_ID);
    expect(await deriveKeyId(parsePublicKey(`${KEY_B_ID}:${KEY_B_URL}`))).toBe(KEY_B_ID);
    expect(await deriveKeyId(parsePublicKey(`ed25519:${KEY_B_URL}`))).toBe(KEY_B_ID);
    expect(await deriveKeyId(parsePublicKey(`ed25519:${KEY_B_ID}:${KEY_B_STD}`))).toBe(KEY_B_ID);
    // As in lode, the id in front is informational: the real one is derived.
    expect(await deriveKeyId(parsePublicKey(`ignored:${KEY_B_URL}`))).toBe(KEY_B_ID);
  });

  test("anything but a raw ed25519 key is refused with 400", async () => {
    const alice = await seedOwner("alice");
    const p256 = Buffer.from(new Uint8Array(33).fill(2)).toString("base64url");
    const bad = [
      p256,
      `ecdsa-p256:${p256}`,
      `ecdsa-p256:${KEY_A}`,
      `ecdsa-p384:${KEY_A_ID}:${KEY_A}`,
      `rsa:${KEY_A_ID}:${KEY_A}`,
      `a:b:c:${KEY_A}`,
      "not-base64-!!!",
      KEY_A.slice(0, 42),
      // 43 characters whose last one carries stray bits.
      `${KEY_A.slice(0, 42)}d`,
      `${KEY_A.slice(0, 20)} ${KEY_A.slice(20)}`,
      "-----BEGIN PUBLIC KEY-----",
      ":",
    ];
    for (const public_key of bad) {
      const res = await alice.call("POST", "/packages/alice/tool/keys", { public_key, name: "k" });
      expect(`${public_key} ${res.status}`).toBe(`${public_key} 400`);
      expect(await errorCode(res)).toBe("INVALID_PUBLIC_KEY");
    }
    expect((await alice.call("POST", "/packages/alice/tool/keys", { name: "k" })).status).toBe(422);
    expect(await db.select().from(registryKeys).all()).toHaveLength(0);
  });

  test("a key is unique per package, not across packages", async () => {
    const alice = await seedOwner("alice");
    expect((await alice.call("POST", "/packages", { slug: "lib", name: "lib" })).status).toBe(201);
    expect((await alice.call("POST", "/packages/alice/tool/keys", { public_key: KEY_A, name: "one" })).status).toBe(201);
    const again = await alice.call("POST", "/packages/alice/tool/keys", { public_key: `${KEY_A_ID}:${KEY_A}`, name: "two" });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("KEY_EXISTS");
    // The same key may sign another package; each package lists only its own.
    expect((await alice.call("POST", "/packages/alice/lib/keys", { public_key: KEY_A, name: "one" })).status).toBe(201);
    expect(await data<unknown[]>(await alice.call("GET", "/packages/alice/tool/keys"))).toHaveLength(1);
    const bob = await seedOwner("bob");
    expect((await bob.call("POST", "/packages/bob/tool/keys", { public_key: KEY_A, name: "mine" })).status).toBe(201);
  });

  test("revoking sets revoked_at and keeps the row", async () => {
    const alice = await seedOwner("alice");
    const key = await data<{ id: string }>(await alice.call("POST", "/packages/alice/tool/keys", { public_key: KEY_A, name: "one" }));

    const res = await alice.call("DELETE", `/packages/alice/tool/keys/${key.id}`);
    expect(res.status).toBe(200);
    const revoked = await data<{ revoked_at: string }>(res);
    expect(revoked.revoked_at).toBeString();

    // Revoking again is a no-op that keeps the original timestamp.
    expect((await data<{ revoked_at: string }>(await alice.call("DELETE", `/packages/alice/tool/keys/${key.id}`))).revoked_at).toBe(revoked.revoked_at);
    expect(await db.select().from(registryKeys).all()).toHaveLength(1);
  });

  test("another user cannot see or revoke it; an administrator can", async () => {
    const alice = await seedOwner("alice");
    const key = await data<{ id: string }>(await alice.call("POST", "/packages/alice/tool/keys", { public_key: KEY_A, name: "one" }));
    const bob = await seedUser("bob");
    // The package is private, so to bob it does not exist.
    expect((await bob.call("GET", "/packages/alice/tool/keys")).status).toBe(404);
    expect((await bob.call("DELETE", `/packages/alice/tool/keys/${key.id}`)).status).toBe(404);
    expect((await db.select().from(registryKeys).get())!.revokedAt).toBeNull();

    const admin = await seedUser("root1", "admin");
    expect(await data<unknown[]>(await admin.call("GET", "/packages/alice/tool/keys"))).toHaveLength(1);
    expect((await admin.call("DELETE", `/packages/alice/tool/keys/${key.id}`)).status).toBe(200);
  });

  test("a key goes with its package", async () => {
    const alice = await seedOwner("alice");
    await alice.call("POST", "/packages/alice/tool/keys", { public_key: KEY_A, name: "one" });
    expect((await alice.call("DELETE", "/packages/alice/tool")).status).toBe(200);
    expect(await db.select().from(registryKeys).all()).toHaveLength(0);
  });

  test("registering and revoking are audited", async () => {
    const alice = await seedOwner("alice");
    const key = await data<{ id: string }>(await alice.call("POST", "/packages/alice/tool/keys", { public_key: KEY_A, name: "one" }));
    await alice.call("DELETE", `/packages/alice/tool/keys/${key.id}`);
    expect((await auditActions()).filter(action => action.startsWith("registry.key."))).toEqual(["registry.key.registered", "registry.key.revoked"]);
    const event = (await db.select().from(auditEvents).all()).find(e => e.action === "registry.key.registered")!;
    expect(event).toMatchObject({ actorId: alice.id, resourceType: "registry_key", resourceId: key.id, resourceName: KEY_A_ID });
    expect(JSON.parse(event.detail!)).toMatchObject({ package: "alice/tool" });
  });
});

describe("packages", () => {
  test("creating without any prior namespace call assigns one", async () => {
    const alice = await seedUser("alice");
    const res = await alice.call("POST", "/packages", { slug: "tool", name: "Tool" });
    expect(res.status).toBe(201);
    const created = await data<{ namespace: string }>(res);
    expect(created.namespace).toMatch(RE_ASSIGNED);
    expect(await auditActions()).toEqual(["registry.namespace.assigned", "registry.package.created"]);

    // The same namespace from then on.
    expect(await data<unknown>(await alice.call("GET", "/namespace"))).toMatchObject({ namespace: { slug: created.namespace } });
    expect(await data(await alice.call("POST", "/packages", { slug: "lib", name: "Lib" }))).toMatchObject({ namespace: created.namespace });
    expect((await alice.call("GET", `/packages/${created.namespace}/tool`)).status).toBe(200);
    expect(await auditActions()).toHaveLength(3);
  });

  test("creates with defaults, lists and reads back", async () => {
    const alice = await seedPublisher("alice");
    const res = await alice.call("POST", "/packages", { slug: "tool", name: "  My Tool  " });
    expect(res.status).toBe(201);
    const created = await data(res);
    expect(Object.keys(created).sort()).toEqual(["created_at", "description", "id", "name", "namespace", "require_signature", "slug", "updated_at", "visibility"]);
    expect(created).toMatchObject({ namespace: "alice", slug: "tool", name: "My Tool", visibility: "public", description: null, require_signature: false });

    expect((await alice.call("POST", "/packages", { slug: "secret", name: "A secret", visibility: "private", description: "internal", require_signature: true })).status).toBe(201);
    const listed = await data<{ slug: string }[]>(await alice.call("GET", "/packages"));
    expect(listed.map(p => p.slug)).toEqual(["secret", "tool"]);

    expect(await data(await alice.call("GET", "/packages/alice/secret"))).toMatchObject({ visibility: "private", description: "internal", require_signature: true });
  });

  test("writes the owner tuple on create and removes it on delete", async () => {
    const alice = await seedPublisher("alice");
    const pkg = await data<{ id: string }>(await alice.call("POST", "/packages", { slug: "tool", name: "tool" }));
    const tuples = () => db.select().from(relationTuples).where(and(eq(relationTuples.namespace, "package"), eq(relationTuples.objectId, pkg.id))).all();
    expect(await tuples()).toMatchObject([{ relation: "owner", subjectNamespace: "user", subjectId: alice.id }]);

    expect((await alice.call("DELETE", "/packages/alice/tool")).status).toBe(200);
    expect(await tuples()).toEqual([]);
    expect(await db.select().from(registryPackages).all()).toEqual([]);
    expect((await alice.call("GET", "/packages/alice/tool")).status).toBe(404);
  });

  test("a slug holds only lowercase letters, digits and '-', and does not start with '-'", async () => {
    const alice = await seedPublisher("alice");
    for (const slug of ["Tool", "TOOL", "my.tool", "my_tool", "-tool", "", "a".repeat(129), "a/b", "a b", "..", "caf\u00E9"]) {
      const res = await alice.call("POST", "/packages", { slug, name: "Tool" });
      expect(`${slug} ${res.status}`).toBe(`${slug} 422`);
    }
    expect((await alice.call("POST", "/packages", { name: "Tool" })).status).toBe(422);
    expect((await alice.call("POST", "/packages", { slug: "tool", name: "Tool", visibility: "secret" })).status).toBe(422);
    expect(await db.select().from(registryPackages).all()).toEqual([]);

    expect((await alice.call("POST", "/packages", { slug: "my-tool-2", name: "Tool" })).status).toBe(201);
  });

  test("a display name is free text of 1 to 100 characters without control characters", async () => {
    const alice = await seedPublisher("alice");
    for (const name of ["", "   ", "a\u0000b", "line\nbreak", "tab\there", "x".repeat(101)]) {
      const res = await alice.call("POST", "/packages", { slug: "tool", name });
      expect(`${JSON.stringify(name)} ${res.status}`).toBe(`${JSON.stringify(name)} 422`);
    }
    expect((await alice.call("POST", "/packages", { slug: "tool" })).status).toBe(422);

    expect(await data(await alice.call("POST", "/packages", { slug: "tool", name: "My Tool (v2) \u2014 \u5DE5\u5177 \u{1F527}" }))).toMatchObject({ name: "My Tool (v2) \u2014 \u5DE5\u5177 \u{1F527}" });
    expect(await data(await alice.call("POST", "/packages", { slug: "long", name: ` ${"x".repeat(100)} ` }))).toMatchObject({ name: "x".repeat(100) });
  });

  test("a slug is unique within its namespace; a display name is not", async () => {
    const alice = await seedPublisher("alice");
    expect((await alice.call("POST", "/packages", { slug: "tool", name: "Tool" })).status).toBe(201);
    const dup = await alice.call("POST", "/packages", { slug: "tool", name: "Another" });
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe("PACKAGE_EXISTS");
    expect((await alice.call("POST", "/packages", { slug: "tool-2", name: "Tool" })).status).toBe(201);
    await expect(db.insert(registryPackages).values({ id: "dup", namespaceId: "ns-alice", slug: "tool", name: "x" }).run()).rejects.toThrow();
  });

  test("the same slug can exist in two namespaces", async () => {
    const alice = await seedPublisher("alice");
    const bob = await seedPublisher("bob");
    expect((await alice.call("POST", "/packages", { slug: "tool", name: "tool" })).status).toBe(201);
    expect((await bob.call("POST", "/packages", { slug: "tool", name: "tool" })).status).toBe(201);
    expect(await data<unknown[]>(await bob.call("GET", "/packages"))).toHaveLength(1);
  });

  test("the max-packages quota is enforced", async () => {
    const alice = await seedPublisher("alice");
    expect((await alice.call("POST", "/packages", { slug: "one", name: "one" })).status).toBe(201);
    expect((await alice.call("POST", "/packages", { slug: "two", name: "two" })).status).toBe(201);
    const res = await alice.call("POST", "/packages", { slug: "three", name: "three" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("PACKAGE_QUOTA_EXCEEDED");

    // A per-user override wins over the platform default.
    await db.insert(registryQuotas).values({ userId: alice.id, maxPackages: 3 }).run();
    expect((await alice.call("POST", "/packages", { slug: "three", name: "three" })).status).toBe(201);
    expect((await alice.call("POST", "/packages", { slug: "four", name: "four" })).status).toBe(409);
  });

  test("a suspended namespace cannot take new packages", async () => {
    const alice = await seedPublisher("alice");
    await db.update(registryNamespaces).set({ status: "suspended" }).run();
    const res = await alice.call("POST", "/packages", { slug: "tool", name: "tool" });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("NAMESPACE_SUSPENDED");
  });

  test("updates name, visibility, description and require_signature, never the slug", async () => {
    const alice = await seedPublisher("alice");
    await alice.call("POST", "/packages", { slug: "tool", name: "tool", description: "old" });

    const res = await alice.call("PATCH", "/packages/alice/tool", { visibility: "private", require_signature: true });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ visibility: "private", description: "old", require_signature: true });

    expect(await data(await alice.call("PATCH", "/packages/alice/tool", { description: null }))).toMatchObject({ visibility: "private", description: null });
    expect((await alice.call("PATCH", "/packages/alice/tool", {})).status).toBe(422);

    expect(await data(await alice.call("PATCH", "/packages/alice/tool", { name: "  Renamed  " }))).toMatchObject({ slug: "tool", name: "Renamed" });
    for (const name of ["", "  ", "a\u0007b", "x".repeat(101)])
      expect((await alice.call("PATCH", "/packages/alice/tool", { name })).status).toBe(422);
    expect((await alice.call("PATCH", "/packages/alice/tool", { slug: "moved" })).status).toBe(422);
    expect((await alice.call("PATCH", "/packages/alice/tool", { slug: "moved", name: "x" })).status).toBe(422);
    expect(await data(await alice.call("GET", "/packages/alice/tool"))).toMatchObject({ slug: "tool", name: "Renamed" });
    expect((await alice.call("GET", "/packages/alice/moved")).status).toBe(404);
    // The display name is not a path segment.
    expect((await alice.call("GET", "/packages/alice/Renamed")).status).toBe(404);
  });

  test("deleting cascades to everything that hangs off the package", async () => {
    const alice = await seedPublisher("alice");
    const pkg = await data<{ id: string }>(await alice.call("POST", "/packages", { slug: "tool", name: "tool" }));
    const { record } = await createApiToken(db, alice.id, { name: "ci", scopes: ["account:read"], expiresAt: null });
    await db.insert(registryVersions).values({ id: "v1", packageId: pkg.id, version: "1.0.0", status: "published" }).run();
    await db.insert(registryAssets).values({ id: "a1", versionId: "v1", name: "tool.tar.gz", size: 1, sha256: "00", blobKey: "pkg/x" }).run();
    await db.insert(registryChannels).values({ packageId: pkg.id, name: "stable", versionId: "v1" }).run();
    await db.insert(registryUploads).values({ id: "up1", versionId: "v1", assetName: "big.tar.gz", size: 1, sha256: "00", r2UploadId: "r2", expiresAt: new Date().toISOString() }).run();
    await db.insert(registryTokenGrants).values([{ tokenId: record.id, packageId: pkg.id, access: "write" }, { tokenId: record.id, packageId: null, access: "read" }]).run();

    expect((await alice.call("DELETE", "/packages/alice/tool")).status).toBe(200);
    for (const table of [registryPackages, registryVersions, registryAssets, registryChannels, registryUploads])
      expect(await db.select().from(table).all()).toEqual([]);
    // The grant on this package goes; the "all my packages" grant stays.
    expect(await db.select().from(registryTokenGrants).all()).toEqual([{ tokenId: record.id, packageId: null, access: "read" }]);
  });

  test("a token holds at most one grant per package and one for all packages", async () => {
    const alice = await seedPublisher("alice");
    const pkg = await data<{ id: string }>(await alice.call("POST", "/packages", { slug: "tool", name: "tool" }));
    const { record } = await createApiToken(db, alice.id, { name: "ci", scopes: ["account:read"], expiresAt: null });
    await db.insert(registryTokenGrants).values([{ tokenId: record.id, packageId: pkg.id, access: "write" }, { tokenId: record.id, packageId: null, access: "read" }]).run();
    await expect(db.insert(registryTokenGrants).values({ tokenId: record.id, packageId: pkg.id, access: "read" }).run()).rejects.toThrow();
    await expect(db.insert(registryTokenGrants).values({ tokenId: record.id, packageId: null, access: "admin" }).run()).rejects.toThrow();
  });

  test("mutations are audited with actor and target", async () => {
    const alice = await seedPublisher("alice");
    const pkg = await data<{ id: string }>(await alice.call("POST", "/packages", { slug: "tool", name: "My Tool" }));
    await alice.call("PATCH", "/packages/alice/tool", { visibility: "private" });
    await alice.call("DELETE", "/packages/alice/tool");

    const events = (await db.select().from(auditEvents).all()).filter(e => e.resourceType === "package");
    expect(events.map(e => e.action)).toEqual(["registry.package.created", "registry.package.updated", "registry.package.deleted"]);
    for (const event of events)
      expect(event).toMatchObject({ actorId: alice.id, resourceId: pkg.id, resourceName: "alice/tool", result: "success" });
    expect(JSON.parse(events[1]!.detail!)).toMatchObject({ owner_user_id: alice.id, changes: { visibility: "private" } });
  });
});

describe("package authorization", () => {
  test("a user cannot read, update or delete another user's package", async () => {
    const alice = await seedPublisher("alice");
    const bob = await seedPublisher("bob");
    await alice.call("POST", "/packages", { slug: "tool", name: "tool" });
    await alice.call("POST", "/packages", { slug: "secret", name: "secret", visibility: "private" });

    // A public package shows its metadata to any signed-in user, and no more.
    expect(await data(await bob.call("GET", "/packages/alice/tool"))).toMatchObject({ namespace: "alice", slug: "tool" });
    expect((await bob.call("PATCH", "/packages/alice/tool", { visibility: "private" })).status).toBe(403);
    expect((await bob.call("DELETE", "/packages/alice/tool")).status).toBe(403);

    // A private one answers exactly like a package that does not exist, so
    // its name cannot be found by probing.
    for (const [method, body] of [["GET", undefined], ["PATCH", { visibility: "public" }], ["DELETE", undefined]] as const) {
      const hidden = await bob.call(method, "/packages/alice/secret", body);
      const missing = await bob.call(method, "/packages/alice/nope", body);
      expect(`${method} ${hidden.status}`).toBe(`${method} 404`);
      expect(await hidden.json()).toEqual(await missing.json());
    }
    expect(await data(await alice.call("GET", "/packages/alice/secret"))).toMatchObject({ visibility: "private" });
    expect(await data<unknown[]>(await bob.call("GET", "/packages"))).toEqual([]);
  });

  test("an unknown namespace or package is a 404", async () => {
    const alice = await seedPublisher("alice");
    await alice.call("POST", "/packages", { slug: "tool", name: "tool" });
    for (const path of ["/packages/alice/nope", "/packages/nobody/tool"]) {
      expect((await alice.call("GET", path)).status).toBe(404);
      expect((await alice.call("PATCH", path, { visibility: "private" })).status).toBe(404);
      expect((await alice.call("DELETE", path)).status).toBe(404);
    }
  });

  test("a platform admin passes every package check", async () => {
    const alice = await seedPublisher("alice");
    const admin = await seedUser("root1", "admin");
    const pkg = await data<{ id: string }>(await alice.call("POST", "/packages", { slug: "tool", name: "tool", visibility: "private" }));

    expect((await admin.call("GET", "/packages/alice/tool")).status).toBe(200);
    expect(await data(await admin.call("PATCH", "/packages/alice/tool", { visibility: "public" }))).toMatchObject({ visibility: "public" });
    expect((await admin.call("DELETE", "/packages/alice/tool")).status).toBe(200);
    expect(await db.select().from(registryPackages).all()).toEqual([]);

    // The audit entry names the acting admin and the owner it acted on.
    const deleted = (await db.select().from(auditEvents).where(eq(auditEvents.action, "registry.package.deleted")).get())!;
    expect(deleted).toMatchObject({ actorId: admin.id, resourceId: pkg.id, resourceName: "alice/tool" });
    expect(JSON.parse(deleted.detail!)).toMatchObject({ owner_user_id: alice.id });
  });

  test("an admin's own package list is still only their own", async () => {
    const alice = await seedPublisher("alice");
    const admin = await seedUser("root1", "admin");
    await alice.call("POST", "/packages", { slug: "tool", name: "tool" });
    expect(await data<unknown[]>(await admin.call("GET", "/packages"))).toEqual([]);
  });
});

describe("package policy resource", () => {
  test("describes a package by its namespace and slug", async () => {
    const alice = await seedPublisher("alice");
    const pkg = await data<{ id: string }>(await alice.call("POST", "/packages", { slug: "tool", name: "My Tool" }));
    const resolveEntity = packageAccess.definition.hooks!.resolveEntity!;
    expect(await resolveEntity(db, pkg.id)).toEqual({ name: "alice/tool", type: "package" });
    expect(await resolveEntity(db, "missing")).toBeNull();
  });

  test("a package whose owner tuple cannot be written is not kept", async () => {
    const alice = await seedPublisher("alice");
    // No `package` namespace: the grant is refused as an unknown relation.
    loadNamespaces([{ name: "user" }]);
    try {
      const ctx = { db, logger: noop, actor: { id: alice.id, type: "user", role: "user" } };
      await expect(createPackage(ctx, config, { slug: "tool", name: "Tool" })).rejects.toThrow();
    }
    finally {
      loadNamespaces();
    }
    expect(await db.select().from(registryPackages).all()).toEqual([]);
  });
});

describe("getEffectiveQuota", () => {
  test("falls back to configuration, column by column", async () => {
    await seedUser("alice");
    const defaults = { maxPackages: 2, maxStorageBytes: 10737418240, maxAssetBytes: 524288000 };
    expect(await getEffectiveQuota(db, "alice", config)).toEqual(defaults);

    await db.insert(registryQuotas).values({ userId: "alice", maxStorageBytes: 1024 }).run();
    expect(await getEffectiveQuota(db, "alice", config)).toEqual({ ...defaults, maxStorageBytes: 1024 });
  });

  test("an override cannot lift the asset size above the platform ceiling", async () => {
    await seedUser("alice");
    await db.insert(registryQuotas).values({ userId: "alice", maxPackages: 9, maxAssetBytes: 2 * 524288000 }).run();
    expect(await getEffectiveQuota(db, "alice", config)).toMatchObject({ maxPackages: 9, maxAssetBytes: 524288000 });
  });
});

describe("backup", () => {
  test("a full export restores", async () => {
    // Other test files reset the shared backup registry; put back what this
    // round trip needs.
    for (const contribution of [accountBackupContribution, policyBackupContribution, registryBackupContribution])
      registerBackupContribution(contribution);

    const alice = await seedPublisher("alice");
    const pkg = await data<{ id: string }>(await alice.call("POST", "/packages", { slug: "tool", name: "tool" }));
    await alice.call("POST", "/packages/alice/tool/keys", { public_key: KEY_A, name: "release" });
    const { record } = await createApiToken(db, alice.id, { name: "ci", scopes: ["account:read"], expiresAt: null });
    await db.insert(registryVersions).values({ id: "v1", packageId: pkg.id, version: "1.0.0", status: "published" }).run();
    await db.insert(registryAssets).values({ id: "a1", versionId: "v1", name: "tool.tar.gz", size: 1, sha256: "00", blobKey: "pkg/x" }).run();
    await db.insert(registryChannels).values({ packageId: pkg.id, name: "stable", versionId: "v1" }).run();
    await db.insert(registryTokenGrants).values({ tokenId: record.id, packageId: pkg.id, access: "write" }).run();
    await db.insert(registryQuotas).values({ userId: alice.id, maxPackages: 5 }).run();

    const { modules, body } = streamJsonBackup(db, ["registry"]);
    expect(modules).toEqual(["users", "policies", "registry"]);
    const backup = validateBackupData(JSON.parse(await new Response(body).text()));
    await importJsonBackup(db, backup);

    expect((await db.select().from(registryPackages).all()).map(p => p.id)).toEqual([pkg.id]);
    expect(await db.select().from(registryChannels).all()).toHaveLength(1);
    expect(await db.select().from(registryKeys).all()).toHaveLength(1);
    expect(await db.select().from(registryQuotas).all()).toHaveLength(1);
    expect((await db.select().from(relationTuples).where(eq(relationTuples.namespace, "package")).all()).map(t => t.objectId)).toEqual([pkg.id]);
    // Restoring users drops their API tokens, and the grants with them.
    expect(await db.select().from(apiTokens).all()).toEqual([]);
    expect(await db.select().from(registryTokenGrants).all()).toEqual([]);
    expect((await alice.call("GET", "/packages/alice/tool")).status).toBe(401);
  });
});
