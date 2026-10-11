import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { ForbiddenError, NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonOk, raw, SECURITY, TAGS } from "@/shared/lib/openapi";
import { authRequired } from "@/shared/middleware/auth";
import { buildDownloadResponse, getFileById, getReferenceById } from "./file.service";
import { getFilePermissionHook } from "./permission";

const fileMetadataSchema = z.object({
  id: z.string(),
  size: z.number(),
  mimetype: z.string(),
  filename: z.string(),
  ownerType: z.string(),
  ownerId: z.string(),
  createdAt: z.string(),
});

/**
 * The `file` module exposes a tiny pair of read endpoints. **Uploads do
 * not happen here** — every upload comes in through the parent
 * resource's route (e.g. `POST /api/items/:id/attachments`) so the
 * per-resource permission stays at the consumer boundary.
 *
 * Both endpoints take `ref=<reference id>` so we know which consumer
 * relationship to authorise against. The active permission hook (looked
 * up by `reference.ownerType`) decides whether the actor can read /
 * delete. A 404 — never 403 — is returned when no hook is registered
 * for the owner type, so the existence of an unclaimed owner_type is
 * not leaked.
 */
export function fileRoutes() {
  const router = new Hono<AppEnv>();
  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/files/*", authRequired);

  router.get(
    "/files/:id/metadata",
    describeRoute({
      tags: [TAGS.File],
      summary: "Get file metadata",
      description: "Resolves the file via `?ref=<reference id>` and authorises against the owner type's permission hook.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(fileMetadataSchema, "File metadata"),
        ...errors(401, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id");
      const refId = c.req.query("ref");
      if (!refId)
        throw new NotFoundError("File", id);

      const ref = await getReferenceById(db, refId);
      if (!ref || ref.fileId !== id)
        throw new NotFoundError("File", id);

      const hook = getFilePermissionHook(ref.ownerType);
      if (!hook)
        throw new NotFoundError("File", id);

      const allowed = await hook.canRead(db, { id: user.id, role: user.role }, ref);
      if (!allowed)
        throw new NotFoundError("File", id);

      const file = await getFileById(db, id);
      if (!file)
        throw new NotFoundError("File", id);

      return c.json({
        success: true,
        data: {
          id: file.id,
          size: file.size,
          mimetype: file.mimetype,
          filename: ref.filename,
          ownerType: ref.ownerType,
          ownerId: ref.ownerId,
          createdAt: ref.createdAt,
        },
      });
    },
  );

  router.get(
    "/files/:id/content",
    describeRoute({
      tags: [TAGS.File],
      summary: "Download file content",
      description: "Streams the file binary, resolved via `?ref=<reference id>`. `?inline=true` serves it inline.",
      security: SECURITY.session,
      responses: {
        ...raw(200, "application/octet-stream", "File content"),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const id = c.req.param("id");
      const refId = c.req.query("ref");
      const wantInline = c.req.query("inline") === "true";
      if (!refId)
        throw new NotFoundError("File", id);

      const ref = await getReferenceById(db, refId);
      if (!ref || ref.fileId !== id)
        throw new NotFoundError("File", id);

      const hook = getFilePermissionHook(ref.ownerType);
      if (!hook)
        throw new NotFoundError("File", id);

      const allowed = await hook.canRead(db, { id: user.id, role: user.role }, ref);
      if (!allowed) {
        // Reader is authenticated but barred. 403 here, not 404 — the
        // caller already has the (file id, ref id) tuple so we're not
        // leaking existence; surfacing 403 lets the UI render an
        // accurate "permission denied" state.
        throw new ForbiddenError();
      }

      const file = await getFileById(db, id);
      if (!file)
        throw new NotFoundError("File", id);

      return await buildDownloadResponse(c.get("config"), file, ref, { inline: wantInline });
    },
  );

  return router;
}
