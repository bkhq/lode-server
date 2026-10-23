import type { Context } from "hono";
import type { FileReferenceRow } from "./file.service";
import type { AppDatabase } from "@/db";
import type { AppEnv } from "@/shared/lib/types";
import { AppError, NotFoundError } from "@/shared/lib/errors";
import { buildDownloadResponse, getFileById, getReferenceById } from "./file.service";

// Route-side steps shared by every endpoint that uploads, serves or deletes
// a resource's attachments; each caller keeps its own permission check.

/**
 * The multipart `file` field of an upload. A declared body over
 * MAX_UPLOAD_BYTES is refused before it is parsed.
 */
export async function readUploadedFile(c: Context<AppEnv>): Promise<File> {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > c.get("config").MAX_UPLOAD_BYTES)
    throw new AppError("Upload too large", 413, "UPLOAD_TOO_LARGE");
  const file = (await c.req.formData()).get("file");
  if (!(file instanceof File))
    throw new AppError("No file provided", 400, "VALIDATION_ERROR");
  return file;
}

/** Reference `aid`, only if it is an `ownerType` attachment of `ownerId`. */
export async function getOwnedReference(
  db: AppDatabase,
  aid: string,
  ownerType: string,
  ownerId: string,
): Promise<FileReferenceRow> {
  const ref = await getReferenceById(db, aid);
  if (!ref || ref.ownerType !== ownerType || ref.ownerId !== ownerId)
    throw new NotFoundError("Attachment", aid);
  return ref;
}

/** Stream an attachment; `?inline=true` asks for in-browser viewing. */
export async function sendAttachment(c: Context<AppEnv>, ref: FileReferenceRow): Promise<Response> {
  const file = await getFileById(c.get("db"), ref.fileId);
  if (!file)
    throw new NotFoundError("File", ref.id);
  return await buildDownloadResponse(c.get("config"), file, ref, { inline: c.req.query("inline") === "true" });
}
