import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { users } from "@/modules/account/users/schema";
import { items } from "@/modules/item/schema";
import { loadNamespaces } from "@/modules/policy/namespace-config";
import { relationTuples } from "@/modules/policy/schema";
import { nanoid } from "@/shared/lib/id";
import { errorHandler } from "@/shared/middleware/error-handler";
import { documentAccess } from "./document.permission";
import { documentRoutes } from "./document.routes";
import {
  addDocumentShare,
  createDocument,
  getDocumentById,
  getDocumentPermission,
  getDocumentTreeForUser,
  isVersionConflict,
  listDocuments,
  listDocumentSharesWithInheritance,
  listMyDocuments,
  removeDocumentShare,
  softDeleteDocument,
  updateDocument,
} from "./document.service";
import "@/modules/account";

let db: AppDatabase;
let dbPath: string;

async function seedUser(name: string) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: `${name.toLowerCase()}-${id}`,
    name,
    email: `${id}@test.com`,
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

const noopLogger = {
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

function buildDocumentApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", baseConfig());
    c.set("logger", noopLogger);
    await next();
  });
  app.route("/", documentRoutes());
  app.onError(errorHandler);
  return app;
}

async function sessionCookieFor(userId: string): Promise<string> {
  const sessionId = await createSession(db, userId, "test-access-token", undefined, 3600);
  return `session_id=${sessionId}`;
}

/** Build a policy context for service-level test calls. */
function policyCtx(actorId: string) {
  return {
    db,
    logger: noopLogger,
    actor: { id: actorId, type: "user" },
  };
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-document-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
  loadNamespaces();
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

describe("createDocument", () => {
  test("creates with default fields and version 1", async () => {
    const userId = await seedUser("Alice");
    const doc = await createDocument(db, { title: "Hi", creatorId: userId });
    expect(doc.id).toHaveLength(8);
    expect(doc.title).toBe("Hi");
    expect(doc.content).toBeNull();
    expect(doc.tags).toBe("[]");
    expect(doc.parentId).toBeNull();
    expect(doc.version).toBe(1);
    expect(doc.creatorId).toBe(userId);
  });

  test("writes the creator's owner tuple and the parent edge", async () => {
    const userId = await seedUser("Alice");
    const parent = await createDocument(db, { title: "P", creatorId: userId });
    const child = await createDocument(db, { title: "C", creatorId: userId, parentId: parent.id });
    const [parentItem, childItem] = await Promise.all([parent, child].map(async d =>
      (await db.select().from(items).where(eq(items.shortId, d.id)).get())!));
    const tuples = await db.select().from(relationTuples).where(eq(relationTuples.objectId, childItem!.id)).all();
    expect(tuples.map(t => `${t.relation}@${t.subjectNamespace}:${t.subjectId}`).sort())
      .toEqual([`owner@user:${userId}`, `parent_item@item:${parentItem!.id}`]);
  });

  test("listDocuments matches % and _ in the title and tag search literally", async () => {
    const userId = await seedUser("Alice");
    await createDocument(db, {
      title: "Q3 at 50%",
      tags: ["fy_2026"],
      creatorId: userId,
    });
    await createDocument(db, {
      title: "Q3 at 500",
      tags: ["fyx2026"],
      creatorId: userId,
    });
    expect((await listDocuments(db, { q: "50%" })).data.map(d => d.title)).toEqual(["Q3 at 50%"]);
    expect((await listDocuments(db, { tag: "fy_2026" })).data.map(d => d.title)).toEqual(["Q3 at 50%"]);
  });

  test("nests via parentId; parent stored as short_id", async () => {
    const userId = await seedUser("Alice");
    const parent = await createDocument(db, { title: "P", creatorId: userId });
    const child = await createDocument(db, { title: "C", creatorId: userId, parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });
});

describe("documentRoutes create parent permissions", () => {
  test("rejects creating a child under a parent the actor cannot update", async () => {
    const owner = await seedUser("Owner");
    const actor = await seedUser("Mallory");
    const parent = await createDocument(db, { title: "Parent", creatorId: owner });
    const app = buildDocumentApp();

    const res = await app.request("/documents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cookie": await sessionCookieFor(actor),
      },
      body: JSON.stringify({ title: "Injected", parentId: parent.id }),
    });

    expect(res.status).toBe(403);
  });

  test("allows creating a child under a parent the actor owns", async () => {
    const actor = await seedUser("Alice");
    const parent = await createDocument(db, { title: "Parent", creatorId: actor });
    const app = buildDocumentApp();

    const res = await app.request("/documents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cookie": await sessionCookieFor(actor),
      },
      body: JSON.stringify({ title: "Child", parentId: parent.id }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { data: { parentId: string } };
    expect(body.data.parentId).toBe(parent.id);
  });
});

describe("updateDocument (version + content + parent)", () => {
  test("bumps version on every successful update", async () => {
    const userId = await seedUser("Alice");
    const doc = await createDocument(db, { title: "v1", creatorId: userId });
    const updated = await updateDocument(db, doc.id, { content: "body" });
    expect(isVersionConflict(updated)).toBe(false);
    if (!isVersionConflict(updated))
      expect(updated!.version).toBeGreaterThan(1);
  });

  test("returns VersionConflict when expectedVersion mismatches", async () => {
    const userId = await seedUser("Alice");
    const doc = await createDocument(db, { title: "v1", creatorId: userId });
    await updateDocument(db, doc.id, { content: "v2" });
    const result = await updateDocument(db, doc.id, { content: "wrong", expectedVersion: 1 });
    expect(isVersionConflict(result)).toBe(true);
    if (isVersionConflict(result))
      expect(result.current.content).toBe("v2");
  });

  test("moves to a new parent; parent_item tuple rewritten in lockstep", async () => {
    const userId = await seedUser("Alice");
    const a = await createDocument(db, { title: "A", creatorId: userId });
    const b = await createDocument(db, { title: "B", creatorId: userId });
    const child = await createDocument(db, { title: "C", creatorId: userId, parentId: a.id });
    expect(child.parentId).toBe(a.id);
    const moved = await updateDocument(db, child.id, { parentId: b.id });
    if (isVersionConflict(moved))
      expect.unreachable("no conflict expected");
    else
      expect(moved?.parentId).toBe(b.id);
  });
});

describe("field-level write policy (commentsLocked → owner)", () => {
  test("owner can write commentsLocked", async () => {
    const alice = await seedUser("Alice");
    const doc = await createDocument(db, { title: "D", creatorId: alice });
    const item = (await db.select({ id: items.id })
      .from(items)
      .where(eq(items.shortId, doc.id))
      .get())!;
    const safe = await documentAccess.filterWritable(
      policyCtx(alice),
      item.id,
      { title: "new title", commentsLocked: true },
      { onForbidden: "reject" },
    );
    expect(safe).toEqual({ title: "new title", commentsLocked: true });
  });

  test("shared editor cannot write commentsLocked — strip mode drops it", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const doc = await createDocument(db, { title: "D", creatorId: alice });
    await addDocumentShare(policyCtx(alice), {
      documentId: doc.id,
      targetType: "user",
      targetId: bob,
      permission: "editor",
    });
    const item = (await db.select({ id: items.id })
      .from(items)
      .where(eq(items.shortId, doc.id))
      .get())!;
    const safe = await documentAccess.filterWritable(
      policyCtx(bob),
      item.id,
      { title: "renamed by editor", commentsLocked: true },
      { onForbidden: "strip" },
    );
    expect(safe).toEqual({ title: "renamed by editor" });
  });

  test("shared editor cannot write commentsLocked — reject mode throws", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const doc = await createDocument(db, { title: "D", creatorId: alice });
    await addDocumentShare(policyCtx(alice), {
      documentId: doc.id,
      targetType: "user",
      targetId: bob,
      permission: "editor",
    });
    const item = (await db.select({ id: items.id })
      .from(items)
      .where(eq(items.shortId, doc.id))
      .get())!;
    expect(
      documentAccess.filterWritable(
        policyCtx(bob),
        item.id,
        { commentsLocked: true },
        { onForbidden: "reject" },
      ),
    ).rejects.toThrow(/Cannot write field/);
  });
});

describe("softDeleteDocument", () => {
  test("soft-deletes the doc and every descendant; clears tuples", async () => {
    const userId = await seedUser("Alice");
    const root = await createDocument(db, { title: "Root", creatorId: userId });
    const child = await createDocument(db, { title: "Child", creatorId: userId, parentId: root.id });
    const grand = await createDocument(db, { title: "Grand", creatorId: userId, parentId: child.id });
    await softDeleteDocument(db, root.id);
    expect(await getDocumentById(db, root.id)).toBeUndefined();
    expect(await getDocumentById(db, child.id)).toBeUndefined();
    expect(await getDocumentById(db, grand.id)).toBeUndefined();
  });
});

describe("getDocumentPermission + subtree inheritance via policy", () => {
  test("creator has editor; uninvited user has nothing", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const doc = await createDocument(db, { title: "D", creatorId: alice });
    expect(await getDocumentPermission(db, doc.id, alice)).toBe("editor");
    expect(await getDocumentPermission(db, doc.id, bob)).toBeNull();
  });

  test("explicit viewer share grants viewer", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const doc = await createDocument(db, { title: "D", creatorId: alice });
    await addDocumentShare(policyCtx(alice), {
      documentId: doc.id,
      targetType: "user",
      targetId: bob,
      permission: "viewer",
    });
    expect(await getDocumentPermission(db, doc.id, bob)).toBe("viewer");
  });

  test("ancestor share inherits to descendants (parent_item)", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const parent = await createDocument(db, { title: "P", creatorId: alice });
    const child = await createDocument(db, { title: "C", creatorId: alice, parentId: parent.id });
    const grand = await createDocument(db, { title: "G", creatorId: alice, parentId: child.id });
    await addDocumentShare(policyCtx(alice), {
      documentId: parent.id,
      targetType: "user",
      targetId: bob,
      permission: "editor",
    });
    expect(await getDocumentPermission(db, parent.id, bob)).toBe("editor");
    expect(await getDocumentPermission(db, child.id, bob)).toBe("editor");
    expect(await getDocumentPermission(db, grand.id, bob)).toBe("editor");
  });

  test("removeDocumentShare drops the tuple — inherited access disappears", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const parent = await createDocument(db, { title: "P", creatorId: alice });
    const child = await createDocument(db, { title: "C", creatorId: alice, parentId: parent.id });
    const share = await addDocumentShare(policyCtx(alice), {
      documentId: parent.id,
      targetType: "user",
      targetId: bob,
      permission: "viewer",
    });
    expect(await getDocumentPermission(db, child.id, bob)).toBe("viewer");
    await removeDocumentShare(policyCtx(alice), share.id);
    expect(await getDocumentPermission(db, child.id, bob)).toBeNull();
  });
});

describe("listDocumentSharesWithInheritance", () => {
  test("returns self-shares with inheritedFrom=null + ancestor shares with inheritedFrom set", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const carol = await seedUser("Carol");
    const parent = await createDocument(db, { title: "Parent", creatorId: alice });
    const child = await createDocument(db, { title: "Child", creatorId: alice, parentId: parent.id });
    await addDocumentShare(policyCtx(alice), {
      documentId: parent.id,
      targetType: "user",
      targetId: bob,
      permission: "viewer",
    });
    await addDocumentShare(policyCtx(alice), {
      documentId: child.id,
      targetType: "user",
      targetId: carol,
      permission: "editor",
    });

    const list = await listDocumentSharesWithInheritance(db, child.id);
    const selfRow = list.find(r => r.targetId === carol);
    const inheritedRow = list.find(r => r.targetId === bob);
    expect(selfRow?.inheritedFrom).toBeNull();
    expect(inheritedRow?.inheritedFrom).toEqual({ id: parent.id, title: "Parent" });
  });
});

describe("listMyDocuments", () => {
  test("returns docs the user created", async () => {
    const me = await seedUser("Me");
    const other = await seedUser("Other");
    const mine = await createDocument(db, { title: "Mine", creatorId: me });
    await createDocument(db, { title: "Theirs", creatorId: other });
    const list = await listMyDocuments(db, { userId: me });
    expect(list.total).toBe(1);
    expect(list.data[0]!.id).toBe(mine.id);
  });

  test("returns docs shared with the user, plus descendants of shared docs", async () => {
    const owner = await seedUser("Owner");
    const me = await seedUser("Me");
    const parent = await createDocument(db, { title: "P", creatorId: owner });
    const child = await createDocument(db, { title: "C", creatorId: owner, parentId: parent.id });
    await addDocumentShare(policyCtx(owner), {
      documentId: parent.id,
      targetType: "user",
      targetId: me,
      permission: "viewer",
    });
    const list = await listMyDocuments(db, { userId: me });
    const ids = list.data.map(d => d.id).sort();
    expect(ids).toEqual([parent.id, child.id].sort());
  });
});

describe("getDocumentTreeForUser", () => {
  test("admin sees every document; child node reports parentId as short_id", async () => {
    const alice = await seedUser("Alice");
    const a = await createDocument(db, { title: "alpha", creatorId: alice });
    const b = await createDocument(db, { title: "Beta", creatorId: alice });
    const c = await createDocument(db, { title: "alpha-child", creatorId: alice, parentId: a.id });

    const tree = await getDocumentTreeForUser(db, { id: "anyone", role: "admin" });
    const ids = tree.map(n => n.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    const childNode = tree.find(n => n.id === c.id);
    expect(childNode?.parentId).toBe(a.id);
  });

  test("a share on an ancestor makes the whole subtree visible in tree + list, not just the shared node", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const parent = await createDocument(db, { title: "P", creatorId: alice });
    const child = await createDocument(db, { title: "C", creatorId: alice, parentId: parent.id });
    const grand = await createDocument(db, { title: "G", creatorId: alice, parentId: child.id });
    await createDocument(db, { title: "unrelated", creatorId: alice });
    await addDocumentShare(policyCtx(alice), {
      documentId: parent.id,
      targetType: "user",
      targetId: bob,
      permission: "viewer",
    });

    const tree = await getDocumentTreeForUser(db, { id: bob, role: "user" });
    expect(tree.map(n => n.id).sort()).toEqual([parent.id, child.id, grand.id].sort());

    const mine = await listMyDocuments(db, { userId: bob });
    expect(mine.data.map(d => d.id).sort()).toEqual([parent.id, child.id, grand.id].sort());
  });

  test("non-admin only sees their own + their visible docs", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    await createDocument(db, { title: "alice doc", creatorId: alice });
    const bobDoc = await createDocument(db, { title: "bob doc", creatorId: bob });
    const tree = await getDocumentTreeForUser(db, { id: bob, role: "user" });
    expect(tree.map(n => n.id)).toEqual([bobDoc.id]);
  });
});
