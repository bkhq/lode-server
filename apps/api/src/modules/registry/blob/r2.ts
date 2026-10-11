import type { FixedLengthStream as FixedLengthStreamClass, R2Bucket } from "@cloudflare/workers-types";
import type { BlobStore } from "./types";
import { assertBlobKey, assertBlobPrefix } from "./key";
import { BlobDigestMismatchError, BlobPutError } from "./types";

type Body = ReadableStream<Uint8Array>;

/**
 * R2 store for Workers, built on the calls measured in ../spike/README.md.
 * Bodies go to R2 as streams and come back as streams; the Worker neither
 * buffers nor hashes them. R2 verifies the declared SHA-256 of a `put` and
 * stores nothing when it does not match.
 *
 * R2 does not say why it rejected an upload in a form that can be relied on
 * (the message and code differ between the simulator and production), so a
 * rejection surfaces as a plain {@link BlobPutError}. The one case reported
 * as {@link BlobDigestMismatchError} is a length the driver counted itself.
 */
export function createR2BlobStore(bucket: R2Bucket): BlobStore {
  return {
    async put(key, body, opts) {
      assertBlobKey(key);
      await upload(`put ${key}`, body, opts.size, stream => bucket.put(key, stream as never, { sha256: opts.sha256 }));
    },

    async get(key) {
      assertBlobKey(key);
      const object = await bucket.get(key);
      if (!object) {
        return undefined;
      }
      return { body: object.body as unknown as Body, size: object.size };
    },

    async delete(key) {
      assertBlobKey(key);
      await bucket.delete(key);
    },

    async deletePrefix(prefix) {
      assertBlobPrefix(prefix);
      let cursor: string | undefined;
      do {
        // A page holds at most 1000 keys, which is also the most one delete
        // call takes.
        const page = await bucket.list(cursor ? { prefix, cursor } : { prefix });
        if (page.objects.length > 0) {
          await bucket.delete(page.objects.map(object => object.key));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },

    async createMultipart(key) {
      assertBlobKey(key);
      const { uploadId } = await bucket.createMultipartUpload(key);
      return { uploadId };
    },

    async putPart(key, uploadId, partNumber, body, size) {
      assertBlobKey(key);
      const part = await upload(
        `part ${partNumber} of ${key}`,
        body,
        size,
        stream => bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, stream as never),
      );
      return { etag: part.etag };
    },

    async completeMultipart(key, uploadId, parts) {
      assertBlobKey(key);
      await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
    },

    async abortMultipart(key, uploadId) {
      assertBlobKey(key);
      await bucket.resumeMultipartUpload(key, uploadId).abort();
    },
  };
}

/**
 * Hand `body` to R2 through `send`. R2 only takes a stream whose length it
 * knows: a request body that came with `Content-Length`, which is what the
 * upload routes pass in, goes through untouched. Any other stream is refused
 * with a `TypeError` before a byte of it is read, and is then sent again
 * through a `FixedLengthStream` of the declared size.
 */
async function upload<T>(what: string, body: Body, size: number, send: (body: Body) => Promise<T>): Promise<T> {
  try {
    return await send(body);
  }
  catch (err) {
    // Locked or disturbed means R2 did start reading: a real failure.
    if (!(err instanceof TypeError) || body.locked) {
      throw new BlobPutError(`R2 rejected ${what}`, { cause: err });
    }
  }

  const { FixedLengthStream } = globalThis as unknown as { FixedLengthStream: typeof FixedLengthStreamClass };
  const fixed = new FixedLengthStream(size);
  let seen = 0;
  let ended = false;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      ended = true;
    },
  });
  // A failure of the pipe errors `fixed.readable`, so `send` reports it.
  const piped = body.pipeThrough(counter).pipeTo(fixed.writable as unknown as WritableStream<Uint8Array>).catch(() => {});
  try {
    return await send(fixed.readable as unknown as Body);
  }
  catch (err) {
    await piped;
    if (seen > size || (ended && seen < size)) {
      throw new BlobDigestMismatchError(`Body of ${what} is not the declared ${size} bytes`, { cause: err });
    }
    throw new BlobPutError(`R2 rejected ${what}`, { cause: err });
  }
}
