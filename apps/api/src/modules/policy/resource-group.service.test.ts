import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { ValidationError } from "@/shared/lib/errors";
import {
  addResourceGroupMember,
  createResourceGroup,
  deleteResourceGroup,
  getResourceGroupMembers,
  listResourceGroups,
  removeResourceGroupMember,
  updateResourceGroup,
} from "./resource-group.service";
import { DIRECT_SUBJECT, relationTuples, resourceGroups } from "./schema";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;
// relation_tuples.created_by is a FK to users.id, so every tuple-writing
// call needs a real seeded user id as the actor.
let actor: string;

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-rg-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);

  actor = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: actor,
    oauthSub: `sub-${actor}`,
    username: `user-${actor}`,
    name: `User ${actor}`,
    email: `${actor}@test.com`,
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
});

describe("createResourceGroup", () => {
  test("creates a resource group (happy path)", async () => {
    const rg = await createResourceGroup(db, { name: "prod", description: "production" }, actor);
    expect(rg.name).toBe("prod");
    expect(rg.description).toBe("production");
    expect(rg.id).toHaveLength(8);
    expect(rg.createdAt.length).toBeGreaterThan(0);

    const list = await listResourceGroups(db);
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe("prod");
  });

  test("creates without description (null)", async () => {
    const rg = await createResourceGroup(db, { name: "staging" }, actor);
    expect(rg.description).toBeNull();
  });

  test("trims name and rejects empty/whitespace name", async () => {
    await expect(createResourceGroup(db, { name: "   " }, actor)).rejects.toBeInstanceOf(ValidationError);
    const rg = await createResourceGroup(db, { name: "  spaced  " }, actor);
    expect(rg.name).toBe("spaced");
  });

  test("rejects duplicate name with ValidationError", async () => {
    await createResourceGroup(db, { name: "dup" }, actor);
    await expect(createResourceGroup(db, { name: "dup" }, actor)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("updateResourceGroup", () => {
  test("renames (happy path)", async () => {
    const rg = await createResourceGroup(db, { name: "old", description: "d1" }, actor);
    const updated = await updateResourceGroup(db, rg.id, { name: "new", description: "d2" });
    expect(updated.name).toBe("new");
    expect(updated.description).toBe("d2");
    expect(updated.createdAt).toBe(rg.createdAt);

    const list = await listResourceGroups(db);
    expect(list[0]!.name).toBe("new");
  });

  test("rejects rename to an existing name with ValidationError", async () => {
    await createResourceGroup(db, { name: "taken" }, actor);
    const rg = await createResourceGroup(db, { name: "mine" }, actor);
    await expect(updateResourceGroup(db, rg.id, { name: "taken" })).rejects.toBeInstanceOf(ValidationError);
  });

  test("allows renaming to the same name (no clash check)", async () => {
    const rg = await createResourceGroup(db, { name: "same", description: "a" }, actor);
    const updated = await updateResourceGroup(db, rg.id, { name: "same", description: "b" });
    expect(updated.name).toBe("same");
    expect(updated.description).toBe("b");
  });

  test("throws NotFoundError for a non-existent group", async () => {
    await expect(updateResourceGroup(db, "nope1234", { name: "x" })).rejects.toThrow(/not found/i);
  });

  test("rejects empty/whitespace name with ValidationError", async () => {
    const rg = await createResourceGroup(db, { name: "g1" }, actor);
    await expect(updateResourceGroup(db, rg.id, { name: "  " })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("deleteResourceGroup", () => {
  test("returns false for a non-existent group", async () => {
    expect(await deleteResourceGroup(db, "missing1")).toBe(false);
  });

  test("identity lives in resource_groups, not in a __meta__ tuple", async () => {
    const rg = await createResourceGroup(db, { name: "table-backed", description: "desc" }, actor);
    const rows = await db.select().from(resourceGroups).where(eq(resourceGroups.id, rg.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("table-backed");
    expect(rows[0]!.description).toBe("desc");
    expect(await db.select().from(relationTuples).all()).toHaveLength(0);

    expect((await listResourceGroups(db)).map(g => g.id)).toContain(rg.id);
  });

  test("cascade removes the row + parent + access tuples", async () => {
    const rg = await createResourceGroup(db, { name: "cascade" }, actor);

    // member tuple (<resource>:<id>#parent@resource_group:<groupId>)
    await addResourceGroupMember(db, rg.id, "item", "item-1", actor);

    // an access tuple directly on the resource group object
    await db.insert(relationTuples).values({
      id: nanoid(),
      namespace: "resource_group",
      objectId: rg.id,
      relation: "viewer",
      subjectNamespace: "user",
      subjectId: "user-9",
      subjectRelation: DIRECT_SUBJECT,
      createdBy: actor,
      createdAt: new Date().toISOString(),
    }).run();

    const before = await db.select().from(relationTuples).all();
    expect(before.length).toBe(2);

    expect(await deleteResourceGroup(db, rg.id)).toBe(true);

    // row gone
    expect(await db.select().from(resourceGroups).where(eq(resourceGroups.id, rg.id)).get()).toBeUndefined();

    // parent member tuple gone
    expect((await getResourceGroupMembers(db, rg.id)).length).toBe(0);

    // access tuple gone — nothing left at all
    const after = await db.select().from(relationTuples).all();
    expect(after.length).toBe(0);
  });
});

describe("member management", () => {
  test("addResourceGroupMember adds a member and lists it", async () => {
    const rg = await createResourceGroup(db, { name: "team" }, actor);
    const m = await addResourceGroupMember(db, rg.id, "item", "item-42", actor);
    expect(m.namespace).toBe("item");
    expect(m.objectId).toBe("item-42");
    expect(m.tupleId).toHaveLength(8);

    const members = await getResourceGroupMembers(db, rg.id);
    expect(members.length).toBe(1);
    expect(members[0]!.objectId).toBe("item-42");
  });

  test("rejects an invalid member namespace with ValidationError", async () => {
    const rg = await createResourceGroup(db, { name: "team" }, actor);
    await expect(addResourceGroupMember(db, rg.id, "user", "u-1", actor)).rejects.toBeInstanceOf(ValidationError);
    await expect(addResourceGroupMember(db, rg.id, "bogus", "x-1", actor)).rejects.toBeInstanceOf(ValidationError);
  });

  test("rejects adding a member to a non-existent group (NotFoundError)", async () => {
    await expect(addResourceGroupMember(db, "nope1234", "item", "i-1", actor)).rejects.toThrow(/not found/i);
  });

  test("rejects duplicate members with ValidationError", async () => {
    const rg = await createResourceGroup(db, { name: "team" }, actor);
    await addResourceGroupMember(db, rg.id, "item", "item-1", actor);
    await expect(addResourceGroupMember(db, rg.id, "item", "item-1", actor)).rejects.toBeInstanceOf(ValidationError);
  });

  test("removeResourceGroupMember removes and returns false for unknown tuple", async () => {
    const rg = await createResourceGroup(db, { name: "team" }, actor);
    const m = await addResourceGroupMember(db, rg.id, "item", "item-1", actor);

    expect(await removeResourceGroupMember(db, m.tupleId)).toBe(true);
    expect(await removeResourceGroupMember(db, m.tupleId)).toBe(false);
    expect((await getResourceGroupMembers(db, rg.id)).length).toBe(0);
  });
});
