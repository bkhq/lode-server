/**
 * Compute the canonical storage key for a blob. The shape — `<ab>/<cd>/<sha256>`
 * — is driver-agnostic; the local driver maps it to filesystem paths and a
 * future S3 driver would prefix it under its bucket.
 *
 * Drivers ARE free to override this (e.g. an S3 driver might add a bucket
 * prefix, or a project-specific tenant scope) but the default keeps every
 * driver compatible with the same hash on disk / object layout.
 */
export function deriveStorageKey(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`Invalid sha256 for storage key: ${sha256}`);
  }
  return `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}
