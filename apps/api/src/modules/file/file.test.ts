import type { FileServiceConfig } from "./file.service";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { fileReferences, files } from "@/modules/file/schema";
import { loadNamespaces } from "@/modules/policy/namespace-config";
import {
  addReference,
  buildDownloadResponse,
  getFileById,
  getReferenceById,
  listReferencesByOwner,
  releaseAllByOwner,
  releaseReference,
  totalStoredBytes,
  uploadAndReference,
} from "./file.service";
import { runFileGcOnce } from "./gc";
import {
  __resetFilePermissionHooksForTests,
  getFilePermissionHook,
  registerFilePermissionHook,
} from "./permission";
import { __setLocalDriverRootForTests } from "./storage/local";
import { __resetDriverRegistryForTests, setActiveDriver } from "./storage/registry";

// Test fixtures replace the boot-time `setGcMode` / `setPresignConfig`
// setters: each test group that needs a specific mode constructs the
// narrow config object and threads it through, mirroring how route
// handlers pass `c.get("config")` in production.
const syncConfig: FileServiceConfig = {
  FILE_GC_MODE: "sync",
  FILE_PRESIGN_ENABLED: false,
  FILE_PRESIGN_TTL_SECONDS: 300,
};
const asyncConfig: FileServiceConfig = {
  FILE_GC_MODE: "async",
  FILE_PRESIGN_ENABLED: false,
  FILE_PRESIGN_TTL_SECONDS: 300,
};
const presignOnConfig: FileServiceConfig = {
  FILE_GC_MODE: "sync",
  FILE_PRESIGN_ENABLED: true,
  FILE_PRESIGN_TTL_SECONDS: 60,
};

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;
let storageRoot: string;

async function seedUser(name = "Alice") {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: `${name.toLowerCase()}-${id}`,
    name,
    email: `${id}@test.com`,
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  return id;
}

const testConfig = {
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
  MAX_ATTACHMENTS_PER_RESOURCE: 20,
  UPLOADS_TOTAL_BYTES: 0,
};

function pngFile(name: string, body = "fakepng"): File {
  // The mime-sniffer accepts text/* with no magic bytes, so we lean on
  // a text/plain payload to avoid having to forge a real PNG header.
  return new File([body], name, { type: "text/plain" });
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-file-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  storageRoot = resolve(dir, "blobs");
  db = await createDb(dbPath);
  __resetDriverRegistryForTests();
  __resetFilePermissionHooksForTests();
  __setLocalDriverRootForTests(storageRoot);
  setActiveDriver("local");
  // Other test files (zanzibar / policy.service tests) mutate the global
  // namespace registry without restoring defaults. Re-seed the defaults
  // here so the `item` namespace is available for the integration test.
  loadNamespaces();
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

describe("uploadAndReference", () => {
  test("creates a files row + a file_references row on first upload", async () => {
    const userId = await seedUser();
    const result = await uploadAndReference(db, testConfig, {
      file: pngFile("hello.txt", "hello world"),
      ownerType: "item_attachment",
      ownerId: "item-xyz",
      uploadedBy: userId,
    });
    expect(result.deduped).toBe(false);
    expect(result.file.id).toHaveLength(26); // ULID
    expect(result.file.sha256).toHaveLength(64);
    expect(result.file.refCount).toBe(1);
    expect(result.reference.fileId).toBe(result.file.id);
    expect(result.reference.ownerType).toBe("item_attachment");
    expect(result.reference.ownerId).toBe("item-xyz");
    expect(result.reference.filename).toBe("hello.txt");
    // Blob landed on disk at <ab>/<cd>/<sha>.
    const sha = result.file.sha256;
    const blobPath = resolve(storageRoot, sha.slice(0, 2), sha.slice(2, 4), sha);
    expect(existsSync(blobPath)).toBe(true);
  });

  test("dedupes identical content across owners — one files row, two refs", async () => {
    const userId = await seedUser();
    const first = await uploadAndReference(db, testConfig, {
      file: pngFile("same.txt", "deduped body"),
      ownerType: "item_attachment",
      ownerId: "item-a",
      uploadedBy: userId,
    });
    const second = await uploadAndReference(db, testConfig, {
      file: pngFile("renamed.txt", "deduped body"),
      ownerType: "item_attachment",
      ownerId: "item-b",
      uploadedBy: userId,
    });
    expect(second.deduped).toBe(true);
    expect(second.file.id).toBe(first.file.id);
    expect(second.file.refCount).toBe(2);
    expect(second.reference.fileId).toBe(first.file.id);
    expect(second.reference.filename).toBe("renamed.txt");

    const allFiles = await db.select().from(files).all();
    expect(allFiles).toHaveLength(1);
    expect(allFiles[0]!.refCount).toBe(2);

    const allRefs = await db.select().from(fileReferences).all();
    expect(allRefs).toHaveLength(2);
  });

  test("UNIQUE(owner_type, owner_id, file_id) rejects a duplicate reference on the same owner", async () => {
    const userId = await seedUser();
    await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "body"),
      ownerType: "item_attachment",
      ownerId: "item-x",
      uploadedBy: userId,
    });
    await expect(uploadAndReference(db, testConfig, {
      file: pngFile("a-renamed.txt", "body"),
      ownerType: "item_attachment",
      ownerId: "item-x",
      uploadedBy: userId,
    })).rejects.toThrow(/already attached/i);
  });

  test("rejects oversized files", async () => {
    const userId = await seedUser();
    const big = new File(["x".repeat(11 * 1024 * 1024)], "huge.txt", { type: "text/plain" });
    await expect(uploadAndReference(db, testConfig, {
      file: big,
      ownerType: "item_attachment",
      ownerId: "item-z",
      uploadedBy: userId,
    })).rejects.toThrow(/per-file limit/i);
  });

  test("rejects disallowed mimetypes", async () => {
    const userId = await seedUser();
    const exe = new File(["MZ\0"], "weird.exe", { type: "application/x-msdownload" });
    await expect(uploadAndReference(db, testConfig, {
      file: exe,
      ownerType: "item_attachment",
      ownerId: "item-z",
      uploadedBy: userId,
    })).rejects.toThrow(/not allowed/i);
  });
});

describe("addReference", () => {
  test("adds a second reference without re-uploading", async () => {
    const userId = await seedUser();
    const first = await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "shared body"),
      ownerType: "item_attachment",
      ownerId: "item-a",
      uploadedBy: userId,
    });
    const ref2 = await addReference(db, {
      fileId: first.file.id,
      ownerType: "item_attachment",
      ownerId: "item-b",
      filename: "copy.txt",
      createdBy: userId,
    });
    expect(ref2.fileId).toBe(first.file.id);
    const file = await getFileById(db, first.file.id);
    expect(file?.refCount).toBe(2);
  });

  test("UNIQUE catches double-reference on same owner", async () => {
    const userId = await seedUser();
    const first = await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "body"),
      ownerType: "item_attachment",
      ownerId: "item-a",
      uploadedBy: userId,
    });
    await expect(addReference(db, {
      fileId: first.file.id,
      ownerType: "item_attachment",
      ownerId: "item-a",
      createdBy: userId,
    })).rejects.toThrow(/already attached/i);
  });
});

describe("releaseReference (sync GC)", () => {
  test("releasing the last reference deletes both the blob and the files row", async () => {
    const userId = await seedUser();
    const first = await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "to-delete"),
      ownerType: "item_attachment",
      ownerId: "item-a",
      uploadedBy: userId,
    });
    const blobPath = resolve(storageRoot, first.file.sha256.slice(0, 2), first.file.sha256.slice(2, 4), first.file.sha256);
    expect(existsSync(blobPath)).toBe(true);

    await releaseReference(db, syncConfig, { referenceId: first.reference.id });

    expect(await getFileById(db, first.file.id)).toBeUndefined();
    expect(existsSync(blobPath)).toBe(false);
  });

  test("releasing one of two references keeps the blob alive", async () => {
    const userId = await seedUser();
    const a = await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "shared"),
      ownerType: "item_attachment",
      ownerId: "item-a",
      uploadedBy: userId,
    });
    const b = await addReference(db, {
      fileId: a.file.id,
      ownerType: "item_attachment",
      ownerId: "item-b",
      createdBy: userId,
    });
    expect((await getFileById(db, a.file.id))?.refCount).toBe(2);

    await releaseReference(db, syncConfig, { referenceId: a.reference.id });

    const file = await getFileById(db, a.file.id);
    expect(file?.refCount).toBe(1);
    // Blob still on disk.
    const blobPath = resolve(storageRoot, a.file.sha256.slice(0, 2), a.file.sha256.slice(2, 4), a.file.sha256);
    expect(existsSync(blobPath)).toBe(true);
    // Releasing the second reference removes the blob.
    await releaseReference(db, syncConfig, { referenceId: b.id });
    expect(await getFileById(db, a.file.id)).toBeUndefined();
    expect(existsSync(blobPath)).toBe(false);
  });

  test("release of an unknown reference is a no-op", async () => {
    await releaseReference(db, syncConfig, { referenceId: "missing-ref" });
  });
});

describe("releaseAllByOwner", () => {
  test("drops every reference for an owner; blobs reclaimed when refcount drains", async () => {
    const userId = await seedUser();
    const a = await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "owner-1 only"),
      ownerType: "item_attachment",
      ownerId: "owner-1",
      uploadedBy: userId,
    });
    const b = await uploadAndReference(db, testConfig, {
      file: pngFile("b.txt", "shared"),
      ownerType: "item_attachment",
      ownerId: "owner-1",
      uploadedBy: userId,
    });
    // 'shared' content also referenced from owner-2; that ref keeps the blob alive.
    await addReference(db, {
      fileId: b.file.id,
      ownerType: "item_attachment",
      ownerId: "owner-2",
      createdBy: userId,
    });

    await releaseAllByOwner(db, syncConfig, "item_attachment", "owner-1");

    // First blob (only owner-1 referenced) is gone.
    expect(await getFileById(db, a.file.id)).toBeUndefined();
    // Second blob still alive — owner-2 holds a reference.
    expect((await getFileById(db, b.file.id))?.refCount).toBe(1);
    // owner-1 has no remaining references.
    expect(await listReferencesByOwner(db, "item_attachment", "owner-1")).toEqual([]);
  });
});

describe("async GC sweeper", () => {
  test("runFileGcOnce removes ref_count=0 rows + their blobs", async () => {
    const userId = await seedUser();
    const a = await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "lonely"),
      ownerType: "item_attachment",
      ownerId: "owner-1",
      uploadedBy: userId,
    });
    const blobPath = resolve(storageRoot, a.file.sha256.slice(0, 2), a.file.sha256.slice(2, 4), a.file.sha256);

    await releaseReference(db, asyncConfig, { referenceId: a.reference.id });

    // Async mode: blob still on disk, files row still present but ref_count=0.
    expect(existsSync(blobPath)).toBe(true);
    const before = await db.select().from(files).where(eq(files.id, a.file.id)).get();
    expect(before?.refCount).toBe(0);

    const collected = await runFileGcOnce(db);
    expect(collected).toBe(1);
    expect(existsSync(blobPath)).toBe(false);
    expect(await getFileById(db, a.file.id)).toBeUndefined();
  });
});

describe("listReferencesByOwner + getReferenceById", () => {
  test("listReferencesByOwner returns the owner's references newest-first", async () => {
    const userId = await seedUser();
    const a = await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "first"),
      ownerType: "item_attachment",
      ownerId: "item-1",
      uploadedBy: userId,
    });
    const b = await uploadAndReference(db, testConfig, {
      file: pngFile("b.txt", "second"),
      ownerType: "item_attachment",
      ownerId: "item-1",
      uploadedBy: userId,
    });
    const list = await listReferencesByOwner(db, "item_attachment", "item-1");
    expect(list.map(r => r.id)).toEqual([b.reference.id, a.reference.id]);
    expect(await getReferenceById(db, a.reference.id)).toMatchObject({ id: a.reference.id });
  });
});

describe("permission hook registry", () => {
  test("registerFilePermissionHook + getFilePermissionHook round-trip", async () => {
    const hook = {
      canRead: async () => true,
      canDelete: async () => false,
    };
    registerFilePermissionHook("test_owner", hook);
    expect(getFilePermissionHook("test_owner")).toBe(hook);
    expect(getFilePermissionHook("unknown")).toBeUndefined();
  });
});

describe("buildDownloadResponse", () => {
  test("streams body when presign is disabled (local driver)", async () => {
    const userId = await seedUser();
    const up = await uploadAndReference(db, testConfig, {
      file: pngFile("hello.txt", "stream me"),
      ownerType: "item_attachment",
      ownerId: "x",
      uploadedBy: userId,
    });
    const resp = await buildDownloadResponse(syncConfig, up.file, up.reference, { inline: false });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Disposition")).toContain("attachment");
    expect(resp.headers.get("Content-Disposition")).toContain("hello.txt");
    expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const text = await resp.text();
    expect(text).toBe("stream me");
  });

  test("forces application/octet-stream on inline downloads of script-bearing types", async () => {
    // The MIME-sniff guard at upload time already blocks SVG (its `image/`
    // claim doesn't match the text-looking sniff). Here we want to verify
    // the *download-side* inline-safety rule independently, so we hand-roll
    // a file row + reference that pretends to be SVG and assert the response
    // forces octet-stream.
    const userId = await seedUser();
    const realUpload = await uploadAndReference(db, testConfig, {
      file: pngFile("placeholder.txt", "some bytes"),
      ownerType: "item_attachment",
      ownerId: "x",
      uploadedBy: userId,
    });
    const svgFile = { ...realUpload.file, mimetype: "image/svg+xml" };
    const resp = await buildDownloadResponse(syncConfig, svgFile, realUpload.reference, { inline: true });
    expect(resp.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(resp.headers.get("Content-Disposition")).toContain("attachment");
  });

  test("302s to a signed URL when presign is enabled + driver supports it", async () => {
    // Register a fake driver with presignDownload alongside `local`, switch active.
    const fakeDriver = {
      name: "fake-presign",
      put: async () => {},
      getStream: async () => new Response("").body!,
      delete: async () => {},
      exists: async () => true,
      presignDownload: async (key: string) => `https://blob.example.com/${key}?sig=abc`,
    };
    const { registerDriver } = await import("./storage/registry");
    registerDriver(fakeDriver);
    setActiveDriver("fake-presign");

    // Hand-build a file row referencing the fake driver so we don't actually
    // upload (the fake driver's put is a no-op).
    const userId = await seedUser();
    const fileRow = {
      id: "f-1234567890abcdefghijklmnop",
      sha256: "0".repeat(64),
      size: 10,
      mimetype: "image/png",
      storageDriver: "fake-presign",
      storageKey: "00/00/x",
      refCount: 1,
      uploadedBy: userId,
    } as const;
    const refRow = {
      id: nanoid(),
      fileId: fileRow.id,
      ownerType: "item_attachment",
      ownerId: "x",
      filename: "pic.png",
      metadata: "{}",
      createdBy: userId,
      createdAt: new Date().toISOString(),
    };

    const resp = await buildDownloadResponse(presignOnConfig, fileRow, refRow, { inline: true });
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toContain("blob.example.com");
  });
});

describe("totalStoredBytes", () => {
  test("sums size across distinct files (deduped content counted once)", async () => {
    const userId = await seedUser();
    await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "one"),
      ownerType: "item_attachment",
      ownerId: "i1",
      uploadedBy: userId,
    });
    await uploadAndReference(db, testConfig, {
      file: pngFile("b.txt", "one"), // identical content
      ownerType: "item_attachment",
      ownerId: "i2",
      uploadedBy: userId,
    });
    await uploadAndReference(db, testConfig, {
      file: pngFile("c.txt", "different"),
      ownerType: "item_attachment",
      ownerId: "i3",
      uploadedBy: userId,
    });
    const total = await totalStoredBytes(db);
    // First two share a blob (3 bytes); third blob is 9 bytes.
    expect(total).toBe(3 + 9);
  });
});

describe("item_attachment permission hook integration", () => {
  test("registers via item module load and gates downloads through policy", async () => {
    // Module-load side effects only fire once per process; `beforeEach` wipes
    // the hook registry so re-trigger the registration explicitly here.
    const { registerItemAttachmentPermissionHook } = await import("@/modules/item/attachment.permission");
    registerItemAttachmentPermissionHook();
    const hook = getFilePermissionHook("item_attachment");
    expect(hook).toBeDefined();

    const userId = await seedUser();
    const stranger = await seedUser("Mallory");

    // Synthesize an item + an owner tuple so the policy `viewer` check
    // resolves via the `owner` → `editor` → `viewer` implication chain.
    const { createItem } = await import("@/modules/item/item.service");
    const item = await createItem(db, {
      type: "issue",
      title: "Carrier",
      status: "open",
      creatorId: userId,
    });
    const up = await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "guarded"),
      ownerType: "item_attachment",
      ownerId: item.id,
      uploadedBy: userId,
    });

    const owner = { id: userId, role: "user" };
    const outsider = { id: stranger, role: "user" };
    const admin = { id: stranger, role: "admin" };

    await expect(hook!.canRead(db, owner, up.reference)).resolves.toBe(true);
    await expect(hook!.canRead(db, outsider, up.reference)).resolves.toBe(false);
    await expect(hook!.canRead(db, admin, up.reference)).resolves.toBe(true);

    await expect(hook!.canDelete(db, owner, up.reference)).resolves.toBe(true);
    await expect(hook!.canDelete(db, outsider, up.reference)).resolves.toBe(false);
  });
});

describe("schema cross-checks", () => {
  test("file_references UNIQUE prevents two same-owner attachments at the SQL layer", async () => {
    const userId = await seedUser();
    const a = await uploadAndReference(db, testConfig, {
      file: pngFile("a.txt", "x"),
      ownerType: "item_attachment",
      ownerId: "i-1",
      uploadedBy: userId,
    });
    // Sanity: a second ref against the SAME file+owner via raw insert blows
    // up. Drizzle wraps the libsql error in `DrizzleQueryError`; the
    // `UNIQUE constraint failed` text lives on `cause.message`. Walk the
    // chain rather than checking the top-level message.
    try {
      await db.insert(fileReferences).values({
        id: nanoid(),
        fileId: a.file.id,
        ownerType: "item_attachment",
        ownerId: "i-1",
        filename: "dup.txt",
        metadata: "{}",
        createdBy: userId,
        createdAt: new Date().toISOString(),
      }).run();
      throw new Error("expected UNIQUE violation");
    }
    catch (err) {
      let cur: unknown = err;
      let matched = false;
      while (cur instanceof Error) {
        if (/UNIQUE/i.test(cur.message)) {
          matched = true;
          break;
        }
        cur = (cur as { cause?: unknown }).cause;
      }
      expect(matched).toBe(true);
    }
    // While we're here, make sure a known-good cross-owner insert succeeds
    // (regression guard against accidentally widening the UNIQUE).
    const ok = nanoid();
    await db.insert(fileReferences).values({
      id: ok,
      fileId: a.file.id,
      ownerType: "item_attachment",
      ownerId: "i-2",
      filename: "ok.txt",
      metadata: "{}",
      createdBy: userId,
      createdAt: new Date().toISOString(),
    }).run();
    const row = await db.select().from(fileReferences).where(and(eq(fileReferences.id, ok))).get();
    expect(row?.id).toBe(ok);
  });
});

describe("initFileModule presign capability warning", () => {
  test("warns once when presign is enabled on a driver that cannot presign, silent otherwise", async () => {
    const { initFileModule } = await import("./index");
    const warned: unknown[] = [];
    const logger = {
      warn: (...args: unknown[]) => {
        warned.push(args);
      },
    };

    // The local driver's setup() needs a root it can create.
    const root = resolve(tmpdir(), `test-file-presign-${Date.now()}`);
    // initFileModule takes the full Config; only the file keys matter here.
    const base = { ...testConfig, FILE_STORAGE_DRIVER: "local", FILE_STORAGE_LOCAL_ROOT: root };

    await initFileModule({ ...base, FILE_PRESIGN_ENABLED: true } as unknown as Config, logger);
    expect(warned).toHaveLength(1);
    expect(String((warned[0] as unknown[])[1])).toMatch(/cannot presign/);

    await initFileModule({ ...base, FILE_PRESIGN_ENABLED: false } as unknown as Config, logger);
    expect(warned).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });
});
