import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { uploadAndReference } from "@/modules/file/file.service";
import { fileReferences, files } from "@/modules/file/schema";
import { __setLocalDriverRootForTests } from "@/modules/file/storage/local";
import { __resetDriverRegistryForTests, setActiveDriver } from "@/modules/file/storage/registry";
import {
  createComment,
  deleteComment,
  getCommentById,
  listComments,
} from "@/modules/item/comment.service";
import { createItem } from "@/modules/item/item.service";
import { itemComments } from "@/modules/item/schema";

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
  const dir = resolve(tmpdir(), `test-item-comment-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
  // deleteComment now releases comment attachment references via the file
  // service, which needs an active storage driver.
  __resetDriverRegistryForTests();
  __setLocalDriverRootForTests(resolve(dir, "blobs"));
  setActiveDriver("local");
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

async function makeItem() {
  const userId = await seedUser(`u-${nanoid()}`);
  const item = await createItem(db, {
    type: "issue",
    title: "Carrier item",
    status: "open",
    creatorId: userId,
  });
  return { userId, item };
}

describe("createComment", () => {
  test("inserts a top-level comment", async () => {
    const { userId, item } = await makeItem();
    const c = await createComment(db, {
      itemId: item.id,
      authorId: userId,
      content: "first",
    });
    expect(c.id).toHaveLength(8);
    expect(c.itemId).toBe(item.id);
    expect(c.authorId).toBe(userId);
    expect(c.replyToId).toBeNull();
    expect(c.isInternal).toBe(false);
  });

  test("inserts an internal comment when isInternal=true", async () => {
    const { userId, item } = await makeItem();
    const c = await createComment(db, {
      itemId: item.id,
      authorId: userId,
      content: "note",
      isInternal: true,
    });
    expect(c.isInternal).toBe(true);
  });

  test("threads a reply when replyToId is valid + same item", async () => {
    const { userId, item } = await makeItem();
    const parent = await createComment(db, { itemId: item.id, authorId: userId, content: "p" });
    const child = await createComment(db, {
      itemId: item.id,
      authorId: userId,
      content: "c",
      replyToId: parent.id,
    });
    expect(child.replyToId).toBe(parent.id);
  });

  test("rejects an unknown replyToId", async () => {
    const { userId, item } = await makeItem();
    await expect(
      createComment(db, { itemId: item.id, authorId: userId, content: "c", replyToId: "missing-" }),
    ).rejects.toThrow(/reply target.*not found/i);
  });

  test("rejects a replyToId from a different item", async () => {
    const { userId, item } = await makeItem();
    const { item: other } = await makeItem();
    const otherParent = await createComment(db, { itemId: other.id, authorId: userId, content: "elsewhere" });

    await expect(
      createComment(db, { itemId: item.id, authorId: userId, content: "c", replyToId: otherParent.id }),
    ).rejects.toThrow(/different item/i);
  });

  test("forces isInternal=true when replying to an internal parent", async () => {
    const { userId, item } = await makeItem();
    const parent = await createComment(db, {
      itemId: item.id,
      authorId: userId,
      content: "internal parent",
      isInternal: true,
    });
    const child = await createComment(db, {
      itemId: item.id,
      authorId: userId,
      content: "reply default",
      replyToId: parent.id,
      // isInternal omitted — service should coerce to true so the thread
      // doesn't leak across the visibility boundary.
    });
    expect(child.isInternal).toBe(true);
  });

  test("rejects comments on missing or soft-deleted items", async () => {
    await expect(
      createComment(db, { itemId: "missing-", authorId: "anyone-", content: "c" }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("listComments", () => {
  test("includeInternal=false hides internal rows", async () => {
    const { userId, item } = await makeItem();
    await createComment(db, { itemId: item.id, authorId: userId, content: "pub" });
    await createComment(db, { itemId: item.id, authorId: userId, content: "priv", isInternal: true });

    const seenByViewer = await listComments(db, item.id, { includeInternal: false });
    expect(seenByViewer.map(r => r.content)).toEqual(["pub"]);

    const seenByOwner = await listComments(db, item.id, { includeInternal: true });
    expect(seenByOwner.map(r => r.content).sort()).toEqual(["priv", "pub"]);
  });

  test("orders by createdAt ASC, id ASC so threads read top-down", async () => {
    const { userId, item } = await makeItem();
    const first = await createComment(db, { itemId: item.id, authorId: userId, content: "first" });
    // Comment ids are random 8-char nanoids (not time-ordered), so when
    // two rows share a ms the id-ASC tiebreaker is non-deterministic. A
    // 2 ms gap guarantees `createdAt` itself drives the order, matching
    // the contract this test pins down.
    await Bun.sleep(2);
    const second = await createComment(db, { itemId: item.id, authorId: userId, content: "second" });

    const list = await listComments(db, item.id, { includeInternal: true });
    expect(list.map(r => r.id)).toEqual([first.id, second.id]);
  });
});

describe("deleteComment", () => {
  test("hard deletes the row and sets reply_to_id=NULL on replies", async () => {
    const { userId, item } = await makeItem();
    const parent = await createComment(db, { itemId: item.id, authorId: userId, content: "p" });
    const child = await createComment(db, { itemId: item.id, authorId: userId, content: "c", replyToId: parent.id });

    await deleteComment(db, parent.id);

    expect(await getCommentById(db, item.id, parent.id)).toBeUndefined();
    const childRow = await db.select().from(itemComments).where(eq(itemComments.id, child.id)).get();
    expect(childRow?.replyToId).toBeNull();
    expect(childRow?.content).toBe("c");
  });

  test("releases the comment's attachment references synchronously (no reliance on the orphan sweep)", async () => {
    const { userId, item } = await makeItem();
    const comment = await createComment(db, { itemId: item.id, authorId: userId, content: "with attachment" });

    const { reference, file } = await uploadAndReference(
      db,
      { MAX_UPLOAD_BYTES: 10 * 1024 * 1024, MAX_ATTACHMENTS_PER_RESOURCE: 20, UPLOADS_TOTAL_BYTES: 0 },
      {
        file: new File(["blob-bytes"], "note.txt", { type: "text/plain" }),
        ownerType: "item_comment_attachment",
        ownerId: comment.id,
        uploadedBy: userId,
      },
    );
    // Sanity: the reference exists and the blob is referenced once.
    expect(await db.select().from(fileReferences).where(eq(fileReferences.id, reference.id)).get()).toBeDefined();
    expect((await db.select().from(files).where(eq(files.id, file.id)).get())?.refCount).toBe(1);

    await deleteComment(db, comment.id);

    // The reference row is gone — without depending on any background sweep.
    const refsAfter = await db
      .select()
      .from(fileReferences)
      .where(and(eq(fileReferences.ownerType, "item_comment_attachment"), eq(fileReferences.ownerId, comment.id)))
      .all();
    expect(refsAfter).toEqual([]);
    // ref_count decremented to 0 so the existing unreferenced-files GC can
    // reclaim the blob (async contract — blob row is intentionally left).
    expect((await db.select().from(files).where(eq(files.id, file.id)).get())?.refCount).toBe(0);
  });
});
