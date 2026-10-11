import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { AppDatabase } from "@/db/types";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { users } from "@/modules/account/users/schema";
import { createItem, getItemById, isVersionConflict, softDeleteItem, updateItem } from "@/modules/item/item.service";
import { items } from "@/modules/item/schema";
import { createWorkersDb } from "./db";

/**
 * A Durable Object storage stand-in backed by bun:sqlite, implementing just
 * the surface drizzle's Durable Object driver and this adapter touch:
 * `sql.exec` returning a cursor (`toArray`, `next`, `raw().toArray()`),
 * `transactionSync`, and the async `transaction`.
 *
 * It exists so the adapter's result shapes are checked by `bun test`, not
 * only by a deployment. Each statement executes exactly once — building the
 * object rows from the array rows — so an `INSERT … RETURNING` is not run
 * twice.
 */
function fakeDurableStorage(): DurableObjectStorage {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");

  function cursor(rows: Record<string, unknown>[], arrays: unknown[][]) {
    let i = 0;
    return {
      toArray: () => rows,
      raw: () => ({ toArray: () => arrays }),
      next: () => (i < rows.length ? { value: rows[i++], done: false } : { value: undefined, done: true }),
    };
  }

  const exec = (query: string, ...params: unknown[]) => {
    const stmt = sqlite.prepare(query);
    const columns = stmt.columnNames;
    if (columns.length === 0) {
      stmt.run(...(params as never[]));
      return cursor([], []);
    }
    const arrays = stmt.values(...(params as never[])) as unknown[][];
    const rows = arrays.map(values => Object.fromEntries(columns.map((c, i) => [c, values[i]])));
    return cursor(rows, arrays);
  };

  return {
    sql: { exec },
    transactionSync: <T>(fn: () => T): T => sqlite.transaction(fn)(),
    transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      sqlite.exec("SAVEPOINT tx");
      try {
        const result = await fn();
        sqlite.exec("RELEASE tx");
        return result;
      }
      catch (err) {
        sqlite.exec("ROLLBACK TO tx");
        sqlite.exec("RELEASE tx");
        throw err;
      }
    },
  } as unknown as DurableObjectStorage;
}

async function seedUser(db: AppDatabase, id = "u1"): Promise<string> {
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: id,
    name: id,
    email: `${id}@test.local`,
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

describe("Durable Object database adapter — write results", () => {
  test("a builder run() reports rows affected, as libsql does", async () => {
    // drizzle's Durable Object driver returns nothing from run(), so every
    // `result.rowsAffected` read in the app threw on Workers.
    const db = await createWorkersDb(fakeDurableStorage());
    const id = await seedUser(db);

    const hit = await db.update(users).set({ name: "renamed" }).where(eq(users.id, id)).run();
    expect(hit.rowsAffected).toBe(1);

    const miss = await db.update(users).set({ name: "nobody" }).where(eq(users.id, "missing")).run();
    expect(miss.rowsAffected).toBe(0);
  });

  test("a raw db.run(sql) reports rows affected", async () => {
    const db = await createWorkersDb(fakeDurableStorage());
    await seedUser(db, "a");
    await seedUser(db, "b");

    const res = await db.run(sql`DELETE FROM users WHERE id IN ('a', 'b')`);
    expect(res.rowsAffected).toBe(2);
  });
});

describe("Durable Object database adapter — the code paths that broke", () => {
  test("an edit with a stale version returns the conflict instead of throwing", async () => {
    const db = await createWorkersDb(fakeDurableStorage());
    const creatorId = await seedUser(db);
    const item = await createItem(db, { type: "issue", title: "t", status: "open", creatorId });

    const first = await updateItem(db, item.id, { title: "v2", expectedVersion: item.version });
    expect(isVersionConflict(first)).toBe(false);

    const stale = await updateItem(db, item.id, { title: "v3", expectedVersion: item.version });
    expect(isVersionConflict(stale)).toBe(true);
  });

  test("a soft delete completes", async () => {
    const db = await createWorkersDb(fakeDurableStorage());
    const creatorId = await seedUser(db);
    const item = await createItem(db, { type: "issue", title: "t", status: "open", creatorId });

    await softDeleteItem(db, item.id);
    // The live lookup no longer sees it; the row itself carries the stamp.
    expect(await getItemById(db, item.id)).toBeUndefined();
    const row = await db.select().from(items).where(eq(items.id, item.id)).get();
    expect(row?.deletedAt).toBeTruthy();
  });

  test("a rejected transaction rolls back", async () => {
    const db = await createWorkersDb(fakeDurableStorage());
    await expect(db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: "ghost",
        oauthSub: "sub-ghost",
        username: "ghost",
        name: "ghost",
        email: "ghost@test.local",
        role: "user",
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).run();
      throw new Error("abort");
    })).rejects.toThrow("abort");

    expect(await db.select().from(users).where(eq(users.id, "ghost")).get()).toBeUndefined();
  });
});

describe("Durable Object database adapter — reads", () => {
  test("a raw db.get(sql) with no matching row returns undefined, as on Bun", async () => {
    const db = await createWorkersDb(fakeDurableStorage());
    expect(await db.get(sql`SELECT 1 AS x WHERE 0`)).toBeUndefined();
    expect(await db.get<{ x: number }>(sql`SELECT 1 AS x`)).toEqual({ x: 1 });
  });
});
