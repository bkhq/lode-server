import type { BlobStore } from "./types";
import { createHash } from "node:crypto";

/** The workerd `crypto.DigestStream`: a sink that resolves `digest` on close. */
type DigestStreamConstructor = new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };

/**
 * Hex SHA-256 of the object at `key`, streamed back out of the store;
 * `undefined` when there is no such object.
 *
 * A completed R2 multipart object carries no SHA-256 of its own, so this is
 * the only check of an assembled upload. On workerd the body is piped into
 * `crypto.DigestStream` (measured at about 4 s of CPU for 500 MiB, R2 read
 * included; see ../spike/README.md); Bun has no DigestStream and hashes
 * incrementally instead. Neither path buffers the object.
 */
export async function sha256OfBlob(store: BlobStore, key: string): Promise<string | undefined> {
  const object = await store.get(key);
  if (!object) {
    return undefined;
  }

  const { DigestStream } = crypto as unknown as { DigestStream?: DigestStreamConstructor };
  if (DigestStream) {
    const digester = new DigestStream("SHA-256");
    await object.body.pipeTo(digester);
    return [
      ...new Uint8Array(await digester.digest),
    ].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  const hash = createHash("sha256");
  for await (const chunk of object.body) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
