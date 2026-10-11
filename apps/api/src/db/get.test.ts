import type { AppDatabase } from "./types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { users } from "@/modules/account/users/schema";
import { createDb } from "./index";

let dir: string;
let db: AppDatabase;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "db-get-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("db.get with no matching row", () => {
  // drizzle's libsql driver maps a raw `get(sql)` result with Object.keys on
  // the first row, so an empty result threw "Failed query" instead of
  // returning undefined — unlike the builder `.get()` and the Durable Object
  // driver, which both return undefined.
  test("a raw db.get(sql) returns undefined", async () => {
    expect(await db.get(sql`SELECT 1 AS x WHERE 0`)).toBeUndefined();
  });

  test("a raw get inside a transaction returns undefined", async () => {
    const got = await db.transaction(async tx => tx.get(sql`SELECT 1 AS x WHERE 0`));
    expect(got).toBeUndefined();
  });

  test("a raw get still returns the row when there is one", async () => {
    expect(await db.get<{ x: number }>(sql`SELECT 1 AS x`)).toEqual({ x: 1 });
  });

  test("a builder get returns undefined, as before", async () => {
    expect(await db.select().from(users).get()).toBeUndefined();
  });
});
