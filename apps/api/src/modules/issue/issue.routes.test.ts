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
import { DIRECT_SUBJECT, relationTuples } from "@/modules/policy/schema";
import { nanoid } from "@/shared/lib/id";
import { errorHandler } from "@/shared/middleware/error-handler";
import { issueRoutes } from "./issue.routes";
import { createIssue, resolveIssueItem } from "./issue.service";
import "@/modules/account";

const noopLogger = {
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
  const dir = resolve(tmpdir(), `test-issue-routes-${Date.now()}-${nanoid()}`);
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
    c.set("config", {
      NODE_ENV: "test",
      MAX_UPLOAD_BYTES: 1024 * 1024,
      MAX_ATTACHMENTS_PER_RESOURCE: 5,
      UPLOADS_TOTAL_BYTES: 0,
      FILE_STORAGE_DRIVER: "local",
      FILE_STORAGE_LOCAL_ROOT: resolve(dbPath, "../uploads"),
      FILE_PRESIGN_ENABLED: false,
      FILE_PRESIGN_TTL_SECONDS: 60,
    } as unknown as Config);
    c.set("logger", noopLogger);
    await next();
  });
  app.route("/", issueRoutes());
  app.onError(errorHandler);
  return app;
}

async function seedUser(role: "admin" | "user" = "user"): Promise<{ id: string; cookie: string }> {
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
  const sessionId = await createSession(db, id, "tok", undefined, 3600);
  return { id, cookie: `session_id=${sessionId}` };
}

/** Tuples key on the internal items.id, not the short id the API exposes. */
async function grant(shortId: string, relation: string, userId: string) {
  const item = (await resolveIssueItem(db, shortId))!;
  await db.insert(relationTuples).values({
    id: nanoid(),
    namespace: "item",
    objectId: item.id,
    relation,
    subjectNamespace: "user",
    subjectId: userId,
    subjectRelation: DIRECT_SUBJECT,
    createdBy: null,
    createdAt: new Date().toISOString(),
  }).run();
}

describe("issue routes answer from the policy engine", () => {
  test("an engine-granted viewer can read the issue and its attachment list", async () => {
    const app = buildApp();
    const owner = await seedUser();
    const viewer = await seedUser();
    const issue = await createIssue(db, { title: "shared", creatorId: owner.id });
    await grant(issue.id, "viewer", viewer.id);

    expect((await app.request(`/issues/${issue.id}`, {
      headers: { Cookie: viewer.cookie },
    })).status).toBe(200);
    expect((await app.request(`/issues/${issue.id}/attachments`, {
      headers: { Cookie: viewer.cookie },
    })).status).toBe(200);
    // but not edit or delete
    const patch = await app.request(`/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cookie": viewer.cookie },
      body: JSON.stringify({ title: "x" }),
    });
    expect(patch.status).toBe(403);
    expect((await app.request(`/issues/${issue.id}`, {
      method: "DELETE",
      headers: { Cookie: viewer.cookie },
    })).status).toBe(403);
  });

  test("the assignee may move status but not rewrite the record", async () => {
    const app = buildApp();
    const owner = await seedUser();
    const assignee = await seedUser();
    const issue = await createIssue(db, { title: "assigned", creatorId: owner.id, assigneeId: assignee.id });

    const statusOnly = await app.request(`/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cookie": assignee.cookie },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(statusOnly.status).toBe(200);
    const retitle = await app.request(`/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "Cookie": assignee.cookie },
      body: JSON.stringify({ title: "nope" }),
    });
    expect(retitle.status).toBe(403);
  });

  test("a stranger gets 403 on read", async () => {
    const app = buildApp();
    const owner = await seedUser();
    const stranger = await seedUser();
    const issue = await createIssue(db, { title: "private", creatorId: owner.id });
    expect((await app.request(`/issues/${issue.id}`, {
      headers: { Cookie: stranger.cookie },
    })).status).toBe(403);
  });
});
