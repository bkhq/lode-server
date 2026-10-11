import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { isUniqueViolation } from "@/shared/lib/errors";
import { addUserMember } from "./group-members.service";
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupByName,
  getGroupMembers,
  listGroups,
  removeGroupMember,
  updateGroup,
} from "./groups.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

async function seedUser(overrides: Partial<{ name: string; email: string }> = {}) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: `user-${id}`,
    name: overrides.name ?? `User ${id}`,
    email: overrides.email ?? `${id}@test.com`,
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-group-${Date.now()}-${nanoid()}`);
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

describe("createGroup", () => {
  test("creates a group", async () => {
    const group = await createGroup(db, { name: "devs", description: "developers" });
    expect(group.name).toBe("devs");
    expect(group.description).toBe("developers");
    expect(group.id).toHaveLength(8);
  });

  test("creates group without description", async () => {
    const group = await createGroup(db, { name: "ops" });
    expect(group.description).toBeNull();
  });
});

describe("listGroups", () => {
  test("returns groups with member counts", async () => {
    const g = await createGroup(db, { name: "team" });
    const u1 = await seedUser();
    const u2 = await seedUser();
    await addGroupMember(db, g.id, u1);
    await addGroupMember(db, g.id, u2);

    const groupsList = await listGroups(db);
    expect(groupsList.length).toBe(1);
    expect(groupsList[0]!.memberCount).toBe(2);
  });
});

describe("getGroupById / getGroupByName", () => {
  test("finds by id", async () => {
    const g = await createGroup(db, { name: "test" });
    expect((await getGroupById(db, g.id))?.name).toBe("test");
    expect(await getGroupById(db, "nope")).toBeUndefined();
  });

  test("finds by name", async () => {
    await createGroup(db, { name: "found" });
    expect((await getGroupByName(db, "found"))?.name).toBe("found");
    expect(await getGroupByName(db, "missing")).toBeUndefined();
  });
});

describe("updateGroup", () => {
  test("updates name and description", async () => {
    const g = await createGroup(db, { name: "old", description: "old desc" });
    const updated = await updateGroup(db, g.id, { name: "new", description: "new desc" });
    expect(updated?.name).toBe("new");
    expect(updated?.description).toBe("new desc");
  });
});

describe("deleteGroup", () => {
  test("deletes group and its memberships", async () => {
    const g = await createGroup(db, { name: "bye" });
    const u = await seedUser();
    await addGroupMember(db, g.id, u);

    await deleteGroup(db, g.id);
    expect(await getGroupById(db, g.id)).toBeUndefined();
    expect((await getGroupMembers(db, g.id)).length).toBe(0);
  });
});

describe("member management", () => {
  test("addGroupMember adds and prevents duplicates", async () => {
    const g = await createGroup(db, { name: "team" });
    const u = await seedUser();

    expect(await addGroupMember(db, g.id, u)).toBe(true);
    expect(await addGroupMember(db, g.id, u)).toBe(false);
  });

  test("getGroupMembers returns members", async () => {
    const g = await createGroup(db, { name: "team" });
    const u1 = await seedUser({ name: "Alice" });
    const u2 = await seedUser({ name: "Bob" });
    await addGroupMember(db, g.id, u1);
    await addGroupMember(db, g.id, u2);

    const members = await getGroupMembers(db, g.id);
    expect(members.length).toBe(2);
    expect(members.map(m => m.name).sort()).toEqual(["Alice", "Bob"]);
  });

  test("removeGroupMember removes and returns false for non-member", async () => {
    const g = await createGroup(db, { name: "team" });
    const u = await seedUser();
    await addGroupMember(db, g.id, u);

    expect(await removeGroupMember(db, g.id, u)).toBe(true);
    expect(await removeGroupMember(db, g.id, u)).toBe(false);
    expect((await getGroupMembers(db, g.id)).length).toBe(0);
  });
});

describe("group_members direct-membership uniqueness", () => {
  test("the index rejects a duplicate direct member and NULL rows are impossible", async () => {
    const userId = await seedUser();
    const group = await createGroup(db, { name: "uniq" });

    expect(await addUserMember(db, group.id, userId, userId)).toBe(true);
    // Second add is refused by idx_group_members_unique, not an app-level pre-check.
    expect(await addUserMember(db, group.id, userId, userId)).toBe(false);

    // A raw duplicate carrying the sentinel trips the index.
    let raw: unknown;
    try {
      await db.run(sql`INSERT INTO group_members (id, group_id, subject_namespace, subject_id, subject_relation, created_at)
                       VALUES ('dup', ${group.id}, 'user', ${userId}, '', '2026-01-01T00:00:00Z')`);
    }
    catch (err) {
      raw = err;
    }
    expect(isUniqueViolation(raw)).toBe(true);

    // NULL can no longer be stored at all — that was the hole the sentinel closes.
    let nullErr: unknown;
    try {
      await db.run(sql`INSERT INTO group_members (id, group_id, subject_namespace, subject_id, subject_relation, created_at)
                       VALUES ('nul', ${group.id}, 'user', ${userId}, NULL, '2026-01-01T00:00:00Z')`);
    }
    catch (err) {
      nullErr = err;
    }
    expect(nullErr).toBeDefined();
  });
});
