import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { files } from "@/modules/file/schema";
import { AppError } from "@/shared/lib/errors";
import { __resetUploadsCacheForTests, assertWithinTotalQuota, getUploadsUsedBytes, isWithinFileSize } from "./upload-limits";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const sizeConfig = { MAX_UPLOAD_BYTES: DEFAULT_MAX_UPLOAD_BYTES };

let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "upload-limits-"));
  db = await createDb(resolve(dir, "app.db"));
  __resetUploadsCacheForTests();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedFileRow(size: number) {
  const userId = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: userId,
    oauthSub: `sub_${userId}`,
    username: `u_${userId}`,
    name: "u",
    email: `${userId}@example.com`,
    createdAt: now,
    updatedAt: now,
  }).run();
  // 64-hex content key; unique per row so the (sha256, storage_driver)
  // UNIQUE index doesn't reject.
  const sha = (`a${userId}${userId}${userId}`).repeat(8).slice(0, 64);
  await db.insert(files).values({
    id: `01k${nanoid()}${nanoid()}${nanoid()}`.slice(0, 26),
    sha256: sha,
    size,
    mimetype: "text/plain",
    storageDriver: "local",
    storageKey: `aa/bb/${sha}`,
    refCount: 1,
    uploadedBy: userId,
  }).run();
}

describe("isWithinFileSize", () => {
  test("rejects zero", () => {
    expect(isWithinFileSize(0, sizeConfig)).toBe(false);
  });
  test("accepts under cap", () => {
    expect(isWithinFileSize(sizeConfig.MAX_UPLOAD_BYTES - 1, sizeConfig)).toBe(true);
  });
  test("accepts at cap", () => {
    expect(isWithinFileSize(sizeConfig.MAX_UPLOAD_BYTES, sizeConfig)).toBe(true);
  });
  test("rejects over cap", () => {
    expect(isWithinFileSize(sizeConfig.MAX_UPLOAD_BYTES + 1, sizeConfig)).toBe(false);
  });
});

describe("getUploadsUsedBytes", () => {
  test("returns 0 on empty tables", async () => {
    expect(await getUploadsUsedBytes(db)).toBe(0);
  });

  test("sums file sizes", async () => {
    __resetUploadsCacheForTests();
    await seedFileRow(1024);
    await seedFileRow(2048);
    expect(await getUploadsUsedBytes(db)).toBe(3072);
  });
});

describe("assertWithinTotalQuota", () => {
  test("no-op when UPLOADS_TOTAL_BYTES is 0 (the default)", async () => {
    await expect(assertWithinTotalQuota(db, { UPLOADS_TOTAL_BYTES: 0 }, 1024 * 1024 * 1024)).resolves.toBeUndefined();
  });

  test("passes when used + additional is exactly at the limit", async () => {
    await seedFileRow(900);
    __resetUploadsCacheForTests();
    await expect(assertWithinTotalQuota(db, { UPLOADS_TOTAL_BYTES: 1000 }, 100)).resolves.toBeUndefined();
  });

  test("throws 413 QUOTA_EXCEEDED when usage + additional would exceed the limit", async () => {
    await seedFileRow(900);
    __resetUploadsCacheForTests();
    try {
      await assertWithinTotalQuota(db, { UPLOADS_TOTAL_BYTES: 1000 }, 200);
      expect.unreachable("should have thrown");
    }
    catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.statusCode).toBe(413);
      expect(e.code).toBe("QUOTA_EXCEEDED");
      expect(e.message).toMatch(/Upload quota exceeded/);
    }
  });
});
