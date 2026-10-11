import type { BlobStore } from "./types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetBlobStoresForTests, getActiveBlobStore, registerBlobStore } from "./registry";
import { bytesOf, readAll, sha256Hex, streamOf } from "./testing";

let root: string;

beforeEach(() => {
  __resetBlobStoresForTests();
  root = mkdtempSync(join(tmpdir(), "blob-registry-"));
});

afterEach(() => {
  __resetBlobStoresForTests();
  rmSync(root, { recursive: true, force: true });
});

const fakeStore = {} as BlobStore;

describe("blob store registry", () => {
  test("local: created lazily from REGISTRY_BLOB_LOCAL_ROOT, once", async () => {
    const config = { REGISTRY_BLOB_DRIVER: "local", REGISTRY_BLOB_LOCAL_ROOT: join(root, "blobs") };
    const store = getActiveBlobStore(config);
    expect(getActiveBlobStore(config)).toBe(store);

    const bytes = bytesOf(100);
    await store.put("pkg/a", streamOf(bytes), { size: bytes.length, sha256: sha256Hex(bytes) });
    expect(await readAll((await store.get("pkg/a"))!.body)).toEqual(bytes);
    expect(existsSync(join(root, "blobs"))).toBe(true);
  });

  test("a registered store wins over the lazy local one", () => {
    registerBlobStore("local", fakeStore);
    expect(getActiveBlobStore({ REGISTRY_BLOB_DRIVER: "local", REGISTRY_BLOB_LOCAL_ROOT: root })).toBe(fakeStore);
  });

  test("r2: the registered bucket store", () => {
    registerBlobStore("r2", fakeStore);
    expect(getActiveBlobStore({ REGISTRY_BLOB_DRIVER: "r2", REGISTRY_BLOB_LOCAL_ROOT: root })).toBe(fakeStore);
  });

  test("r2 without a registered bucket is a clear error", () => {
    expect(() => getActiveBlobStore({ REGISTRY_BLOB_DRIVER: "r2", REGISTRY_BLOB_LOCAL_ROOT: root }))
      .toThrow("REGISTRY_BLOB_DRIVER=r2 needs the PACKAGES R2 bucket binding");
  });

  test("an unknown driver name lists what is registered", () => {
    registerBlobStore("r2", fakeStore);
    expect(() => getActiveBlobStore({ REGISTRY_BLOB_DRIVER: "s3", REGISTRY_BLOB_LOCAL_ROOT: root }))
      .toThrow("Unknown registry blob driver: 's3'. Known: local, r2.");
  });

  test("reset forgets registered and lazily created stores", () => {
    registerBlobStore("r2", fakeStore);
    const config = { REGISTRY_BLOB_DRIVER: "local", REGISTRY_BLOB_LOCAL_ROOT: root };
    const store = getActiveBlobStore(config);
    __resetBlobStoresForTests();
    expect(getActiveBlobStore(config)).not.toBe(store);
    expect(() => getActiveBlobStore({ ...config, REGISTRY_BLOB_DRIVER: "r2" })).toThrow();
  });
});
