import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { AppError, ValidationError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { requirePackageAccess, requireUploadAccess } from "./access";
import { assetNameSchema, auditRelease, overrideSchema, RE_CONTENT_LENGTH, sha256Schema, versionParamSchema } from "./release.routes";
import { abortUpload, completeUpload, MULTIPART_PART_SIZE, putUploadPart, startUpload } from "./upload.service";
import { assetSchema, assetView } from "./wire";

/** The part upload, as `registryRoutes` needs it to mount `discardUnreadBody`. */
export const UPLOAD_PART_ROUTE = "/registry/uploads/:uploadId/parts/:n";

// The fields of the single-request upload's path and query, in a body. An
// empty `sig`, `run` or `exec` is the field left out.
const startUploadSchema = z.object({
  asset: assetNameSchema,
  size: z.number().int().positive(),
  sha256: sha256Schema,
  sig: z.string().max(512).optional(),
  run: overrideSchema("run"),
  exec: overrideSchema("exec"),
});

// The plan's field names, camelCase as written there.
const startedUploadSchema = z.object({
  uploadId: z.string(),
  partSize: z.number(),
  partCount: z.number(),
});

const uploadParamSchema = z.object({ uploadId: z.string() });
const partParamSchema = uploadParamSchema.extend({ n: z.string().regex(/^[1-9]\d{0,4}$/, "The part number is a positive integer") });

/**
 * The multipart upload routes, for assets above the single-request limit.
 * Mounted by `registryRoutes` behind its `authRequired`. The routes addressed
 * by `:uploadId` carry no package in their path: `requireUploadAccess`
 * resolves the upload to its package and checks the caller against that.
 */
export function registryUploadRoutes() {
  const router = new Hono<AppEnv>();

  router.post(
    "/registry/packages/:ns/:pkg/versions/:ver/uploads",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Start a multipart upload",
      description: [
        `Opens an upload of the asset \`asset\` into a draft version, for bodies above the single-request limit and up to the asset size limit (at most 500 MiB). The answer names the upload and how to split the body: every part is \`partSize\` bytes (${MULTIPART_PART_SIZE}, 64 MiB, fixed by the server) except the last, which is the remainder; there are \`partCount\` parts.`,
        "`asset`, `sha256`, `sig`, `run` and `exec` mean what they do on the single-request upload and are checked the same way, here, before any byte is accepted: `sha256` is the lowercase hex digest of the whole asset, and `sig` must verify under one of the package owner's active signing keys (400 `INVALID_SIGNATURE`; a package with `require_signature` refuses a start without it).",
        "`size` is checked against the asset size limit (413) and the owner's storage quota (409), and is held against that quota until the upload is completed, aborted or expires. Starting an upload for an asset name that already has one in flight gives the earlier one up. An upload that is not completed in time is aborted by the server. Needs `write` access.",
      ].join("\n\n"),
      security: SECURITY.session,
      responses: { ...jsonCreated(startedUploadSchema), ...errors(400, 401, 403, 404, 409, 413, 422) },
    }),
    // Access is settled before the parameters are looked at.
    async (c, next) => {
      await requirePackageAccess(c, "write");
      await next();
    },
    validator("param", versionParamSchema),
    validator("json", startUploadSchema),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const { ver } = c.req.valid("param");
      const body = c.req.valid("json");
      const { upload, partSize, partCount } = await startUpload(c.get("db"), c.get("config"), access, {
        version: ver,
        name: body.asset,
        size: body.size,
        sha256: body.sha256,
        sig: body.sig?.trim() || null,
        run: body.run || null,
        exec: body.exec || null,
      });
      await auditRelease(c, access, "registry.upload.started", { type: "registry_upload", id: upload.id, name: `@${ver}/${upload.assetName}` }, {
        upload_id: upload.id,
        size: upload.size,
        sha256: upload.sha256,
        key_id: upload.keyId,
        part_count: partCount,
      });
      return c.json({ success: true, data: { uploadId: upload.id, partSize, partCount } }, 201);
    },
  );

  router.put(
    UPLOAD_PART_ROUTE,
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Upload one part",
      description: "The raw request body becomes part `:n` (1 to `partCount`) of the upload; it is streamed into storage, never buffered. `Content-Length` is required (411 without) and must be exactly the size of that part: `partSize`, or the remainder for the last part (422 `INVALID_PART_SIZE`). Parts may be sent in any order and in parallel; sending a part number again replaces the earlier body. A body that does not arrive whole is refused with 422 `PART_REJECTED` and stores nothing. An upload past its expiry answers 409 `UPLOAD_EXPIRED` and is discarded. Needs `write` access to the upload's package; an upload the caller has no access to answers 404.",
      security: SECURITY.session,
      requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      responses: { ...jsonOk(z.object({ part_number: z.number(), size: z.number() })), ...errors(401, 403, 404, 409, 411, 422) },
    }),
    async (c, next) => {
      await requireUploadAccess(c, "write");
      await next();
    },
    validator("param", partParamSchema),
    async (c) => {
      const access = await requireUploadAccess(c, "write");
      const n = Number(c.req.valid("param").n);

      const declared = c.req.header("content-length");
      if (declared === undefined || !RE_CONTENT_LENGTH.test(declared))
        throw new AppError("Content-Length is required", 411, "LENGTH_REQUIRED");
      const size = Number(declared);
      const body = c.req.raw.body;
      if (size === 0 || !body)
        throw new ValidationError("Validation failed", { formErrors: ["A part must not be empty"], fieldErrors: {} });

      await putUploadPart(c.get("db"), c.get("config"), access, n, size, body);
      return c.json({ success: true, data: { part_number: n, size } });
    },
  );

  router.post(
    "/registry/uploads/:uploadId/complete",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Complete a multipart upload",
      description: [
        "Assembles the parts into the asset and verifies it: the assembled object is hashed and compared with the `sha256` declared at start. Only after a match does the asset exist; it answers like the single-request upload, 201 for a new asset and 200 when it replaced one of the same name.",
        "A mismatch answers 422 `DIGEST_MISMATCH`: the object is deleted and the upload is gone, so it has to be started again. 409 `UPLOAD_INCOMPLETE` when a part is missing (the upload stays open), 409 `VERSION_NOT_DRAFT` when the version was published meanwhile (the upload is discarded), 409 `VERSION_BUSY` while another operation holds the version, 409 `UPLOAD_EXPIRED` when the upload is past its expiry (it is discarded), 400 `INVALID_SIGNATURE` when the key it was signed with was revoked meanwhile (it is discarded). Needs `write` access to the upload's package.",
      ].join("\n\n"),
      security: SECURITY.session,
      responses: {
        ...jsonOk(assetSchema, "Replaced an asset of the same name"),
        ...jsonCreated(assetSchema),
        ...errors(400, 401, 403, 404, 409, 422),
      },
    }),
    validator("param", uploadParamSchema),
    async (c) => {
      const access = await requireUploadAccess(c, "write");
      const { asset, replaced } = await completeUpload(c.get("db"), c.get("config"), access);
      await auditRelease(c, access, "registry.asset.uploaded", { type: "registry_asset", id: asset.id, name: `@${access.version.version}/${asset.name}` }, {
        upload_id: access.upload.id,
        size: asset.size,
        sha256: asset.sha256,
        key_id: asset.keyId,
        replaced,
        multipart: true,
      });
      return c.json({ success: true, data: assetView(asset) }, replaced ? 200 : 201);
    },
  );

  router.delete(
    "/registry/uploads/:uploadId",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Abort a multipart upload",
      description: "Discards the upload and every part stored for it, and releases the storage it held against the quota. Needs `write` access to the upload's package.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ id: z.string() })), ...errors(401, 403, 404, 409) },
    }),
    validator("param", uploadParamSchema),
    async (c) => {
      const access = await requireUploadAccess(c, "write");
      await abortUpload(c.get("db"), c.get("config"), access);
      await auditRelease(c, access, "registry.upload.aborted", { type: "registry_upload", id: access.upload.id, name: `@${access.version.version}/${access.upload.assetName}` }, {
        upload_id: access.upload.id,
        size: access.upload.size,
      });
      return c.json({ success: true, data: { id: access.upload.id } });
    },
  );

  return router;
}
