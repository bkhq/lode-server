import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { items } from "@/modules/item/schema";
import { listTuples } from "@/modules/policy/policy.service";
import { relationTuples } from "@/modules/policy/schema";
import {
  assertItemExists,
  createItem,
  getItemById,
  getItemByShortId,
  isVersionConflict,
  listItemsByIds,
  listItemsByType,
  resolveItem,
  restoreItem,
  softDeleteItem,
  updateItem,
} from "./item.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

async function seedUser(name: string) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: name.toLowerCase(),
    name,
    email: `${name.toLowerCase()}@test.com`,
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-item-${Date.now()}-${nanoid()}`);
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

describe("createItem", () => {
  test("inserts an item with a ULID id and a separate nanoid short_id", async () => {
    const userId = await seedUser("Alice");
    const before = Date.now();
    const item = await createItem(db, {
      type: "issue",
      title: "Hello",
      status: "open",
      creatorId: userId,
    });
    const after = Date.now();
    expect(item.id).toHaveLength(26);
    expect(item.shortId).toHaveLength(8);
    expect(item.shortId).not.toBe(item.id);
    // The first 10 chars of the ULID encode Date.now() in Crockford base32.
    const timeChunk = item.id.slice(0, 10);
    let decoded = 0;
    for (const ch of timeChunk) {
      decoded = decoded * 32 + "0123456789abcdefghjkmnpqrstvwxyz".indexOf(ch);
    }
    expect(decoded).toBeGreaterThanOrEqual(before);
    expect(decoded).toBeLessThanOrEqual(after);
    expect(item.type).toBe("issue");
    expect(item.title).toBe("Hello");
    expect(item.status).toBe("open");
    expect(item.creatorId).toBe(userId);
    expect(item.version).toBe(1);
    expect(item.deletedAt).toBeNull();
  });

  test("writes an `owner` tuple keyed off the creator", async () => {
    const userId = await seedUser("Alice");
    const item = await createItem(db, {
      type: "issue",
      title: "Hello",
      status: "open",
      creatorId: userId,
    });
    const tuples = await listTuples(db, { namespace: "item", objectId: item.id });
    expect(tuples.total).toBe(1);
    expect(tuples.data[0]!.relation).toBe("owner");
    expect(tuples.data[0]!.subjectNamespace).toBe("user");
    expect(tuples.data[0]!.subjectId).toBe(userId);
  });

  test("honours an explicit short_id override", async () => {
    const userId = await seedUser("Alice");
    const item = await createItem(db, {
      type: "issue",
      title: "Hello",
      status: "open",
      creatorId: userId,
      shortId: "tkt-001",
    });
    expect(item.shortId).toBe("tkt-001");
  });
});

describe("get / resolve", () => {
  test("getItemById returns the live row", async () => {
    const userId = await seedUser("Alice");
    const item = await createItem(db, { type: "issue", title: "Hi", status: "open", creatorId: userId });
    expect(await getItemById(db, item.id)).toEqual(item);
  });

  test("getItemById returns undefined for soft-deleted rows", async () => {
    const userId = await seedUser("Alice");
    const item = await createItem(db, { type: "issue", title: "Hi", status: "open", creatorId: userId });
    await softDeleteItem(db, item.id);
    expect(await getItemById(db, item.id)).toBeUndefined();
  });

  test("getItemByShortId works for custom short ids", async () => {
    const userId = await seedUser("Alice");
    await createItem(db, { type: "issue", title: "Hi", status: "open", creatorId: userId, shortId: "tkt-7" });
    const row = await getItemByShortId(db, "tkt-7");
    expect(row?.shortId).toBe("tkt-7");
  });

  test("resolveItem matches by both id and short_id", async () => {
    const userId = await seedUser("Alice");
    const item = await createItem(db, { type: "issue", title: "Hi", status: "open", creatorId: userId, shortId: "tkt-9" });
    expect((await resolveItem(db, item.id))?.id).toBe(item.id);
    expect((await resolveItem(db, "tkt-9"))?.id).toBe(item.id);
    expect(await resolveItem(db, "nope")).toBeUndefined();
  });

  test("assertItemExists throws NotFoundError", async () => {
    await expect(assertItemExists(db, "missing-")).rejects.toThrow(/not found/);
  });
});

describe("updateItem", () => {
  test("bumps version on every update", async () => {
    const userId = await seedUser("Alice");
    const item = await createItem(db, { type: "issue", title: "v1", status: "open", creatorId: userId });
    const updated = await updateItem(db, item.id, { title: "v2" });
    expect(isVersionConflict(updated)).toBe(false);
    if (!isVersionConflict(updated))
      expect(updated?.version).toBe(2);
  });

  test("returns a VersionConflict when expectedVersion mismatches", async () => {
    const userId = await seedUser("Alice");
    const item = await createItem(db, { type: "issue", title: "v1", status: "open", creatorId: userId });
    // First write bumps to v2.
    await updateItem(db, item.id, { title: "v2" });
    // Second write believes it's still on v1.
    const result = await updateItem(db, item.id, { title: "wrong", expectedVersion: 1 });
    expect(isVersionConflict(result)).toBe(true);
    if (isVersionConflict(result))
      expect(result.current.title).toBe("v2");
  });

  test("does not update soft-deleted items", async () => {
    const userId = await seedUser("Alice");
    const item = await createItem(db, { type: "issue", title: "v1", status: "open", creatorId: userId });
    await softDeleteItem(db, item.id);
    await updateItem(db, item.id, { title: "ghost" });
    // Read raw (bypass live filter) — title is unchanged.
    const raw = await db.select().from(items).where(eq(items.id, item.id)).get();
    expect(raw?.title).toBe("v1");
  });
});

describe("softDeleteItem / restoreItem", () => {
  test("softDelete stamps deleted_at and removes tuples for the item", async () => {
    const userId = await seedUser("Alice");
    const item = await createItem(db, { type: "issue", title: "Hi", status: "open", creatorId: userId });
    await softDeleteItem(db, item.id);

    const raw = await db.select().from(items).where(eq(items.id, item.id)).get();
    expect(raw?.deletedAt).not.toBeNull();

    const tuplesAfter = await listTuples(db, { namespace: "item", objectId: item.id });
    expect(tuplesAfter.total).toBe(0);
  });

  test("softDelete is idempotent and a no-op on missing rows", async () => {
    await softDeleteItem(db, "nope-1234");
    const userId = await seedUser("Alice");
    const item = await createItem(db, { type: "issue", title: "Hi", status: "open", creatorId: userId });
    await softDeleteItem(db, item.id);
    // Tuple count: removed when alive.
    const t1 = await db.select().from(relationTuples).where(
      and(eq(relationTuples.namespace, "item"), eq(relationTuples.objectId, item.id)),
    ).all();
    expect(t1.length).toBe(0);
    // Calling again does nothing extra.
    await softDeleteItem(db, item.id);
  });

  test("restoreItem clears deleted_at and bumps version", async () => {
    const userId = await seedUser("Alice");
    const item = await createItem(db, { type: "issue", title: "Hi", status: "open", creatorId: userId });
    await softDeleteItem(db, item.id);
    const restored = await restoreItem(db, item.id);
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.version ?? 0).toBeGreaterThan(item.version);
    // Tuples are NOT re-issued — restore is for human recovery, the sub-type
    // is responsible for re-writing relations if it wants them back.
    const tuples = await listTuples(db, { namespace: "item", objectId: item.id });
    expect(tuples.total).toBe(0);
  });
});

describe("listItemsByIds / listItemsByType", () => {
  test("listItemsByIds filters by ids and excludes soft-deleted rows", async () => {
    const userId = await seedUser("Alice");
    const a = await createItem(db, { type: "issue", title: "Apple", status: "open", creatorId: userId });
    const b = await createItem(db, { type: "issue", title: "Banana", status: "open", creatorId: userId });
    const c = await createItem(db, { type: "issue", title: "Cherry", status: "open", creatorId: userId });
    await softDeleteItem(db, c.id);

    const result = await listItemsByIds(db, [a.id, b.id, c.id]);
    expect(result.total).toBe(2);
    expect(result.data.map(r => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("listItemsByIds with empty input returns empty page", async () => {
    const result = await listItemsByIds(db, []);
    expect(result.total).toBe(0);
    expect(result.data).toEqual([]);
  });

  test("listItemsByType honours type + status + search", async () => {
    const userId = await seedUser("Alice");
    await createItem(db, { type: "issue", title: "Apple bug", status: "open", creatorId: userId });
    await createItem(db, { type: "issue", title: "Banana done", status: "done", creatorId: userId });
    await createItem(db, { type: "document", title: "Apple doc", status: "active", creatorId: userId });

    const issuesOpen = await listItemsByType(db, { type: "issue", status: "open" });
    expect(issuesOpen.total).toBe(1);
    expect(issuesOpen.data[0]!.title).toBe("Apple bug");

    const issuesApple = await listItemsByType(db, { type: "issue", search: "apple" });
    expect(issuesApple.total).toBe(1);

    const docs = await listItemsByType(db, { type: "document" });
    expect(docs.total).toBe(1);
  });

  test("listItemsByType paginates", async () => {
    const userId = await seedUser("Alice");
    for (let i = 0; i < 5; i++) {
      await createItem(db, { type: "issue", title: `Task ${i}`, status: "open", creatorId: userId });
    }
    const page1 = await listItemsByType(db, { type: "issue", page: 1, limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);
    const page3 = await listItemsByType(db, { type: "issue", page: 3, limit: 2 });
    expect(page3.data).toHaveLength(1);
  });
});
