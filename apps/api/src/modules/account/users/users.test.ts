import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { addGroupMember, createGroup } from "@/modules/account/groups/groups.service";
import { users } from "@/modules/account/users/schema";
import { getUserById, getUserGroups, listUsers, updateUser } from "./users.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

async function seedUser(overrides: Partial<{
  id: string;
  oauthSub: string;
  username: string;
  name: string;
  email: string;
  role: "admin" | "user";
  status: "active" | "disabled";
}> = {}) {
  const id = overrides.id ?? nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: overrides.oauthSub ?? `sub-${id}`,
    username: overrides.username ?? `user-${id}`,
    name: overrides.name ?? `User ${id}`,
    email: overrides.email ?? `${id}@test.com`,
    role: overrides.role ?? "user",
    status: overrides.status ?? "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-user-${Date.now()}-${nanoid()}`);
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

describe("listUsers", () => {
  test("returns paginated results", async () => {
    for (let i = 0; i < 25; i++) await seedUser();
    const result = await listUsers(db, { page: 1, limit: 10 });
    expect(result.data.length).toBe(10);
    expect(result.total).toBe(25);
    expect(result.totalPages).toBe(3);
  });

  test("searches by name and email", async () => {
    await seedUser({ name: "Alice Smith", email: "alice@test.com", username: "alice" });
    await seedUser({ name: "Bob Jones", email: "bob@test.com", username: "bob" });

    const byName = await listUsers(db, { q: "alice", page: 1, limit: 20 });
    expect(byName.data.length).toBe(1);
    expect(byName.data[0]!.name).toBe("Alice Smith");

    const byEmail = await listUsers(db, { q: "bob@", page: 1, limit: 20 });
    expect(byEmail.data.length).toBe(1);
  });

  test("filters by role", async () => {
    await seedUser({ role: "admin" });
    await seedUser({ role: "user" });
    await seedUser({ role: "user" });

    const admins = await listUsers(db, { role: "admin", page: 1, limit: 20 });
    expect(admins.total).toBe(1);
  });

  test("filters by status", async () => {
    await seedUser({ status: "active" });
    await seedUser({ status: "disabled" });

    const active = await listUsers(db, { status: "active", page: 1, limit: 20 });
    expect(active.total).toBe(1);
  });

  test("filters by group", async () => {
    const u1 = await seedUser();
    await seedUser();
    const group = await createGroup(db, { name: "test-group" });
    await addGroupMember(db, group.id, u1);

    const result = await listUsers(db, { groupId: group.id, page: 1, limit: 20 });
    expect(result.total).toBe(1);
    expect(result.data[0]!.id).toBe(u1);
  });
});

describe("getUserById", () => {
  test("returns user or undefined", async () => {
    const id = await seedUser({ name: "Test" });
    expect((await getUserById(db, id))?.name).toBe("Test");
    expect(await getUserById(db, "nonexistent")).toBeUndefined();
  });
});

describe("updateUser", () => {
  test("updates role", async () => {
    const id = await seedUser({ role: "user" });
    const updated = await updateUser(db, id, { role: "admin" });
    expect(updated?.role).toBe("admin");
  });

  test("updates status", async () => {
    const id = await seedUser({ status: "active" });
    const updated = await updateUser(db, id, { status: "disabled" });
    expect(updated?.status).toBe("disabled");
  });
});

describe("getUserGroups", () => {
  test("returns groups for user", async () => {
    const userId = await seedUser();
    const g1 = await createGroup(db, { name: "group-a" });
    const g2 = await createGroup(db, { name: "group-b" });
    await addGroupMember(db, g1.id, userId);
    await addGroupMember(db, g2.id, userId);

    const userGroupsList = await getUserGroups(db, userId);
    expect(userGroupsList.length).toBe(2);
    expect(userGroupsList.map(g => g.name).sort()).toEqual(["group-a", "group-b"]);
  });
});
