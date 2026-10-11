import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "./index";

async function mmapSizeOf(key?: string): Promise<number> {
  const dir = resolve(tmpdir(), `test-db-mmap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const db = await createDb(resolve(dir, "app.db"), key);
  const rows = await db.all<{ mmap_size: number }>(sql`PRAGMA mmap_size`);
  db.close();
  rmSync(dir, { recursive: true, force: true });
  return Number(rows[0]?.mmap_size ?? -1);
}

describe("createDb memory-mapped I/O", () => {
  test("a plaintext database is memory-mapped", async () => {
    expect(await mmapSizeOf()).toBe(268435456);
  });

  test("an encrypted database is never memory-mapped", async () => {
    // libsql page encryption + mmap corrupts the file under ordinary
    // write patterns (see createDb); the mapping must stay off.
    expect(await mmapSizeOf("ab".repeat(32))).toBe(0);
  });
});
