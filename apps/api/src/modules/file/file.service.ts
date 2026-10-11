import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import { createHash } from "node:crypto";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { fileReferences, files } from "@/modules/file/schema";
import { buildContentDisposition } from "@/shared/lib/content-disposition";
import { AppError } from "@/shared/lib/errors";
import { nanoid, ulid } from "@/shared/lib/id";
import { mimeMatchesContent } from "@/shared/lib/mime-sniff";
import { assertWithinTotalQuota, isWithinFileSize, maxAttachmentsPerResource } from "@/shared/lib/upload-limits";
import { deriveStorageKey } from "./storage/key";
import { getActiveDriver } from "./storage/registry";

export type FileRow = typeof files.$inferSelect;
export type FileReferenceRow = typeof fileReferences.$inferSelect;

/**
 * Subset of `Config` the file service needs at runtime. Callers thread
 * this through from `c.get("config")` rather than the service caching a
 * process-global copy. Narrowed type so unrelated config drift cannot
 * silently change file-service behaviour.
 */
export interface FileServiceConfig {
  readonly FILE_GC_MODE: "async" | "sync";
  readonly FILE_PRESIGN_ENABLED: boolean;
  readonly FILE_PRESIGN_TTL_SECONDS: number;
}

const ALLOWED_MIMETYPES = /^(?:image\/.*|application\/pdf|text\/.*|application\/zip|application\/x-7z-compressed)$/;

export interface UploadInput {
  readonly file: File;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly uploadedBy: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface UploadResult {
  readonly file: FileRow;
  readonly reference: FileReferenceRow;
  /** True iff the upload hit an existing `files` row (dedupe). */
  readonly deduped: boolean;
}

/**
 * Upload bytes and register a reference. The same content uploaded twice
 * yields **one** `files` row and **two** `file_references` rows. The
 * per-reference uniqueness rule prevents the same owner from holding two
 * references to the same blob.
 *
 * Permission is **not** checked here — sub-types resolve "can this actor
 * upload to this owner?" at the route boundary before calling this.
 */
export async function uploadAndReference(
  db: AppDatabase,
  config: Pick<Config, "MAX_UPLOAD_BYTES" | "MAX_ATTACHMENTS_PER_RESOURCE" | "UPLOADS_TOTAL_BYTES">,
  input: UploadInput,
): Promise<UploadResult> {
  const { file, ownerType, ownerId, uploadedBy } = input;

  if (!isWithinFileSize(file.size, config)) {
    throw new AppError("File size exceeds per-file limit", 400, "FILE_TOO_LARGE");
  }
  if (!ALLOWED_MIMETYPES.test(file.type)) {
    throw new AppError("File type not allowed", 400, "INVALID_MIMETYPE");
  }

  // Read the buffer once. Bun gives us an ArrayBuffer; we sniff the first
  // 1 KiB for magic-byte verification, hash the full bytes for the content
  // key, and hand the same buffer to the storage driver. Streaming
  // upload+hash is a follow-up; the current 10 MiB per-file cap keeps the
  // memory profile fine.
  const buffer = await file.arrayBuffer();

  const sniffWindow = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024));
  if (!mimeMatchesContent(file.type, sniffWindow)) {
    throw new AppError("File contents do not match declared type", 400, "MIME_MISMATCH");
  }

  const sha256 = sha256Hex(buffer);
  const driver = getActiveDriver();

  // Enforce per-resource attachment count BEFORE consuming quota. The
  // count is whatever the consumer modelled as "attachments on this
  // owner" — which by convention is "references with this owner_type +
  // owner_id" so the same rule applies to every consumer.
  const existing = await db.select({ value: count() })
    .from(fileReferences)
    .where(and(
      eq(fileReferences.ownerType, ownerType),
      eq(fileReferences.ownerId, ownerId),
    ))
    .get();
  const maxAttachments = maxAttachmentsPerResource(config);
  if ((existing?.value ?? 0) >= maxAttachments) {
    throw new AppError(
      `Maximum attachments per resource reached (${maxAttachments})`,
      400,
      "LIMIT_EXCEEDED",
    );
  }

  // Reject before consuming bytes — keeps the request from spending IO on a
  // file that the per-tenant quota will refuse.
  await assertWithinTotalQuota(db, config, file.size);

  return await db.transaction(async (tx) => {
    // Find or create the files row. We hold the transaction across the
    // driver write so a parallel uploader of the same content sees the
    // already-locked row and either reuses it (dedupe) or backs off.
    let existingFile = await tx.select().from(files).where(
      and(eq(files.sha256, sha256), eq(files.storageDriver, driver.name)),
    ).get();

    let deduped = false;

    if (existingFile) {
      // Dedupe hit — bump refcount, no driver write.
      await tx.update(files)
        .set({ refCount: sql`${files.refCount} + 1` })
        .where(eq(files.id, existingFile.id))
        .run();
      deduped = true;
      existingFile = { ...existingFile, refCount: existingFile.refCount + 1 };
    }
    else {
      const id = ulid();
      const storageKey = deriveStorageKey(sha256);
      await driver.put(storageKey, buffer);
      await tx.insert(files).values({
        id,
        sha256,
        size: file.size,
        mimetype: file.type,
        storageDriver: driver.name,
        storageKey,
        refCount: 1,
        uploadedBy,
      }).run();
      existingFile = (await tx.select().from(files).where(eq(files.id, id)).get())!;
    }

    // Reference row. UNIQUE(owner_type, owner_id, file_id) is the
    // "no two references for the same (owner, blob)" guard at the DB
    // level — fall through to a clean error if a caller double-attaches.
    const refId = nanoid();
    try {
      await tx.insert(fileReferences).values({
        id: refId,
        fileId: existingFile.id,
        ownerType,
        ownerId,
        filename: file.name,
        metadata: JSON.stringify(input.metadata ?? {}),
        createdBy: uploadedBy,
      }).run();
    }
    catch (err) {
      // Surface UNIQUE violations as 400; let the rest bubble. Drizzle wraps
      // the libsql error so we have to walk the cause chain.
      if (isUniqueConstraintError(err)) {
        throw new AppError("This file is already attached to this resource", 400, "DUPLICATE_REFERENCE");
      }
      throw err;
    }

    const ref = (await tx.select().from(fileReferences).where(eq(fileReferences.id, refId)).get())!;
    return { file: existingFile, reference: ref, deduped };
  });
}

export interface AddReferenceInput {
  readonly fileId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly filename?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly createdBy: string;
}

/**
 * Register an additional reference to an already-stored file (no upload).
 * Used by features that "copy" an attachment between resources without
 * re-uploading the blob — e.g. duplicating an item.
 */
export async function addReference(db: AppDatabase, input: AddReferenceInput): Promise<FileReferenceRow> {
  return await db.transaction(async (tx) => {
    const file = await tx.select().from(files).where(eq(files.id, input.fileId)).get();
    if (!file) {
      throw new AppError("File not found", 404, "NOT_FOUND");
    }

    await tx.update(files)
      .set({ refCount: sql`${files.refCount} + 1` })
      .where(eq(files.id, input.fileId))
      .run();

    const refId = nanoid();
    try {
      await tx.insert(fileReferences).values({
        id: refId,
        fileId: input.fileId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        filename: input.filename ?? file.id,
        metadata: JSON.stringify(input.metadata ?? {}),
        createdBy: input.createdBy,
      }).run();
    }
    catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new AppError("This file is already attached to this resource", 400, "DUPLICATE_REFERENCE");
      }
      throw err;
    }
    return (await tx.select().from(fileReferences).where(eq(fileReferences.id, refId)).get())!;
  });
}

export interface ReleaseReferenceInput {
  readonly referenceId: string;
}

/**
 * Drop one reference. In async-GC mode, only the `file_references` row is
 * deleted and `files.ref_count` decremented; the sweeper handles the blob.
 * In sync-GC mode (tests / local-only), if the final reference goes away
 * we also drive `driver.delete` + the `files` row delete immediately.
 *
 * No-op if the reference is missing — release is idempotent so a retried
 * client request can't 404.
 */
export async function releaseReference(
  db: AppDatabase,
  config: FileServiceConfig,
  input: ReleaseReferenceInput,
): Promise<void> {
  const ref = await db.select().from(fileReferences).where(eq(fileReferences.id, input.referenceId)).get();
  if (!ref)
    return;

  const drainedFileId = await db.transaction(async (tx) => {
    await tx.delete(fileReferences).where(eq(fileReferences.id, input.referenceId)).run();
    await tx.update(files)
      .set({ refCount: sql`MAX(${files.refCount} - 1, 0)` })
      .where(eq(files.id, ref.fileId))
      .run();
    const after = await tx.select({ refCount: files.refCount, storageDriver: files.storageDriver, storageKey: files.storageKey })
      .from(files)
      .where(eq(files.id, ref.fileId))
      .get();
    return after && after.refCount === 0 ? { id: ref.fileId, ...after } : null;
  });

  if (drainedFileId && config.FILE_GC_MODE === "sync") {
    await syncDeleteBlob(db, drainedFileId);
  }
}

/**
 * Drop every reference belonging to a single owner. Used when the parent
 * resource is hard-deleted (e.g. eventual item-retention janitor). Each
 * blob whose refcount hits zero is queued for the sweeper (async) or
 * deleted immediately (sync).
 */
export async function releaseAllByOwner(
  db: AppDatabase,
  config: FileServiceConfig,
  ownerType: string,
  ownerId: string,
): Promise<void> {
  const refs = await db.select({ id: fileReferences.id })
    .from(fileReferences)
    .where(and(eq(fileReferences.ownerType, ownerType), eq(fileReferences.ownerId, ownerId)))
    .all();
  for (const r of refs) {
    await releaseReference(db, config, { referenceId: r.id });
  }
}

async function syncDeleteBlob(
  db: AppDatabase,
  drained: { id: string; storageDriver: string; storageKey: string },
): Promise<void> {
  const driver = getActiveDriver();
  if (driver.name !== drained.storageDriver) {
    // Stored under a different driver than the active one — we can't
    // safely delete it. Leave for an operator / future cross-driver
    // sweep. The async path handles this case too.
    return;
  }
  try {
    await driver.delete(drained.storageKey);
  }
  catch {
    // Tolerated: the row stays at refcount=0 and the next sweep retries.
    return;
  }
  await db.delete(files).where(eq(files.id, drained.id)).run();
}

// ─── Read-side helpers ──────────────────────────────────────────────────

export async function getFileById(db: AppDatabase, id: string): Promise<FileRow | undefined> {
  return await db.select().from(files).where(eq(files.id, id)).get();
}

export async function getReferenceById(db: AppDatabase, id: string): Promise<FileReferenceRow | undefined> {
  return await db.select().from(fileReferences).where(eq(fileReferences.id, id)).get();
}

export async function listReferencesByOwner(
  db: AppDatabase,
  ownerType: string,
  ownerId: string,
): Promise<readonly FileReferenceRow[]> {
  // createdAt is millisecond ISO text, so two references written in the
  // same tick tie; break the tie by insertion order (rowid), not by the
  // random nanoid — "newest-first" must mean what it says.
  return await db.select().from(fileReferences).where(and(eq(fileReferences.ownerType, ownerType), eq(fileReferences.ownerId, ownerId))).orderBy(desc(fileReferences.createdAt), desc(sql`${fileReferences}.rowid`)).all();
}

/**
 * Reference row enriched with the underlying blob's `mimetype` and `size`.
 * The wire shape that issue / document attachment endpoints return — gives
 * consumers everything they need to render a file row (icon, size) without
 * a second round-trip to `files`.
 */
export interface AttachmentView {
  readonly id: string;
  readonly fileId: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly size: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

function composeAttachmentView(ref: FileReferenceRow, file: { mimetype: string; size: number }): AttachmentView {
  return {
    id: ref.id,
    fileId: ref.fileId,
    ownerType: ref.ownerType,
    ownerId: ref.ownerId,
    filename: ref.filename,
    mimetype: file.mimetype,
    size: file.size,
    createdBy: ref.createdBy,
    createdAt: ref.createdAt,
  };
}

export async function listAttachmentsByOwner(
  db: AppDatabase,
  ownerType: string,
  ownerId: string,
): Promise<readonly AttachmentView[]> {
  const rows = await db
    .select({
      ref: fileReferences,
      mimetype: files.mimetype,
      size: files.size,
    })
    .from(fileReferences)
    .innerJoin(files, eq(fileReferences.fileId, files.id))
    .where(and(eq(fileReferences.ownerType, ownerType), eq(fileReferences.ownerId, ownerId)))
    .orderBy(desc(fileReferences.createdAt), desc(fileReferences.id))
    .all();
  return rows.map(r => composeAttachmentView(r.ref, { mimetype: r.mimetype, size: r.size }));
}

/** Compose a single attachment view from rows the caller already holds. */
export function makeAttachmentView(ref: FileReferenceRow, file: FileRow): AttachmentView {
  return composeAttachmentView(ref, { mimetype: file.mimetype, size: file.size });
}

// ─── Download ─────────────────────────────────────────────────────────

interface DownloadResponseOpts {
  readonly inline: boolean;
}

/**
 * Build the HTTP response for a download. When the active driver supports
 * `presignDownload` and presigning is enabled, returns a 302 to a
 * short-lived signed URL — the API process never touches the bytes.
 * Otherwise streams the body through the driver.
 *
 * The MIME-safety logic mirrors what the existing attachment routes do:
 * `inline` is honoured only for known-safe types (images excl. SVG, text
 * excl. HTML, PDF / JSON / XML). Everything else is forced to
 * `application/octet-stream` so the browser doesn't auto-execute.
 */
export async function buildDownloadResponse(
  config: FileServiceConfig,
  file: FileRow,
  ref: FileReferenceRow,
  opts: DownloadResponseOpts,
): Promise<Response> {
  const mt = file.mimetype;
  // Inline rendering is opt-in only for media types that browsers
  // cannot execute even when sniffing fails or the sniff prefix (first
  // 1 KiB) was matched by an attacker-crafted polyglot. SVG, every
  // `text/*` (including text/xml: stylesheet vectors), JSON and the
  // generic application/xml are deliberately excluded — they download.
  // Active-content vectors stay blocked even if a future driver returns
  // a permissive Content-Type.
  const INLINE_ALLOWED = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
    "application/pdf",
  ]);
  const inlineSafe = opts.inline && INLINE_ALLOWED.has(mt);
  const contentType = inlineSafe ? mt : "application/octet-stream";
  const disposition = buildContentDisposition(inlineSafe ? "inline" : "attachment", ref.filename);

  const driver = getActiveDriver();

  if (config.FILE_PRESIGN_ENABLED && driver.name === file.storageDriver && driver.presignDownload) {
    const url = await driver.presignDownload(file.storageKey, {
      expiresSeconds: config.FILE_PRESIGN_TTL_SECONDS,
      filename: ref.filename,
      inline: inlineSafe,
      contentType,
    });
    return new Response(null, { status: 302, headers: { Location: url } });
  }

  if (driver.name !== file.storageDriver) {
    // Stored under a driver no longer active — surface as 404 rather
    // than serving bytes that may not even exist on this filesystem.
    throw new AppError("File backend mismatch", 404, "FILE_BACKEND_MISMATCH");
  }

  const stream = await driver.getStream(file.storageKey);
  return new Response(stream, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": disposition,
      "Content-Length": String(file.size),
      "X-Content-Type-Options": "nosniff",
      "X-Download-Options": "noopen",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

// ─── GC support (used by the sweeper) ─────────────────────────────────

export async function listUnreferencedFiles(db: AppDatabase, limit: number): Promise<readonly FileRow[]> {
  return await db.select().from(files).where(eq(files.refCount, 0)).limit(limit).all();
}

export async function deleteUnreferencedFile(db: AppDatabase, file: FileRow): Promise<boolean> {
  const driver = getActiveDriver();
  if (driver.name !== file.storageDriver) {
    return false;
  }
  try {
    await driver.delete(file.storageKey);
  }
  catch {
    return false;
  }
  await db.delete(files).where(and(eq(files.id, file.id), eq(files.refCount, 0))).run();
  return true;
}

export async function totalStoredBytes(db: AppDatabase): Promise<number> {
  const row = await db.select({ value: sql<number>`COALESCE(SUM(${files.size}), 0)` }).from(files).get();
  return Number(row?.value ?? 0);
}

// ─── helpers ──────────────────────────────────────────────────────────

function sha256Hex(buffer: ArrayBuffer): string {
  const hash = createHash("sha256");
  hash.update(new Uint8Array(buffer));
  return hash.digest("hex");
}

/**
 * Drizzle wraps the underlying libsql error and prepends "Failed query: …".
 * The "UNIQUE constraint failed: …" string lives on `err.cause`; walk both
 * the top-level message and the cause chain to identify it.
 */
function isUniqueConstraintError(err: unknown): boolean {
  let cur: unknown = err;
  while (cur instanceof Error) {
    if (/UNIQUE constraint failed/i.test(cur.message))
      return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
