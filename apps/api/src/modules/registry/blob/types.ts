/**
 * Asset storage seam of the registry module, independent of the `file`
 * module's storage drivers. Bodies are streams in both directions; no driver
 * buffers a whole object.
 *
 * Keys are relative, `/`-separated paths (`pkg/<package_id>/<version_id>/<asset_name>`).
 */
export interface BlobStore {
  /**
   * Store `body` at `key`, replacing any object already there. Rejects with a
   * {@link BlobPutError} when the upload fails for any reason, and with its
   * subclass {@link BlobDigestMismatchError} when the driver itself
   * established that the bytes do not hash to `opts.sha256` or their length
   * differs from `opts.size`. Either way the failed call stored nothing.
   */
  put: (key: string, body: ReadableStream<Uint8Array>, opts: BlobPutOptions) => Promise<void>;

  /** The object at `key`, or `undefined` when there is none. */
  get: (key: string) => Promise<{ body: ReadableStream<Uint8Array>; size: number } | undefined>;

  /** Remove the object. A missing key is a no-op. */
  delete: (key: string) => Promise<void>;

  /** Remove every object whose key starts with `prefix`. */
  deletePrefix: (prefix: string) => Promise<void>;

  createMultipart: (key: string) => Promise<{ uploadId: string }>;

  /**
   * Store one part. Uploading the same `partNumber` again replaces the
   * earlier part; only the etag returned last is valid for completion.
   * Fails like {@link BlobStore.put}, with `size` as the expected length.
   */
  putPart: (
    key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream<Uint8Array>,
    size: number,
  ) => Promise<{ etag: string }>;

  /**
   * Assemble the listed parts, in ascending part-number order, into the
   * object at `key`. The assembled object is not checked against any digest:
   * callers verify it with `sha256OfBlob`.
   */
  completeMultipart: (key: string, uploadId: string, parts: BlobPart[]) => Promise<void>;

  /** Discard the upload and every part stored for it. */
  abortMultipart: (key: string, uploadId: string) => Promise<void>;
}

export interface BlobPutOptions {
  /** Exact byte length of the body. */
  size: number;
  /** Lowercase hex SHA-256 of the body. */
  sha256: string;
}

export interface BlobPart {
  partNumber: number;
  etag: string;
}

/** An upload failed; the failed call stored nothing. */
export class BlobPutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlobPutError";
  }
}

/** The uploaded bytes do not match the declared SHA-256 or length. */
export class BlobDigestMismatchError extends BlobPutError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlobDigestMismatchError";
  }
}

/** The multipart upload, or a part named for completion, is not usable. */
export class BlobMultipartError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BlobMultipartError";
  }
}
