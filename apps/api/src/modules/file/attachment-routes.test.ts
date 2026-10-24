import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { errorHandler } from "@/shared/middleware/error-handler";
import { getOwnedReference, readUploadedFile } from "./attachment-routes";
import { fileReferences, files } from "./schema";

let dir: string;
let db: AppDatabase;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "attachment-routes-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("readUploadedFile", () => {
  function upload(init: RequestInit) {
    const app = new Hono<AppEnv>();
    app.post("/", async (c) => {
      c.set("config", { MAX_UPLOAD_BYTES: 16 } as Config);
      const file = await readUploadedFile(c);
      return c.json({ name: file.name, size: file.size });
    });
    app.onError(errorHandler);
    return app.request("/", { method: "POST", ...init });
  }

  test("returns the multipart `file` field", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "a.txt", { type: "text/plain" }));
    const res = await upload({ body: form });
    expect(await res.json()).toEqual({ name: "a.txt", size: 5 });
  });

  test("rejects a body over the upload limit before parsing it", async () => {
    const res = await upload({
      body: "x".repeat(64),
      headers: { "content-length": "64" },
    });
    expect(res.status).toBe(413);
  });

  test("rejects a form without a file", async () => {
    const form = new FormData();
    form.set("file", "not a file");
    const res = await upload({ body: form });
    expect(res.status).toBe(400);
  });
});

describe("getOwnedReference", () => {
  beforeEach(async () => {
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u1",
      oauthSub: "s1",
      username: "u1",
      name: "u1",
      email: "u1@t.io",
      role: "user",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    await db.insert(files).values({
      id: "f1",
      sha256: "00",
      size: 1,
      mimetype: "text/plain",
      storageDriver: "local",
      storageKey: "k",
      refCount: 1,
      uploadedBy: "u1",
    }).run();
    await db.insert(fileReferences).values({
      id: "r1",
      fileId: "f1",
      ownerType: "item_attachment",
      ownerId: "item1",
      filename: "a.txt",
      createdBy: "u1",
    }).run();
  });

  test("returns a reference held by the owner", async () => {
    expect((await getOwnedReference(db, "r1", "item_attachment", "item1")).fileId).toBe("f1");
  });

  test("treats another owner's or another kind's reference as missing", async () => {
    for (const [type, id] of [
      ["item_attachment", "item2"],
      ["item_comment_attachment", "item1"],
    ] as const)
      await expect(getOwnedReference(db, "r1", type, id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getOwnedReference(db, "nope", "item_attachment", "item1")).rejects.toMatchObject({ statusCode: 404 });
  });
});
