import type { BlobStore } from "./types";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { assertBlobKey, assertBlobPrefix } from "./key";
import { BlobDigestMismatchError, BlobMultipartError, BlobPutError } from "./types";

const RE_UPLOAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const RE_ETAG = /^[0-9a-f]{64}$/;
/** Same ceiling as R2 and S3, so a part number valid here is valid there. */
const MAX_PART_NUMBER = 10_000;
/** Marker file inside an upload directory holding the key the upload is for. */
const KEY_FILE = "key";

/**
 * Local-filesystem store for Bun development and tests. Layout under `root`:
 *
 *     objects/<key>                      stored objects
 *     tmp/<uuid>                         uploads in flight
 *     multipart/<uploadId>/key           the key the upload was created for
 *     multipart/<uploadId>/<n>-<sha256>  part `n`; the digest is its etag
 *
 * Every write is two-phase (temp file, then rename), so a reader never sees
 * a partial object and a failed upload leaves the previous object in place.
 * Bodies are written chunk by chunk as they arrive; nothing is buffered.
 */
export function createLocalBlobStore(root: string): BlobStore {
  const tmpDir = join(root, "tmp");

  function objectPath(key: string): string {
    assertBlobKey(key);
    return join(root, "objects", ...key.split("/"));
  }

  async function tempPath(): Promise<string> {
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    return join(tmpDir, randomUUID());
  }

  /** Move a finished temp file to its key, replacing what is there. */
  async function publish(tmp: string, key: string): Promise<void> {
    const path = objectPath(key);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await rename(tmp, path);
    }
    catch (err) {
      await rm(tmp, { force: true });
      throw new BlobPutError(`Could not store blob at ${key}`, { cause: err });
    }
  }

  /**
   * The directory of an upload, once the id is known to be one of ours and to
   * belong to `key`. `undefined` when the upload does not exist (any more).
   */
  async function uploadDir(key: string, uploadId: string): Promise<string | undefined> {
    assertBlobKey(key);
    if (!RE_UPLOAD_ID.test(uploadId)) {
      throw new BlobMultipartError(`Invalid multipart upload id: ${JSON.stringify(uploadId)}`);
    }
    const dir = join(root, "multipart", uploadId);
    const owner = await readFile(join(dir, KEY_FILE), "utf8").catch(() => undefined);
    if (owner === undefined) {
      return undefined;
    }
    if (owner !== key) {
      throw new BlobMultipartError(`Multipart upload ${uploadId} does not belong to ${key}`);
    }
    return dir;
  }

  async function requireUploadDir(key: string, uploadId: string): Promise<string> {
    const dir = await uploadDir(key, uploadId);
    if (!dir) {
      throw new BlobMultipartError(`Unknown multipart upload: ${uploadId}`);
    }
    return dir;
  }

  return {
    async put(key, body, opts) {
      objectPath(key);
      const tmp = await tempPath();
      const sha256 = await spool(body, tmp, opts.size);
      if (sha256 !== opts.sha256.toLowerCase()) {
        await rm(tmp, { force: true });
        throw new BlobDigestMismatchError(`SHA-256 mismatch for ${key}: declared ${opts.sha256}, received ${sha256}`);
      }
      await publish(tmp, key);
    },

    async get(key) {
      const path = objectPath(key);
      const size = await fileSize(path);
      if (size === undefined) {
        return undefined;
      }
      return { body: Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>, size };
    },

    async delete(key) {
      const path = objectPath(key);
      // A directory here is a key prefix, not an object: leave it alone.
      if (await fileSize(path) !== undefined) {
        await rm(path, { force: true });
      }
    },

    async deletePrefix(prefix) {
      assertBlobPrefix(prefix);
      // A string prefix ends part-way through a path segment: everything in
      // the directory named by the complete segments whose name starts with
      // the remainder matches, files and whole subtrees alike.
      const segments = prefix.split("/");
      const partial = segments.pop() ?? "";
      const dir = join(root, "objects", ...segments);
      const names = await readdir(dir).catch(() => []);
      for (const name of names) {
        if (name.startsWith(partial)) {
          await rm(join(dir, name), { recursive: true, force: true });
        }
      }
    },

    async createMultipart(key) {
      assertBlobKey(key);
      const uploadId = randomUUID();
      const dir = join(root, "multipart", uploadId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, KEY_FILE), key, { mode: 0o600 });
      return { uploadId };
    },

    async putPart(key, uploadId, partNumber, body, size) {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
        throw new BlobMultipartError(`Invalid part number: ${partNumber}`);
      }
      const dir = await requireUploadDir(key, uploadId);
      const tmp = join(dir, `tmp-${randomUUID()}`);
      const etag = await spool(body, tmp, size);
      const name = `${partNumber}-${etag}`;
      try {
        await rename(tmp, join(dir, name));
      }
      catch (err) {
        await rm(tmp, { force: true });
        throw new BlobPutError(`Could not store part ${partNumber} of ${key}`, { cause: err });
      }
      // The newest upload of a part number is the only one that counts.
      for (const other of await readdir(dir)) {
        if (other.startsWith(`${partNumber}-`) && other !== name) {
          await rm(join(dir, other), { force: true });
        }
      }
      return { etag };
    },

    async completeMultipart(key, uploadId, parts) {
      const dir = await requireUploadDir(key, uploadId);
      if (parts.length === 0) {
        throw new BlobMultipartError(`No parts given to complete ${key}`);
      }
      const paths: string[] = [];
      let previous = 0;
      for (const part of parts) {
        if (!Number.isInteger(part.partNumber) || part.partNumber <= previous) {
          throw new BlobMultipartError(`Parts of ${key} must be listed in ascending part-number order`);
        }
        previous = part.partNumber;
        const path = join(dir, `${part.partNumber}-${part.etag}`);
        if (!RE_ETAG.test(part.etag) || await fileSize(path) === undefined) {
          throw new BlobMultipartError(`Part ${part.partNumber} of ${key} was not uploaded with etag ${JSON.stringify(part.etag)}`);
        }
        paths.push(path);
      }

      const tmp = await tempPath();
      try {
        const handle = await open(tmp, "wx", 0o600);
        try {
          for (const path of paths) {
            for await (const chunk of createReadStream(path)) {
              await handle.write(chunk as Uint8Array);
            }
          }
        }
        finally {
          await handle.close();
        }
      }
      catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
      await publish(tmp, key);
      await rm(dir, { recursive: true, force: true });
    },

    async abortMultipart(key, uploadId) {
      const dir = await uploadDir(key, uploadId);
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Size of the regular file at `path`; `undefined` when there is none. */
async function fileSize(path: string): Promise<number | undefined> {
  const info = await stat(path).catch(() => undefined);
  return info?.isFile() ? info.size : undefined;
}

/**
 * Write `body` to a new file at `path` while hashing it, and return the hex
 * SHA-256. The file is removed again when the body errors or is not exactly
 * `expectedSize` bytes long; reading stops as soon as it runs over.
 */
async function spool(body: ReadableStream<Uint8Array>, path: string, expectedSize: number): Promise<string> {
  const hash = createHash("sha256");
  let seen = 0;
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      for await (const chunk of body) {
        seen += chunk.byteLength;
        if (seen > expectedSize) {
          break;
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    }
    finally {
      await handle.close();
    }
  }
  catch (err) {
    await rm(path, { force: true });
    throw new BlobPutError("Upload failed before the body was complete", { cause: err });
  }
  if (seen !== expectedSize) {
    await rm(path, { force: true });
    throw new BlobDigestMismatchError(
      seen > expectedSize
        ? `Body is longer than the declared ${expectedSize} bytes`
        : `Body is ${seen} bytes, declared ${expectedSize}`,
    );
  }
  return hash.digest("hex");
}
