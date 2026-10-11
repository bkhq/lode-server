import type { BlobStore } from "./types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256OfBlob } from "./digest";
import { createLocalBlobStore } from "./local";
import { bytesOf, concat, readAll, sha256Hex, streamOf } from "./testing";
import { BlobDigestMismatchError, BlobMultipartError, BlobPutError } from "./types";

let root: string;
let store: BlobStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blob-local-"));
  store = createLocalBlobStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every regular file under the store root, relative to it. */
function filesUnderRoot(): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
}

async function put(key: string, bytes: Uint8Array): Promise<void> {
  await store.put(key, streamOf(bytes), { size: bytes.length, sha256: sha256Hex(bytes) });
}

describe("local blob store: put / get / delete", () => {
  test("round trip", async () => {
    const bytes = bytesOf(10_500);
    await put("pkg/1/2/tool.tar.gz", bytes);

    const object = await store.get("pkg/1/2/tool.tar.gz");
    expect(object?.size).toBe(bytes.length);
    expect(await readAll(object!.body)).toEqual(bytes);
    expect(filesUnderRoot()).toHaveLength(1);
  });

  test("get of a missing key or of a key prefix is undefined", async () => {
    await put("pkg/1/2/tool.tar.gz", bytesOf(10));
    expect(await store.get("pkg/1/2/other")).toBeUndefined();
    expect(await store.get("pkg/1/2")).toBeUndefined();
  });

  test("put replaces an existing object", async () => {
    await put("pkg/a", bytesOf(100, 1));
    const next = bytesOf(50, 2);
    await put("pkg/a", next);
    expect(await readAll((await store.get("pkg/a"))!.body)).toEqual(next);
  });

  test("digest mismatch leaves no object", async () => {
    const bytes = bytesOf(4000);
    const attempt = store.put("pkg/a", streamOf(bytes), { size: bytes.length, sha256: sha256Hex(bytesOf(4000, 9)) });
    await expect(attempt).rejects.toBeInstanceOf(BlobDigestMismatchError);
    await expect(attempt).rejects.toBeInstanceOf(BlobPutError);
    expect(await store.get("pkg/a")).toBeUndefined();
    expect(filesUnderRoot()).toEqual([]);
  });

  test("a failed put keeps the object that was there before", async () => {
    const first = bytesOf(100);
    await put("pkg/a", first);
    await expect(store.put("pkg/a", streamOf(bytesOf(100, 2)), { size: 100, sha256: sha256Hex(first) }))
      .rejects
      .toBeInstanceOf(BlobDigestMismatchError);
    expect(await readAll((await store.get("pkg/a"))!.body)).toEqual(first);
  });

  test.each([["shorter", 4001], ["longer", 3999]])("size mismatch: body %s than declared", async (_label, size) => {
    const bytes = bytesOf(4000);
    await expect(store.put("pkg/a", streamOf(bytes), { size, sha256: sha256Hex(bytes) }))
      .rejects
      .toBeInstanceOf(BlobDigestMismatchError);
    expect(await store.get("pkg/a")).toBeUndefined();
    expect(filesUnderRoot()).toEqual([]);
  });

  test("a body that errors is a BlobPutError and leaves nothing", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("client went away"));
      },
    });
    const attempt = store.put("pkg/a", body, { size: 10, sha256: sha256Hex(bytesOf(10)) });
    await expect(attempt).rejects.toBeInstanceOf(BlobPutError);
    await expect(attempt).rejects.not.toBeInstanceOf(BlobDigestMismatchError);
    expect(filesUnderRoot()).toEqual([]);
  });

  test("delete removes the object and tolerates a missing key", async () => {
    await put("pkg/a", bytesOf(10));
    await store.delete("pkg/a");
    await store.delete("pkg/a");
    expect(await store.get("pkg/a")).toBeUndefined();
  });

  test("deletePrefix removes exactly the keys under the prefix", async () => {
    for (const key of ["pkg/1/2/a", "pkg/1/2/sub/b", "pkg/1/20/c", "pkg/1/3/d", "pkg/10/1/e"]) {
      await put(key, bytesOf(10));
    }

    await store.deletePrefix("pkg/1/2/");
    expect(filesUnderRoot().map(path => path.slice(path.indexOf("pkg/")))).toEqual(["pkg/1/20/c", "pkg/1/3/d", "pkg/10/1/e"]);

    // A prefix is a string prefix, not a directory name.
    await store.deletePrefix("pkg/1");
    expect(filesUnderRoot()).toEqual([]);

    await store.deletePrefix("pkg/none/");
  });

  test.each([
    "../escape",
    "pkg/../../escape",
    "/etc/passwd",
    "pkg//a",
    "pkg/./a",
    "pkg\\..\\a",
    "pkg/a\0",
    "",
    "pkg/a/",
  ])("key %p is refused", async (key) => {
    const bytes = bytesOf(10);
    await expect(store.put(key, streamOf(bytes), { size: 10, sha256: sha256Hex(bytes) })).rejects.toThrow("Invalid blob key");
    await expect(store.get(key)).rejects.toThrow("Invalid blob key");
    await expect(store.delete(key)).rejects.toThrow("Invalid blob key");
    await expect(store.createMultipart(key)).rejects.toThrow("Invalid blob key");
    expect(filesUnderRoot()).toEqual([]);
  });

  test.each(["../", "pkg/../", "/abs", "pkg\\", ""])("prefix %p is refused", async (prefix) => {
    await expect(store.deletePrefix(prefix)).rejects.toThrow("Invalid blob key");
  });
});

describe("local blob store: multipart", () => {
  const key = "pkg/1/2/big.bin";

  async function putPart(uploadId: string, partNumber: number, bytes: Uint8Array) {
    const { etag } = await store.putPart(key, uploadId, partNumber, streamOf(bytes), bytes.length);
    return { partNumber, etag };
  }

  test("three parts, one of them uploaded twice", async () => {
    const [one, staleTwo, two, three] = [bytesOf(5000, 1), bytesOf(5000, 2), bytesOf(5000, 3), bytesOf(1200, 4)];
    const { uploadId } = await store.createMultipart(key);

    const first = await putPart(uploadId, 1, one);
    const stale = await putPart(uploadId, 2, staleTwo);
    const third = await putPart(uploadId, 3, three);
    const second = await putPart(uploadId, 2, two);
    expect(second.etag).not.toBe(stale.etag);
    // The same bytes again yield the same etag.
    expect(await putPart(uploadId, 2, two)).toEqual(second);

    expect(await store.get(key)).toBeUndefined();
    await store.completeMultipart(key, uploadId, [first, second, third]);

    const expected = concat(one, two, three);
    const object = await store.get(key);
    expect(object?.size).toBe(expected.length);
    expect(await readAll(object!.body)).toEqual(expected);
    expect(await sha256OfBlob(store, key)).toBe(sha256Hex(expected));
    // Only the assembled object is left: no parts, no temp files.
    expect(filesUnderRoot()).toHaveLength(1);
  });

  test("completing with a replaced part etag fails and stores nothing", async () => {
    const { uploadId } = await store.createMultipart(key);
    const stale = await putPart(uploadId, 1, bytesOf(100, 1));
    await putPart(uploadId, 1, bytesOf(100, 2));
    await expect(store.completeMultipart(key, uploadId, [stale])).rejects.toBeInstanceOf(BlobMultipartError);
    expect(await store.get(key)).toBeUndefined();
  });

  test.each([
    ["no parts", []],
    ["parts out of order", [{ partNumber: 2, etag: "x" }, { partNumber: 1, etag: "y" }]],
    ["a part that was never uploaded", [{ partNumber: 7, etag: "x" }]],
    ["an etag that is not one", [{ partNumber: 1, etag: "../../objects/pkg" }]],
  ])("completing with %s fails", async (_label, parts) => {
    const { uploadId } = await store.createMultipart(key);
    await expect(store.completeMultipart(key, uploadId, parts)).rejects.toBeInstanceOf(BlobMultipartError);
  });

  test("a part whose length differs from the declared size is refused and not kept", async () => {
    const { uploadId } = await store.createMultipart(key);
    const good = await putPart(uploadId, 1, bytesOf(100));
    for (const size of [99, 101]) {
      await expect(store.putPart(key, uploadId, 1, streamOf(bytesOf(100, 5)), size))
        .rejects
        .toBeInstanceOf(BlobDigestMismatchError);
    }
    // The earlier upload of that part is still the valid one.
    await store.completeMultipart(key, uploadId, [good]);
    expect(await readAll((await store.get(key))!.body)).toEqual(bytesOf(100));
  });

  test("abort cleans up", async () => {
    const { uploadId } = await store.createMultipart(key);
    await putPart(uploadId, 1, bytesOf(100));
    await putPart(uploadId, 2, bytesOf(100));

    await store.abortMultipart(key, uploadId);
    expect(filesUnderRoot()).toEqual([]);
    await expect(store.putPart(key, uploadId, 3, streamOf(bytesOf(1)), 1)).rejects.toBeInstanceOf(BlobMultipartError);
    await expect(store.completeMultipart(key, uploadId, [{ partNumber: 1, etag: "x" }])).rejects.toBeInstanceOf(BlobMultipartError);
    // Aborting twice is a no-op.
    await store.abortMultipart(key, uploadId);
  });

  test("an upload id is bound to its key and cannot traverse", async () => {
    const { uploadId } = await store.createMultipart(key);
    await expect(store.putPart("pkg/other", uploadId, 1, streamOf(bytesOf(1)), 1)).rejects.toBeInstanceOf(BlobMultipartError);
    await expect(store.putPart(key, "../objects", 1, streamOf(bytesOf(1)), 1)).rejects.toBeInstanceOf(BlobMultipartError);
    await expect(store.abortMultipart(key, "..")).rejects.toBeInstanceOf(BlobMultipartError);
    await expect(store.abortMultipart("pkg/other", uploadId)).rejects.toBeInstanceOf(BlobMultipartError);
    for (const partNumber of [0, -1, 1.5, 10_001]) {
      await expect(store.putPart(key, uploadId, partNumber, streamOf(bytesOf(1)), 1)).rejects.toBeInstanceOf(BlobMultipartError);
    }
  });
});

describe("sha256OfBlob", () => {
  test("digest of a stored object", async () => {
    const bytes = bytesOf(70_000);
    await put("pkg/a", bytes);
    expect(await sha256OfBlob(store, "pkg/a")).toBe(sha256Hex(bytes));
  });

  test("undefined for a missing object", async () => {
    expect(await sha256OfBlob(store, "pkg/missing")).toBeUndefined();
  });
});
