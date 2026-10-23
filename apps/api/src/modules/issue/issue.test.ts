import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { items } from "@/modules/item/schema";
import { loadNamespaces } from "@/modules/policy/namespace-config";
import { relationTuples } from "@/modules/policy/schema";
import { nanoid } from "@/shared/lib/id";
import {
  createIssue,
  getIssueByShortId,
  listIssues,
  listMyIssues,
  softDeleteIssue,
  updateIssue,
} from "./issue.service";

let db: AppDatabase;
let dbPath: string;

async function seedUser(name: string, role: "admin" | "user" = "user") {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: `${name.toLowerCase()}-${id}`,
    name,
    email: `${id}@test.com`,
    role,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-issue-${Date.now()}-${nanoid()}`);
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

describe("createIssue", () => {
  test("creates with required fields", async () => {
    const userId = await seedUser("Alice");
    const issue = await createIssue(db, { title: "Test task", creatorId: userId });
    expect(issue.id).toHaveLength(8); // short_id
    expect(issue.title).toBe("Test task");
    expect(issue.status).toBe("open");
    expect(issue.priority).toBe("medium");
    expect(issue.creatorId).toBe(userId);
    expect(issue.assigneeId).toBeNull();
    expect(issue.version).toBe(1);
  });

  test("writes the owner tuple + writes assignee tuple when provided", async () => {
    const creator = await seedUser("Alice");
    const assignee = await seedUser("Bob");
    const issue = await createIssue(db, {
      title: "Full task",
      description: "Detailed",
      priority: "high",
      creatorId: creator,
      assigneeId: assignee,
      dueDate: "2026-12-31",
    });
    expect(issue.description).toBe("Detailed");
    expect(issue.priority).toBe("high");
    expect(issue.assigneeId).toBe(assignee);
    expect(issue.dueDate).toBe("2026-12-31");

    // The item id (ulid) is on `items.short_id = issue.id` → resolve back.
    const item = await db.select().from(items).where(eq(items.shortId, issue.id)).get();
    const tuples = await db.select().from(relationTuples).where(and(
      eq(relationTuples.namespace, "item"),
      eq(relationTuples.objectId, item!.id),
    )).all();
    const relations = new Set(tuples.map(t => `${t.relation}@${t.subjectId}`));
    expect(relations.has(`owner@${creator}`)).toBe(true);
    expect(relations.has(`assignee@${assignee}`)).toBe(true);
  });
});

describe("updateIssue", () => {
  test("changes status; bumps version", async () => {
    const userId = await seedUser("Alice");
    const issue = await createIssue(db, { title: "T", creatorId: userId });
    expect(issue.version).toBe(1);
    const updated = await updateIssue(db, issue.id, { status: "in_progress" });
    expect(updated?.status).toBe("in_progress");
    expect(updated!.version).toBeGreaterThan(1);
  });

  test("swaps the assignee tuple (1 in, 1 out)", async () => {
    const creator = await seedUser("Alice");
    const a = await seedUser("Bob");
    const b = await seedUser("Carol");
    const issue = await createIssue(db, { title: "T", creatorId: creator, assigneeId: a });
    expect(issue.assigneeId).toBe(a);
    const updated = await updateIssue(db, issue.id, { assigneeId: b });
    expect(updated?.assigneeId).toBe(b);

    const item = await db.select().from(items).where(eq(items.shortId, issue.id)).get();
    const tuples = await db.select().from(relationTuples).where(and(
      eq(relationTuples.namespace, "item"),
      eq(relationTuples.objectId, item!.id),
      eq(relationTuples.relation, "assignee"),
    )).all();
    expect(tuples).toHaveLength(1);
    expect(tuples[0]!.subjectId).toBe(b);
  });

  test("setting assigneeId=null drops the tuple", async () => {
    const creator = await seedUser("Alice");
    const a = await seedUser("Bob");
    const issue = await createIssue(db, { title: "T", creatorId: creator, assigneeId: a });
    await updateIssue(db, issue.id, { assigneeId: null });
    const refreshed = await getIssueByShortId(db, issue.id);
    expect(refreshed?.assigneeId).toBeNull();
  });
});

describe("softDeleteIssue", () => {
  test("stamps deleted_at and clears every tuple", async () => {
    const creator = await seedUser("Alice");
    const a = await seedUser("Bob");
    const issue = await createIssue(db, { title: "T", creatorId: creator, assigneeId: a });
    await softDeleteIssue(db, issue.id);
    expect(await getIssueByShortId(db, issue.id)).toBeUndefined();
    const item = await db.select().from(items).where(eq(items.shortId, issue.id)).get();
    const tuples = await db.select().from(relationTuples).where(and(
      eq(relationTuples.namespace, "item"),
      eq(relationTuples.objectId, item!.id),
    )).all();
    expect(tuples).toEqual([]);
  });
});

describe("listIssues (admin path)", () => {
  test("paginates and orders newest-first", async () => {
    const userId = await seedUser("Alice");
    for (let i = 0; i < 5; i++)
      await createIssue(db, { title: `Task ${i}`, creatorId: userId });
    const page1 = await listIssues(db, { page: 1, limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);
    const page3 = await listIssues(db, { page: 3, limit: 2 });
    expect(page3.data).toHaveLength(1);
  });

  test("filters by status", async () => {
    const userId = await seedUser("Alice");
    await createIssue(db, { title: "Open", creatorId: userId, status: "open" });
    await createIssue(db, { title: "Done", creatorId: userId, status: "done" });
    const r = await listIssues(db, { status: "open" });
    expect(r.data).toHaveLength(1);
    expect(r.data[0]!.title).toBe("Open");
  });

  test("filters by priority", async () => {
    const userId = await seedUser("Alice");
    await createIssue(db, { title: "Low", creatorId: userId, priority: "low" });
    await createIssue(db, { title: "High", creatorId: userId, priority: "high" });
    const r = await listIssues(db, { priority: "high" });
    expect(r.data).toHaveLength(1);
    expect(r.data[0]!.title).toBe("High");
  });

  test("filters by search (LIKE on title)", async () => {
    const userId = await seedUser("Alice");
    await createIssue(db, { title: "Fix the bug", creatorId: userId });
    await createIssue(db, { title: "Add feature", creatorId: userId });
    const r = await listIssues(db, { q: "bug" });
    expect(r.data).toHaveLength(1);
    expect(r.data[0]!.title).toBe("Fix the bug");
  });

  test("matches % and _ in the search literally", async () => {
    const userId = await seedUser("Alice");
    await createIssue(db, { title: "Ship 50% of fixes", creatorId: userId });
    await createIssue(db, { title: "Ship 500 fixes", creatorId: userId });
    await createIssue(db, { title: "Rename user_id", creatorId: userId });
    expect((await listIssues(db, { q: "50%" })).data.map(i => i.title)).toEqual(["Ship 50% of fixes"]);
    expect((await listIssues(db, { q: "_id" })).data.map(i => i.title)).toEqual(["Rename user_id"]);
  });

  test("filters by assignee id via the policy tuple set", async () => {
    const creator = await seedUser("Alice");
    const target = await seedUser("Bob");
    const other = await seedUser("Carol");
    await createIssue(db, { title: "Assigned", creatorId: creator, assigneeId: target });
    await createIssue(db, { title: "Free", creatorId: creator });
    await createIssue(db, { title: "Other", creatorId: creator, assigneeId: other });
    const r = await listIssues(db, { assigneeId: target });
    expect(r.data).toHaveLength(1);
    expect(r.data[0]!.title).toBe("Assigned");
  });
});

describe("listMyIssues", () => {
  test("returns issues I created OR have been assigned", async () => {
    const me = await seedUser("Me");
    const other = await seedUser("Other");
    const minePlain = await createIssue(db, { title: "Mine plain", creatorId: me });
    const assignedToMe = await createIssue(db, { title: "Assigned to me", creatorId: other, assigneeId: me });
    await createIssue(db, { title: "Theirs entirely", creatorId: other });
    const r = await listMyIssues(db, { userId: me });
    const ids = r.data.map(d => d.id).sort();
    expect(ids).toEqual([minePlain.id, assignedToMe.id].sort());
  });
});
