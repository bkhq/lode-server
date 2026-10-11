import type { PolicyContext } from "./registry";
import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { loadNamespaces } from "./namespace-config";
import { createPermissionCache, defineResource } from "./permission";
import { NOOP_POLICY_LOGGER } from "./policy-logger";
import { relationTuples } from "./schema";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

const testNamespaces = [
  { name: "user" },
  { name: "group", relations: { member: { union: [{ this: {} }] } } },
  { name: "app", relations: { viewer: { union: [{ this: {} }] } } },
] as const;

let db: AppDatabase;
let dbPath: string;
const actorId = "memo-actor";

beforeEach(async () => {
  loadNamespaces(testNamespaces);
  const dir = resolve(tmpdir(), `test-policy-perm-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: actorId,
    oauthSub: `sub-${actorId}`,
    username: actorId,
    name: actorId,
    email: `${actorId}@test.com`,
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
  loadNamespaces();
});

function ctxFor(): PolicyContext {
  return { db, logger: NOOP_POLICY_LOGGER, actor: { id: actorId, type: "user" }, cache: createPermissionCache() };
}

describe("ResourceAccess request-scoped cache", () => {
  // Registries are process-wide singletons shared with other test files;
  // a unique resource name keeps this definition from colliding.
  const access = defineResource({
    name: `memo-${nanoid()}`,
    namespace: "app",
    description: "memo test",
    actions: { "x:read": "viewer" } as const,
  });

  test("a repeat can() on the same context is answered from the cache, and grant/revoke clear it", async () => {
    const ctx = ctxFor();
    await access.grant(ctx, { subject: { type: "user", id: actorId }, relation: "viewer", objectId: "o1" });
    expect(await access.can(ctx, "x:read", "o1")).toBe(true);

    // Pull the row out from under the engine. The same context must still
    // say yes — that is the whole point of a per-request snapshot.
    await db.delete(relationTuples).where(and(eq(relationTuples.objectId, "o1"), eq(relationTuples.relation, "viewer"))).run();
    expect(await access.can(ctx, "x:read", "o1")).toBe(true);

    // A fresh context (next request) sees the truth.
    expect(await access.can(ctxFor(), "x:read", "o1")).toBe(false);

    // Writes through the facade invalidate: revoke of a now-missing tuple
    // is a no-op on the table but must still drop the cached answer.
    await access.revoke(ctx, { subject: { type: "user", id: actorId }, relation: "viewer", objectId: "o1" });
    expect(await access.can(ctx, "x:read", "o1")).toBe(false);
  });

  test("a context without a cache resolves every call live", async () => {
    const ctx: PolicyContext = { db, logger: NOOP_POLICY_LOGGER, actor: { id: actorId, type: "user" } };
    await access.grant(ctx, { subject: { type: "user", id: actorId }, relation: "viewer", objectId: "o2" });
    expect(await access.can(ctx, "x:read", "o2")).toBe(true);
    await db.delete(relationTuples).where(eq(relationTuples.objectId, "o2")).run();
    expect(await access.can(ctx, "x:read", "o2")).toBe(false);
  });
});
