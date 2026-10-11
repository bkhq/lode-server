import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import { sum } from "drizzle-orm";
import { files } from "@/modules/file/schema";
import { AppError } from "@/shared/lib/errors";

/**
 * Upload-limit helpers. The numeric ceilings (`MAX_UPLOAD_BYTES`,
 * `MAX_ATTACHMENTS_PER_RESOURCE`, `UPLOADS_TOTAL_BYTES`) live on the
 * validated `Config` object — call sites pass `c.get("config")` rather
 * than read module-level state. This file owns:
 *
 *   - a stateless `isWithinFileSize(size, config)` helper for the
 *     per-file ceiling;
 *   - a per-process cache of "total bytes used" plus the inc/dec
 *     hooks that keep it in step with attachment churn;
 *   - `assertWithinTotalQuota(db, config, additionalBytes)` for the
 *     cross-module disk-quota check.
 *
 * The cache is intentionally process-local: a stale value drifts by at
 * most one running sweep window before the periodic SQL recompute
 * resolves it.
 */

const RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000;

let cachedUsedBytes: number | undefined;
let cacheLoadedAt = 0;

export function isWithinFileSize(
  size: number,
  config: Pick<Config, "MAX_UPLOAD_BYTES">,
): boolean {
  return size > 0 && size <= config.MAX_UPLOAD_BYTES;
}

export function maxAttachmentsPerResource(
  config: Pick<Config, "MAX_ATTACHMENTS_PER_RESOURCE">,
): number {
  return config.MAX_ATTACHMENTS_PER_RESOURCE;
}

/** Total bytes accounted for by every stored blob. */
async function recomputeUsedFromDb(db: AppDatabase): Promise<number> {
  const fileRow = await db.select({ value: sum(files.size) }).from(files).get();
  return Number(fileRow?.value ?? 0);
}

/**
 * Total bytes consumed by all attachments across every upload-capable
 * module. Cached for `RECOMPUTE_INTERVAL_MS` and kept in sync via
 * {@link incrementUploadsUsed} / {@link decrementUploadsUsed}; a SQL
 * recompute every interval corrects drift.
 */
export async function getUploadsUsedBytes(db: AppDatabase): Promise<number> {
  const now = Date.now();
  if (cachedUsedBytes === undefined || now - cacheLoadedAt > RECOMPUTE_INTERVAL_MS) {
    cachedUsedBytes = await recomputeUsedFromDb(db);
    cacheLoadedAt = now;
  }
  return cachedUsedBytes;
}

/** Bump the cached upload counter when a new attachment is persisted. */
export function incrementUploadsUsed(bytes: number): void {
  if (bytes <= 0)
    return;
  if (cachedUsedBytes !== undefined)
    cachedUsedBytes += bytes;
}

/** Decrement the cached upload counter when an attachment is deleted. */
export function decrementUploadsUsed(bytes: number): void {
  if (bytes <= 0)
    return;
  if (cachedUsedBytes !== undefined)
    cachedUsedBytes = Math.max(0, cachedUsedBytes - bytes);
}

/**
 * Test hook — drop the cached running total so subsequent reads are
 * forced to recompute from SQL. Tests that share a process should call
 * this between mutating fixtures so the cache doesn't bleed.
 */
export function __resetUploadsCacheForTests(): void {
  cachedUsedBytes = undefined;
  cacheLoadedAt = 0;
}

/**
 * Throw 413 PAYLOAD_TOO_LARGE if accepting `additionalBytes` would push
 * cumulative usage past the configured total quota. No-op when the
 * quota is 0 (unlimited).
 */
export async function assertWithinTotalQuota(
  db: AppDatabase,
  config: Pick<Config, "UPLOADS_TOTAL_BYTES">,
  additionalBytes: number,
): Promise<void> {
  const limit = config.UPLOADS_TOTAL_BYTES;
  if (limit <= 0)
    return;
  const used = await getUploadsUsedBytes(db);
  if (used + additionalBytes > limit) {
    throw new AppError(
      `Upload quota exceeded. Limit: ${limit} bytes; used: ${used} bytes.`,
      413,
      "QUOTA_EXCEEDED",
    );
  }
}
