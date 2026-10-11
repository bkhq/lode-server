import type { R2Bucket } from "@cloudflare/workers-types";
import type { FileStorageDriver } from "@/modules/file/storage/types";
import { registerDriver } from "@/modules/file/storage/registry";

/**
 * R2 storage driver, the Workers counterpart of the local-filesystem
 * driver. Keys are the same driver-agnostic `<ab>/<cd>/<sha256>` shape, so
 * a blob tree can be copied between the two backends verbatim.
 *
 * `presignDownload` is deliberately absent: signing an R2 URL needs the S3
 * API and an access key pair, which a bucket binding does not carry.
 * Downloads therefore stream through the Worker, and `initFileModule` logs
 * that once at boot.
 */
export function registerR2Driver(bucket: R2Bucket): void {
  const driver: FileStorageDriver = {
    name: "r2",

    async put(key, data) {
      // R2 overwrites by key, so this is idempotent as the contract requires.
      await bucket.put(key, data as ArrayBuffer);
    },

    async getStream(key) {
      const object = await bucket.get(key);
      if (!object) {
        throw new Error(`Missing blob at ${key}`);
      }
      return object.body as unknown as ReadableStream<Uint8Array>;
    },

    async delete(key) {
      await bucket.delete(key);
    },

    async exists(key) {
      return (await bucket.head(key)) !== null;
    },
  };

  registerDriver(driver);
}
