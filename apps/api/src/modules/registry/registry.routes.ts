import type { Context } from "hono";
import type { RegistryNamespace } from "./access";
import type { RegistryKey } from "./key.service";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import { policyContext } from "@/modules/policy";
import { getPlatform } from "@/platform";
import { describeRoute, errors, jsonCreated, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { authRequired } from "@/shared/middleware/auth";
import { listGrantedPackages, requestToken, requirePackageAccess } from "./access";
import { registryAdminRoutes } from "./admin.routes";
import { getActiveBlobStore } from "./blob";
import { registryDelegationRoutes } from "./delegation.routes";
import { listKeys, registerKey, revokeKey } from "./key.service";
import {
  createPackage,
  deletePackage,
  ensureNamespace,
  getEffectiveQuota,
  getNamespaceForUser,
  getUsage,
  listPackagesInNamespace,
  updatePackage,
} from "./registry.service";
import { discardUnreadBody, registryReleaseRoutes, UPLOAD_ROUTE } from "./release.routes";
import { registryTokenRoutes } from "./token.routes";
import { registryUploadRoutes, UPLOAD_PART_ROUTE } from "./upload.routes";
import { displayNameError, packageSlugError } from "./validate";
import { auditMeta, check, limitsSchema, limitsView, namespaceSchema, namespaceView, packageSchema, packageView, usageSchema, usageView } from "./wire";

const keySchema = z.object({
  id: z.string(),
  key_id: z.string(),
  alg: z.literal("ed25519"),
  public_key: z.string(),
  name: z.string(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

function keyView(key: RegistryKey): z.infer<typeof keySchema> {
  return {
    id: key.id,
    key_id: key.keyId,
    alg: key.alg,
    public_key: key.publicKey,
    name: key.name,
    revoked_at: key.revokedAt,
    created_at: key.createdAt,
  };
}

// ─── Request schemas ───

const packageSlugSchema = z.string().superRefine(check(packageSlugError));
const displayNameSchema = z.string().trim().superRefine(check(displayNameError));

const registerKeySchema = z.object({
  // Parsed by the service, which answers 400 for anything but an ed25519 key.
  public_key: z.string().min(1).max(512),
  name: z.string().trim().min(1).max(100),
});

const visibilitySchema = z.enum(["public", "private"]);
const descriptionSchema = z.string().max(2000);

const createPackageSchema = z.object({
  slug: packageSlugSchema,
  name: displayNameSchema,
  visibility: visibilitySchema.optional(),
  description: descriptionSchema.optional(),
  require_signature: z.boolean().optional(),
});

// Strict, so a `slug` in the body is refused instead of silently dropped.
const updatePackageSchema = z.strictObject({
  name: displayNameSchema.optional(),
  visibility: visibilitySchema.optional(),
  description: descriptionSchema.nullable().optional(),
  require_signature: z.boolean().optional(),
}).refine(body => Object.keys(body).length > 0, "Nothing to update");

const packageParamSchema = z.object({ ns: z.string(), pkg: z.string() });

async function auditNamespaceAssigned(c: Context<AppEnv>, namespace: RegistryNamespace): Promise<void> {
  await audit(c.get("db"), c.get("logger"), {
    ...auditMeta(c),
    action: "registry.namespace.assigned",
    resourceType: "registry_namespace",
    resourceId: namespace.id,
    resourceName: namespace.slug,
  });
}

/**
 * Management API of the registry, under `/api/registry`. A signed-in session
 * reaches every route. A personal API token reaches only the routes the
 * `packages:*` scopes list (see `index.ts`), and there only the packages its
 * grants cover.
 *
 * The `/registry/packages/:ns/:pkg` routes are also bound in `access.ts`, so
 * the global policy middleware has already checked the caller against the
 * package before a handler runs; `requirePackageAccess` resolves the package
 * and repeats the check for the level the handler needs.
 */
export function registryRoutes() {
  // Fail the boot, not the first upload, when the configured blob store was
  // never registered (`r2` without the PACKAGES bucket binding). The local
  // store needs no registration and is created from the resolved
  // configuration on first use.
  const driver = getPlatform().env.get("REGISTRY_BLOB_DRIVER") ?? "local";
  if (driver !== "local")
    getActiveBlobStore({ REGISTRY_BLOB_DRIVER: driver, REGISTRY_BLOB_LOCAL_ROOT: "" });

  const router = new Hono<AppEnv>();
  // Ahead of the auth guard, so a request it refuses has its body discarded too.
  router.use(UPLOAD_ROUTE, discardUnreadBody);
  router.use(UPLOAD_PART_ROUTE, discardUnreadBody);
  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/registry/*", authRequired);

  // ─── Namespace ───

  router.get(
    "/registry/namespace",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Get my namespace",
      description: "The caller's namespace. It is assigned by the system on the first call (or with the first package) and never changes; `slug` is its id, the `:ns` segment of every package path. Session only.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ namespace: namespaceSchema })), ...errors(401, 403) },
    }),
    async (c) => {
      const { namespace, assigned } = await ensureNamespace(c.get("db"), c.get("user")!.id);
      if (assigned)
        await auditNamespaceAssigned(c, namespace);
      return c.json({ success: true, data: { namespace: namespaceView(namespace) } });
    },
  );

  // ─── Packages ───

  router.get(
    "/registry/packages",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "List my packages",
      description: "The packages in the caller's namespace. With an API token: the packages the token has a grant on.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.array(packageSchema)), ...errors(401, 403) },
    }),
    async (c) => {
      const db = c.get("db");
      const token = await requestToken(c);
      if (token) {
        const granted = await listGrantedPackages(db, token);
        return c.json({ success: true, data: granted.map(g => packageView(g.namespace, g.package)) });
      }
      const namespace = await getNamespaceForUser(db, c.get("user")!.id);
      const packages = namespace ? await listPackagesInNamespace(db, namespace.id) : [];
      return c.json({ success: true, data: packages.map(pkg => packageView(namespace!, pkg)) });
    },
  );

  router.post(
    "/registry/packages",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Create a package",
      description: "Creates a package in the caller's namespace, within their package quota; the namespace is assigned first when the caller has none. `slug` (lowercase letters, digits and `-`, not starting with `-`, unique within the namespace) is the permanent `:pkg` path segment; `name` is a free-text display name.",
      security: SECURITY.session,
      responses: { ...jsonCreated(packageSchema), ...errors(401, 403, 409, 422) },
    }),
    validator("json", createPackageSchema),
    async (c) => {
      const body = c.req.valid("json");
      const created = await createPackage(policyContext(c)!, c.get("config"), {
        slug: body.slug,
        name: body.name,
        visibility: body.visibility,
        description: body.description,
        requireSignature: body.require_signature,
      });
      if (created.namespaceAssigned)
        await auditNamespaceAssigned(c, created.namespace);
      await audit(c.get("db"), c.get("logger"), {
        ...auditMeta(c),
        action: "registry.package.created",
        resourceType: "package",
        resourceId: created.package.id,
        resourceName: `${created.namespace.slug}/${created.package.slug}`,
        detail: { owner_user_id: created.namespace.ownerUserId, name: created.package.name, visibility: created.package.visibility },
      });
      return c.json({ success: true, data: packageView(created.namespace, created.package) }, 201);
    },
  );

  router.get(
    "/registry/packages/:ns/:pkg",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Get a package",
      description: "Package metadata. A public package is readable by every signed-in user; a private one the caller cannot read answers 404. A token needs a `read` grant on the package.",
      security: SECURITY.session,
      responses: { ...jsonOk(packageSchema), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const { namespace, package: pkg } = await requirePackageAccess(c, "read");
      return c.json({ success: true, data: packageView(namespace, pkg) });
    },
  );

  router.patch(
    "/registry/packages/:ns/:pkg",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Update a package",
      description: "Changes the display name, visibility, description or `require_signature`. The slug is permanent. For the owner, an administrator, or a token with an `admin` grant on the package.",
      security: SECURITY.session,
      responses: { ...jsonOk(packageSchema), ...errors(401, 403, 404, 422) },
    }),
    validator("param", packageParamSchema),
    validator("json", updatePackageSchema),
    async (c) => {
      const db = c.get("db");
      const { namespace, package: pkg, tokenId } = await requirePackageAccess(c, "admin");
      const body = c.req.valid("json");
      const updated = await updatePackage(db, pkg.id, {
        name: body.name,
        visibility: body.visibility,
        description: body.description,
        requireSignature: body.require_signature,
      });
      await audit(db, c.get("logger"), {
        ...auditMeta(c),
        action: "registry.package.updated",
        resourceType: "package",
        resourceId: pkg.id,
        resourceName: `${namespace.slug}/${pkg.slug}`,
        detail: { owner_user_id: namespace.ownerUserId, changes: body, ...(tokenId !== null && { token_id: tokenId }) },
      });
      return c.json({ success: true, data: packageView(namespace, updated) });
    },
  );

  router.delete(
    "/registry/packages/:ns/:pkg",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Delete a package",
      description: "Removes the package with its versions, assets, channels, uploads and token grants. For the owner or an administrator, with a session: never open to a token.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ id: z.string() })), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const db = c.get("db");
      const { namespace, package: pkg } = await requirePackageAccess(c, "owner");
      await deletePackage(db, pkg.id, c.get("config"));
      await audit(db, c.get("logger"), {
        ...auditMeta(c),
        action: "registry.package.deleted",
        resourceType: "package",
        resourceId: pkg.id,
        resourceName: `${namespace.slug}/${pkg.slug}`,
        detail: { owner_user_id: namespace.ownerUserId },
      });
      return c.json({ success: true, data: { id: pkg.id } });
    },
  );

  // ─── Signing keys ───

  router.get(
    "/registry/packages/:ns/:pkg/keys",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "List a package's signing keys",
      description: "The public keys upload signatures of this package are checked against. Revoked keys are listed too, with `revoked_at` set. For anyone who can read the package: the keys are public, and an operator pins one in `trusted_keys`.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.array(keySchema)), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const { package: pkg } = await requirePackageAccess(c, "read");
      const keys = await listKeys(c.get("db"), pkg.id);
      return c.json({ success: true, data: keys.map(keyView) });
    },
  );

  router.post(
    "/registry/packages/:ns/:pkg/keys",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Register a signing key for a package",
      description: "Takes a raw 32-byte ed25519 public key as base64url or standard base64, optionally in lode's `[ed25519:][<key_id>:]<key>` forms; `key_id` is derived by the server. For the owner, an administrator, or a token with a write grant on the package, so a release pipeline can register its own key: 409 `KEY_EXISTS` then means it is already there. A revoked key cannot be registered again.",
      security: SECURITY.session,
      responses: { ...jsonCreated(keySchema), ...errors(400, 401, 403, 404, 409, 422) },
    }),
    validator("param", packageParamSchema),
    validator("json", registerKeySchema),
    async (c) => {
      const db = c.get("db");
      const { namespace, package: pkg, tokenId } = await requirePackageAccess(c, "write");
      const body = c.req.valid("json");
      const key = await registerKey(db, pkg.id, { publicKey: body.public_key, name: body.name });
      await audit(db, c.get("logger"), {
        ...auditMeta(c),
        action: "registry.key.registered",
        resourceType: "registry_key",
        resourceId: key.id,
        resourceName: key.keyId,
        detail: { package: `${namespace.slug}/${pkg.slug}`, name: key.name, alg: key.alg, ...(tokenId !== null && { token_id: tokenId }) },
      });
      return c.json({ success: true, data: keyView(key) }, 201);
    },
  );

  router.delete(
    "/registry/packages/:ns/:pkg/keys/:id",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Revoke a package's signing key",
      description: "Sets `revoked_at`; the key stays listed and its id cannot be registered for this package again. For the owner or an administrator, with a session: never open to a token.",
      security: SECURITY.session,
      responses: { ...jsonOk(keySchema), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema.extend({ id: z.string() })),
    async (c) => {
      const db = c.get("db");
      const { namespace, package: pkg } = await requirePackageAccess(c, "owner");
      const { key, changed } = await revokeKey(db, pkg.id, c.req.valid("param").id);
      if (changed) {
        await audit(db, c.get("logger"), {
          ...auditMeta(c),
          action: "registry.key.revoked",
          resourceType: "registry_key",
          resourceId: key.id,
          resourceName: key.keyId,
          detail: { package: `${namespace.slug}/${pkg.slug}`, name: key.name },
        });
      }
      return c.json({ success: true, data: keyView(key) });
    },
  );

  // ─── Quota ───

  router.get(
    "/registry/quota",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Get my quota and usage",
      description: "The limits that apply to the caller and what they hold against them. Storage counts stored assets plus the declared sizes of uploads in flight. Session only.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ limits: limitsSchema, usage: usageSchema })), ...errors(401, 403) },
    }),
    async (c) => {
      const db = c.get("db");
      const userId = c.get("user")!.id;
      return c.json({
        success: true,
        data: {
          limits: limitsView(await getEffectiveQuota(db, userId, c.get("config"))),
          usage: usageView(await getUsage(db, userId)),
        },
      });
    },
  );

  router.route("/", registryReleaseRoutes());
  router.route("/", registryDelegationRoutes());
  router.route("/", registryUploadRoutes());
  router.route("/", registryTokenRoutes());
  router.route("/", registryAdminRoutes());

  return router;
}
