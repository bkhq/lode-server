import type { R2Bucket } from "@cloudflare/workers-types";
import type { BlobStore } from "./types";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sha256OfBlob } from "./digest";
import { createR2BlobStore } from "./r2";
import { bytesOf, concat, readAll, sha256Hex, streamOf } from "./testing";
import { BlobDigestMismatchError, BlobPutError } from "./types";

type Body = ReadableStream<Uint8Array>;

/**
 * Streams R2 would accept: a request body with Content-Length, or the
 * readable half of a FixedLengthStream. Anything else has no known length.
 */
const lengthKnown = new WeakSet<Body>();

function requestBody(bytes: Uint8Array): Body {
  const body = streamOf(bytes);
  lengthKnown.add(body);
  return body;
}

/** Stand-in for the workerd global: passes bytes through, enforcing the length. */
class FakeFixedLengthStream {
  readonly readable: Body;
  readonly writable: WritableStream<Uint8Array>;

  constructor(expected: number) {
    let seen = 0;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > expected) {
          throw new TypeError("Attempt to write too many bytes through a FixedLengthStream.");
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (seen < expected) {
          throw new TypeError("FixedLengthStream did not see all expected bytes before close().");
        }
      },
    });
    this.readable = readable;
    this.writable = writable;
    lengthKnown.add(readable);
  }
}

interface FakeUpload {
  key: string;
  parts: Map<number, { etag: string; bytes: Uint8Array }>;
}

/** The R2 calls the driver uses, with the behaviour the spike measured. */
class FakeBucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploads = new Map<string, FakeUpload>();
  readonly calls: string[] = [];
  #nextId = 1;

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }

  async #receive(body: Body): Promise<Uint8Array> {
    if (!lengthKnown.has(body)) {
      // Thrown before any byte is read, as on workerd.
      throw new TypeError("Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)");
    }
    return await readAll(body);
  }

  async put(key: string, body: Body, options: { sha256: string }): Promise<object> {
    this.calls.push(`put ${key}`);
    const bytes = await this.#receive(body);
    if (sha256Hex(bytes) !== options.sha256) {
      throw new Error("put: The SHA-256 checksum you specified did not match what we received.");
    }
    this.objects.set(key, bytes);
    return {};
  }

  async get(key: string): Promise<{ body: Body; size: number } | null> {
    const bytes = this.objects.get(key);
    return bytes
      ? {
          body: streamOf(bytes),
          size: bytes.length,
        }
      : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    this.calls.push(`delete ${[keys].flat().join(",")}`);
    for (const key of [keys].flat()) {
      this.objects.delete(key);
    }
  }

  /** Pages of two, so the driver has to follow the cursor (the last key seen). */
  async list(options: { prefix: string; cursor?: string }) {
    const keys = [
      ...this.objects.keys(),
    ]
      .filter(key => key.startsWith(options.prefix) && key > (options.cursor ?? ""))
      .sort();
    const page = keys.slice(0, 2);
    const truncated = keys.length > 2;
    return {
      objects: page.map(key => ({ key })),
      truncated,
      ...(truncated
        ? { cursor: page[1] }
        : {}),
    };
  }

  async createMultipartUpload(key: string) {
    const uploadId = `upload-${this.#nextId++}`;
    this.uploads.set(uploadId, {
      key,
      parts: new Map(),
    });
    return { key, uploadId };
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const find = (): FakeUpload => {
      const upload = this.uploads.get(uploadId);
      if (!upload || upload.key !== key) {
        throw new Error("The specified multipart upload does not exist.");
      }
      return upload;
    };
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, body: Body) => {
        const upload = find();
        const bytes = await this.#receive(body);
        const etag = `etag-${sha256Hex(bytes).slice(0, 12)}`;
        upload.parts.set(partNumber, { etag, bytes });
        return { partNumber, etag };
      },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        const upload = find();
        const chunks = parts.map((part) => {
          const stored = upload.parts.get(part.partNumber);
          if (!stored || stored.etag !== part.etag) {
            throw new Error("One or more of the specified parts could not be found.");
          }
          return stored.bytes;
        });
        this.objects.set(key, concat(...chunks));
        this.uploads.delete(uploadId);
        return {};
      },
      abort: async () => {
        find();
        this.uploads.delete(uploadId);
      },
    };
  }
}

const globals = globalThis as { FixedLengthStream?: unknown };
const realFixedLengthStream = globals.FixedLengthStream;

beforeAll(() => {
  globals.FixedLengthStream = FakeFixedLengthStream;
});

afterAll(() => {
  globals.FixedLengthStream = realFixedLengthStream;
});

let bucket: FakeBucket;
let store: BlobStore;

beforeEach(() => {
  bucket = new FakeBucket();
  store = createR2BlobStore(bucket.asBucket());
});

describe("r2 blob store: put / get / delete", () => {
  test("round trip on the plain path", async () => {
    const bytes = bytesOf(10_500);
    await store.put("pkg/1/2/tool.tar.gz", requestBody(bytes), {
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });

    const object = await store.get("pkg/1/2/tool.tar.gz");
    expect(object?.size).toBe(bytes.length);
    expect(await readAll(object!.body)).toEqual(bytes);
    // The length-known stream went to R2 as it was: one call, no retry.
    expect(bucket.calls).toEqual(["put pkg/1/2/tool.tar.gz"]);
  });

  test("get of a missing key is undefined", async () => {
    expect(await store.get("pkg/missing")).toBeUndefined();
  });

  test("a rejected put is a BlobPutError and leaves no object", async () => {
    const bytes = bytesOf(4000);
    const attempt = store.put("pkg/a", requestBody(bytes), {
      size: bytes.length,
      sha256: sha256Hex(bytesOf(4000, 9)),
    });
    await expect(attempt).rejects.toBeInstanceOf(BlobPutError);
    // R2 does not say why it rejected, so the driver does not claim to know.
    await expect(attempt).rejects.not.toBeInstanceOf(BlobDigestMismatchError);
    expect(bucket.objects.size).toBe(0);
  });

  test("a stream of unknown length goes through FixedLengthStream", async () => {
    const bytes = bytesOf(10_500);
    await store.put("pkg/a", streamOf(bytes), {
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
    expect(bucket.objects.get("pkg/a")).toEqual(bytes);
  });

  test("unknown length, wrong digest: BlobPutError, nothing stored", async () => {
    const bytes = bytesOf(4000);
    const attempt = store.put("pkg/a", streamOf(bytes), {
      size: bytes.length,
      sha256: sha256Hex(bytesOf(4000, 9)),
    });
    await expect(attempt).rejects.toBeInstanceOf(BlobPutError);
    await expect(attempt).rejects.not.toBeInstanceOf(BlobDigestMismatchError);
    expect(bucket.objects.size).toBe(0);
  });

  test.each([
    ["shorter", 4001],
    ["longer", 3999],
  ])("unknown length, body %s than declared: size mismatch", async (_label, size) => {
    const bytes = bytesOf(4000);
    await expect(store.put("pkg/a", streamOf(bytes), {
      size,
      sha256: sha256Hex(bytes),
    }))
      .rejects
      .toBeInstanceOf(BlobDigestMismatchError);
    expect(bucket.objects.size).toBe(0);
  });

  test("unknown length, body that errors: BlobPutError, not a mismatch", async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error("client went away"));
          return;
        }
        sent = true;
        controller.enqueue(bytesOf(10));
      },
    });
    const attempt = store.put("pkg/a", body, {
      size: 100,
      sha256: sha256Hex(bytesOf(100)),
    });
    await expect(attempt).rejects.toBeInstanceOf(BlobPutError);
    await expect(attempt).rejects.not.toBeInstanceOf(BlobDigestMismatchError);
    expect(bucket.objects.size).toBe(0);
  });

  test("delete removes the object and tolerates a missing key", async () => {
    const bytes = bytesOf(10);
    await store.put("pkg/a", requestBody(bytes), {
      size: 10,
      sha256: sha256Hex(bytes),
    });
    await store.delete("pkg/a");
    await store.delete("pkg/a");
    expect(await store.get("pkg/a")).toBeUndefined();
  });

  test("deletePrefix follows the listing cursor and removes only the prefix", async () => {
    for (const key of [
      "pkg/1/2/a",
      "pkg/1/2/b",
      "pkg/1/2/c",
      "pkg/1/2/sub/d",
      "pkg/1/2/sub/e",
      "pkg/1/20/f",
      "pkg/1/3/g",
    ]) {
      bucket.objects.set(key, bytesOf(1));
    }
    await store.deletePrefix("pkg/1/2/");
    expect([
      ...bucket.objects.keys(),
    ].sort()).toEqual(["pkg/1/20/f", "pkg/1/3/g"]);
    await store.deletePrefix("pkg/none/");
  });

  test("invalid keys and prefixes never reach the bucket", async () => {
    const bytes = bytesOf(10);
    bucket.objects.set("pkg/a", bytes);
    await expect(store.put("../a", requestBody(bytes), {
      size: 10,
      sha256: sha256Hex(bytes),
    })).rejects.toThrow("Invalid blob key");
    await expect(store.get("/pkg/a")).rejects.toThrow("Invalid blob key");
    await expect(store.delete("pkg//a")).rejects.toThrow("Invalid blob key");
    await expect(store.deletePrefix("")).rejects.toThrow("Invalid blob key");
    expect(bucket.calls).toEqual([]);
    expect(bucket.objects.size).toBe(1);
  });
});

describe("r2 blob store: multipart", () => {
  const key = "pkg/1/2/big.bin";

  test("three parts, one of them uploaded twice", async () => {
    const [one, staleTwo, two, three] = [
      bytesOf(5000, 1),
      bytesOf(5000, 2),
      bytesOf(5000, 3),
      bytesOf(1200, 4),
    ];
    const { uploadId } = await store.createMultipart(key);

    const first = await store.putPart(key, uploadId, 1, requestBody(one), one.length);
    const stale = await store.putPart(key, uploadId, 2, requestBody(staleTwo), staleTwo.length);
    // Unknown length: the part takes the FixedLengthStream route.
    const third = await store.putPart(key, uploadId, 3, streamOf(three), three.length);
    const second = await store.putPart(key, uploadId, 2, requestBody(two), two.length);
    expect(second.etag).not.toBe(stale.etag);

    await store.completeMultipart(key, uploadId, [
      { partNumber: 1, etag: first.etag },
      { partNumber: 2, etag: second.etag },
      { partNumber: 3, etag: third.etag },
    ]);

    const expected = concat(one, two, three);
    expect(bucket.objects.get(key)).toEqual(expected);
    expect(await sha256OfBlob(store, key)).toBe(sha256Hex(expected));
    expect(bucket.uploads.size).toBe(0);
  });

  test("a part of unknown length that is shorter than declared is a size mismatch", async () => {
    const { uploadId } = await store.createMultipart(key);
    await expect(store.putPart(key, uploadId, 1, streamOf(bytesOf(100)), 101)).rejects.toBeInstanceOf(BlobDigestMismatchError);
    expect(bucket.uploads.get(uploadId)?.parts.size).toBe(0);
  });

  test("a rejected part is a BlobPutError", async () => {
    await expect(store.putPart(key, "upload-unknown", 1, requestBody(bytesOf(1)), 1)).rejects.toBeInstanceOf(BlobPutError);
  });

  test("abort cleans up", async () => {
    const { uploadId } = await store.createMultipart(key);
    await store.putPart(key, uploadId, 1, requestBody(bytesOf(100)), 100);
    await store.abortMultipart(key, uploadId);
    expect(bucket.uploads.size).toBe(0);
    expect(bucket.objects.size).toBe(0);
  });
});
