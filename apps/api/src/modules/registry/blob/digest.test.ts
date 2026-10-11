import type { BlobStore } from "./types";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sha256OfBlob } from "./digest";
import { bytesOf, sha256Hex, streamOf } from "./testing";

/** Stand-in for the workerd `crypto.DigestStream`. */
class FakeDigestStream extends WritableStream<Uint8Array> {
  static used = 0;
  readonly digest: Promise<ArrayBuffer>;

  constructor(algorithm: string) {
    expect(algorithm).toBe("SHA-256");
    FakeDigestStream.used++;
    const hash = createHash("sha256");
    const { promise, resolve } = Promise.withResolvers<ArrayBuffer>();
    super({
      write(chunk) {
        hash.update(chunk);
      },
      close() {
        resolve(new Uint8Array(hash.digest()).buffer);
      },
    });
    this.digest = promise;
  }
}

const cryptoGlobals = crypto as unknown as { DigestStream?: unknown };

afterEach(() => {
  delete cryptoGlobals.DigestStream;
});

test("sha256OfBlob pipes into crypto.DigestStream where the runtime has one", async () => {
  const bytes = bytesOf(70_000);
  const store = {
    get: async (key: string) => key === "pkg/a" ? { body: streamOf(bytes), size: bytes.length } : undefined,
  } as BlobStore;
  cryptoGlobals.DigestStream = FakeDigestStream;

  expect(await sha256OfBlob(store, "pkg/a")).toBe(sha256Hex(bytes));
  expect(FakeDigestStream.used).toBe(1);
  expect(await sha256OfBlob(store, "pkg/missing")).toBeUndefined();
});
