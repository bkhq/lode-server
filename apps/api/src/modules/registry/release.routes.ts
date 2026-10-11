import type { Context, MiddlewareHandler } from "hono";
import type { PackageRequest } from "./access";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import { AppError, ForbiddenError, ValidationError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { requirePackageAccess } from "./access";
import { buildManifest } from "./feed.service";
import { deleteManifestSignature, findManifestSignature, manifestSignatureStatus, putManifestSignature } from "./manifest-signature.service";
import {
  createDraft,
  deleteAsset,
  deleteVersion,
  getVersion,
  listChannels,
  listVersions,
  publishVersion,
  restoreVersion,
  setChannel,
  SINGLE_REQUEST_MAX_BYTES,
  uploadAsset,
  yankVersion,
} from "./release.service";
import { commandOverrideError, idError } from "./validate";
import { assetSchema, assetView, auditMeta, channelSchema, channelView, check, manifestSignatureSchema, versionSchema, versionView } from "./wire";

/** The single-request upload, as `registryRoutes` needs it to mount `discardUnreadBody`. */
export const UPLOAD_ROUTE = "/registry/packages/:ns/:pkg/versions/:ver/assets/:asset";

/**
 * Read a request body nothing took to its end and discard it. On workerd a
 * response that goes out while the request body is unread logs `Can't read
 * from request stream after response has been sent` and costs the client its
 * next request on the connection; cancelling the body does not prevent that,
 * reading it does. So every early refusal of an upload has to pass here. The
 * bytes are dropped as they arrive, nothing is buffered, and the server's
 * request-body cap bounds how much there can be.
 */
export const discardUnreadBody: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    await next();
  }
  finally {
    const body = c.req.raw.body;
    // A locked body is one the blob store took.
    if (body && !body.locked)
      await body.pipeTo(new WritableStream()).catch(() => {});
  }
};

// ─── Request schemas ───

const versionIdSchema = z.string().superRefine(check(id => idError("version", id)));
const channelNameSchema = z.string().superRefine(check(id => idError("channel", id)));
export const assetNameSchema = z.string().superRefine(check(id => idError("asset name", id)));

const RE_SHA256 = /^[0-9a-f]{64}$/;
// Lowercase only: the digest is signed and served verbatim.
export const sha256Schema = z.string().regex(RE_SHA256, "sha256 must be 64 lowercase hex characters");

// An empty `run` / `exec` is the field left out, as it is in the signed message.
export function overrideSchema(kind: "run" | "exec") {
  return z.string().max(4096).superRefine((value, ctx) => {
    if (value !== "")
      check(v => commandOverrideError(kind, v))(value, ctx);
  }).optional();
}

const uploadQuerySchema = z.object({
  sha256: sha256Schema,
  sig: z.string().max(512).optional(),
  run: overrideSchema("run"),
  exec: overrideSchema("exec"),
});

const packageParamSchema = z.object({ ns: z.string(), pkg: z.string() });
export const versionParamSchema = packageParamSchema.extend({ ver: z.string() });
const assetParamSchema = versionParamSchema.extend({ asset: z.string() });

const RE_KEY_ID = /^[0-9a-f]{16}$/;
const manifestSignatureBodySchema = z.strictObject({
  key_id: z.string().regex(RE_KEY_ID, "key_id is 16 lowercase hex characters"),
  sig: z.string().min(1).max(512),
  expires: z.number().int().positive().optional(),
  expires_sig: z.string().min(1).max(512).optional(),
}).refine(body => (body.expires === undefined) === (body.expires_sig === undefined), "expires and expires_sig go together");

const versionWithChannelsSchema = z.object({ version: versionSchema, channels: z.array(channelSchema) });

export const RE_CONTENT_LENGTH = /^\d+$/;

/** One audit entry of a release mutation: who, whose package, and with which token. */
export async function auditRelease(
  c: Context<AppEnv>,
  access: PackageRequest,
  action: string,
  resource: { type: string; id: string; name: string },
  detail: Record<string, unknown> = {},
): Promise<void> {
  await audit(c.get("db"), c.get("logger"), {
    ...auditMeta(c),
    action,
    resourceType: resource.type,
    resourceId: resource.id,
    resourceName: `${access.namespace.slug}/${access.package.slug}${resource.name}`,
    detail: { owner_user_id: access.namespace.ownerUserId, ...detail, ...(access.tokenId !== null && { token_id: access.tokenId }) },
  });
}

/**
 * The release routes of a package: versions, assets, publish, channels, yank.
 * Mounted by `registryRoutes` behind its `authRequired`; which of them a
 * token may call is the `packages:*` scope table in `index.ts`.
 */
export function registryReleaseRoutes() {
  const router = new Hono<AppEnv>();

  // ─── Versions ───

  router.get(
    "/registry/packages/:ns/:pkg/versions",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "List the versions of a package",
      description: "Every version, newest first, drafts and yanked ones included, each with its assets, and the package's channel pointers. A token needs a `read` grant on the package.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ versions: z.array(versionSchema), channels: z.array(channelSchema) })), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const db = c.get("db");
      const { package: pkg } = await requirePackageAccess(c, "read");
      const versions = await listVersions(db, pkg.id);
      const channels = await listChannels(db, pkg.id);
      return c.json({ success: true, data: { versions: versions.map(versionView), channels: channels.map(channelView) } });
    },
  );

  router.get(
    "/registry/packages/:ns/:pkg/versions/:ver",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Get a version",
      description: "One version with its assets, and the package's channel pointers. A token needs a `read` grant on the package.",
      security: SECURITY.session,
      responses: { ...jsonOk(versionWithChannelsSchema), ...errors(401, 403, 404) },
    }),
    validator("param", versionParamSchema),
    async (c) => {
      const db = c.get("db");
      const { package: pkg } = await requirePackageAccess(c, "read");
      const version = await getVersion(db, pkg.id, c.req.valid("param").ver);
      const channels = await listChannels(db, pkg.id);
      return c.json({ success: true, data: { version: versionView(version), channels: channels.map(channelView) } });
    },
  );

  router.post(
    "/registry/packages/:ns/:pkg/versions",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Create a draft version",
      description: "Opens a draft to upload assets into. `version` follows lode's id rule: letters, digits, `.`, `_` and `-`, not starting with `.` or `-`. A draft is not served until it is published. 409 `VERSION_EXISTS` when the package has that version, 409 `VERSION_RETIRED` when a version of that id was published and then deleted: its id stays taken. Needs `write` access.",
      security: SECURITY.session,
      responses: { ...jsonCreated(versionSchema), ...errors(401, 403, 404, 409, 422) },
    }),
    validator("param", packageParamSchema),
    validator("json", z.object({ version: versionIdSchema, notes: z.string().max(20000).optional() })),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const version = await createDraft(c.get("db"), access.package.id, c.req.valid("json"));
      await auditRelease(c, access, "registry.version.created", { type: "registry_version", id: version.id, name: `@${version.version}` });
      return c.json({ success: true, data: versionView(version) }, 201);
    },
  );

  router.delete(
    "/registry/packages/:ns/:pkg/versions/:ver",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Delete a version",
      description: "Removes the version with its assets and their stored bytes. A draft needs `write` access. A published or yanked version can only be deleted by the owner or an administrator from a signed-in session — never with a token — and only while no channel points at it; its id is retired and cannot be created again.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ id: z.string() })), ...errors(401, 403, 404, 409) },
    }),
    validator("param", versionParamSchema),
    async (c) => {
      const db = c.get("db");
      const access = await requirePackageAccess(c, "write");
      const { ver } = c.req.valid("param");
      const draftOnly = (await getVersion(db, access.package.id, ver)).status === "draft";
      if (!draftOnly) {
        if (access.tokenId !== null)
          throw new ForbiddenError("A published or yanked version can only be deleted from a signed-in session");
        await requirePackageAccess(c, "owner");
      }
      const deleted = await deleteVersion(db, c.get("config"), access.package.id, ver, { draftOnly });
      await auditRelease(c, access, "registry.version.deleted", { type: "registry_version", id: deleted.id, name: `@${deleted.version}` }, { status: deleted.status });
      return c.json({ success: true, data: { id: deleted.id } });
    },
  );

  // ─── Assets ───

  router.put(
    UPLOAD_ROUTE,
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Upload an asset in one request",
      description: [
        `The raw request body becomes the asset \`:asset\` of a draft version; it is streamed into storage, never buffered. \`Content-Length\` is required (411 without) and may be at most ${SINGLE_REQUEST_MAX_BYTES} bytes (95 MiB; 413 above — use the multipart upload routes for larger assets).`,
        "`sha256` is the lowercase hex digest of the body; bytes that do not match it or the declared length are refused with 422 `DIGEST_MISMATCH` and nothing is stored.",
        "`sig` is the publisher's `lode.artifact.v2` signature as base64url (or percent-encoded standard base64). It must verify under one of the package's active signing keys, over the package slug as the app, the asset name, version, `sha256`, `run` and `exec` as given here; otherwise 400 `INVALID_SIGNATURE`. A package with `require_signature` refuses an upload without it. An empty `sig`, `run` or `exec` counts as absent.",
        "The asset size limit and the owner's storage quota are checked against `Content-Length` before any byte is read. Uploading an asset name again replaces it while the version is a draft; a published or yanked version answers 409. Needs `write` access.",
      ].join("\n\n"),
      security: SECURITY.session,
      requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      responses: {
        ...jsonOk(assetSchema, "Replaced an asset of the same name"),
        ...jsonCreated(assetSchema),
        ...errors(400, 401, 403, 404, 409, 411, 413, 422),
      },
    }),
    // Access is settled before the parameters are looked at.
    async (c, next) => {
      await requirePackageAccess(c, "write");
      await next();
    },
    validator("param", assetParamSchema.extend({ asset: assetNameSchema })),
    validator("query", uploadQuerySchema),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const { ver, asset: name } = c.req.valid("param");
      const query = c.req.valid("query");

      const declared = c.req.header("content-length");
      if (declared === undefined || !RE_CONTENT_LENGTH.test(declared))
        throw new AppError("Content-Length is required", 411, "LENGTH_REQUIRED");
      const size = Number(declared);
      const body = c.req.raw.body;
      if (size === 0 || !body)
        throw new ValidationError("Validation failed", { formErrors: ["An asset must not be empty"], fieldErrors: {} });

      const { asset, replaced } = await uploadAsset(c.get("db"), c.get("config"), access, {
        version: ver,
        name,
        size,
        sha256: query.sha256,
        sig: query.sig?.trim() || null,
        run: query.run || null,
        exec: query.exec || null,
        body,
      });
      await auditRelease(c, access, "registry.asset.uploaded", { type: "registry_asset", id: asset.id, name: `@${ver}/${asset.name}` }, {
        size: asset.size,
        sha256: asset.sha256,
        key_id: asset.keyId,
        replaced,
      });
      return c.json({ success: true, data: assetView(asset) }, replaced ? 200 : 201);
    },
  );

  router.delete(
    UPLOAD_ROUTE,
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Delete an asset from a draft",
      description: "Removes the asset and its stored bytes. Drafts only: the assets of a published or yanked version are immutable (409). Needs `write` access.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ name: z.string() })), ...errors(401, 403, 404, 409) },
    }),
    validator("param", assetParamSchema),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const { ver, asset: name } = c.req.valid("param");
      const asset = await deleteAsset(c.get("db"), c.get("config"), access.package.id, ver, name);
      await auditRelease(c, access, "registry.asset.deleted", { type: "registry_asset", id: asset.id, name: `@${ver}/${asset.name}` });
      return c.json({ success: true, data: { name: asset.name } });
    },
  );

  // ─── Publish, channels, yank ───

  router.post(
    "/registry/packages/:ns/:pkg/versions/:ver/publish",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Publish a draft version",
      description: "Makes a draft with at least one asset `published` and moves the channel pointer to it in one transaction, so a polling client never sees a pointer to a half-uploaded release. `channel` follows lode's id rule. Once published, the version's assets are immutable. Needs `write` access.",
      security: SECURITY.session,
      responses: { ...jsonOk(versionSchema), ...errors(401, 403, 404, 409, 422) },
    }),
    validator("param", versionParamSchema),
    validator("json", z.object({ channel: channelNameSchema })),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const { channel } = c.req.valid("json");
      const version = await publishVersion(c.get("db"), access.package.id, c.req.valid("param").ver, channel);
      await auditRelease(c, access, "registry.version.published", { type: "registry_version", id: version.id, name: `@${version.version}` }, { channel });
      return c.json({ success: true, data: versionView(version) });
    },
  );

  router.put(
    "/registry/packages/:ns/:pkg/channels/:channel",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Move a channel pointer",
      description: "Promotes a version to a channel or rolls the channel back, creating the channel when it does not exist. The target must be a published version: a draft or a yanked one answers 409. Needs `write` access.",
      security: SECURITY.session,
      responses: { ...jsonOk(channelSchema), ...errors(401, 403, 404, 409, 422) },
    }),
    validator("param", packageParamSchema.extend({ channel: channelNameSchema })),
    validator("json", z.object({ version: z.string() })),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const pointer = await setChannel(c.get("db"), access.package.id, c.req.valid("param").channel, c.req.valid("json").version);
      await auditRelease(c, access, "registry.channel.updated", { type: "registry_channel", id: `${access.package.id}/${pointer.name}`, name: `#${pointer.name}` }, { version: pointer.version });
      return c.json({ success: true, data: channelView(pointer) });
    },
  );

  router.post(
    "/registry/packages/:ns/:pkg/versions/:ver/yank",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Yank a published version",
      description: "Hides the version from the manifest without deleting anything. Refused with 409 while a channel points at it: move the pointer first. Needs `admin` access.",
      security: SECURITY.session,
      responses: { ...jsonOk(versionSchema), ...errors(401, 403, 404, 409) },
    }),
    validator("param", versionParamSchema),
    async (c) => {
      const access = await requirePackageAccess(c, "admin");
      const version = await yankVersion(c.get("db"), access.package.id, c.req.valid("param").ver);
      await auditRelease(c, access, "registry.version.yanked", { type: "registry_version", id: version.id, name: `@${version.version}` });
      return c.json({ success: true, data: versionView(version) });
    },
  );

  router.post(
    "/registry/packages/:ns/:pkg/versions/:ver/restore",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Restore a yanked version",
      description: "Puts a yanked version back among the published ones. Needs `admin` access.",
      security: SECURITY.session,
      responses: { ...jsonOk(versionSchema), ...errors(401, 403, 404, 409) },
    }),
    validator("param", versionParamSchema),
    async (c) => {
      const access = await requirePackageAccess(c, "admin");
      const version = await restoreVersion(c.get("db"), access.package.id, c.req.valid("param").ver);
      await auditRelease(c, access, "registry.version.restored", { type: "registry_version", id: version.id, name: `@${version.version}` });
      return c.json({ success: true, data: versionView(version) });
    },
  );

  // ─── Manifest signature ───

  // The package's manifest as the feed generates it now, without urls: what a signature is checked against.
  const currentManifest = async (c: Context<AppEnv>, access: PackageRequest) =>
    await buildManifest(c.get("db"), access.package, { maxVersions: c.get("config").REGISTRY_MANIFEST_MAX_VERSIONS, assetBase: "" });

  router.get(
    "/registry/packages/:ns/:pkg/manifest-signature",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "State of the package's manifest signature",
      description: "The publisher's signature over the manifest, or `null` when the package has none. `status` says whether it is served: `live` (attached to the manifest), `stale` (the catalog changed since it was made: sign again), `expired` (its `expires` has passed) or `revoked` (its key is no longer active). `expires` is Unix seconds. A token needs a `read` grant on the package.",
      security: SECURITY.session,
      responses: { ...jsonOk(manifestSignatureSchema.nullable()), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const db = c.get("db");
      const access = await requirePackageAccess(c, "read");
      const stored = await findManifestSignature(db, access.package.id);
      if (!stored)
        return c.json({ success: true, data: null });
      const status = await manifestSignatureStatus(db, stored, await currentManifest(c, access));
      return c.json({ success: true, data: { key_id: stored.keyId, expires: stored.expires, status, updated_at: stored.updatedAt } });
    },
  );

  router.put(
    "/registry/packages/:ns/:pkg/manifest-signature",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Sign the package's manifest",
      description: [
        "Stores the publisher's signature over the manifest the registry generates, replacing an earlier one: the `key_id`, `sig` and, when an expiry was stamped, `expires` and `expires_sig` that `lode-cli manifest-sign` writes into a downloaded `manifest.json`. The manifest then carries them, which is what a host with `[trust].require_manifest = \"signed\"` or `\"fresh\"` needs.",
        "`key_id` must be an active signing key of the package (400 `UNKNOWN_KEY`), an `expires` must lie in the future (400 `MANIFEST_EXPIRED`), and both signatures must verify over the manifest as it is now (409 `MANIFEST_CHANGED`: download it again and re-sign).",
        "The signature is served only while the manifest's catalog stays the same. Every publish, channel move, yank or restore makes it stale and the manifest unsigned until it is signed again. Needs `write` access.",
      ].join("\n\n"),
      security: SECURITY.session,
      responses: { ...jsonOk(manifestSignatureSchema), ...errors(400, 401, 403, 404, 409, 422) },
    }),
    validator("param", packageParamSchema),
    validator("json", manifestSignatureBodySchema),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const body = c.req.valid("json");
      const stored = await putManifestSignature(c.get("db"), access.package, await currentManifest(c, access), {
        keyId: body.key_id,
        sig: body.sig,
        expires: body.expires,
        expiresSig: body.expires_sig,
      });
      await auditRelease(c, access, "registry.manifest.signed", { type: "registry_package", id: access.package.id, name: "" }, { key_id: stored.keyId, expires: stored.expires });
      return c.json({ success: true, data: { key_id: stored.keyId, expires: stored.expires, status: "live" as const, updated_at: stored.updatedAt } });
    },
  );

  router.delete(
    "/registry/packages/:ns/:pkg/manifest-signature",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Remove the package's manifest signature",
      description: "The manifest is served unsigned again. Hosts with `require_manifest` set stop updating until it is signed anew; hosts on the default policy are unaffected. Needs `write` access.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ removed: z.boolean() })), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const removed = await deleteManifestSignature(c.get("db"), access.package.id);
      if (removed)
        await auditRelease(c, access, "registry.manifest.unsigned", { type: "registry_package", id: access.package.id, name: "" });
      return c.json({ success: true, data: { removed } });
    },
  );

  return router;
}
