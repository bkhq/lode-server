import type { Delegation, RevocationList } from "./delegation.service";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { describeRoute, errors, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { requirePackageAccess } from "./access";
import {
  delegationStatus,
  deleteDelegation,
  findDelegation,
  findRevocationList,
  putDelegation,
  putRevocationList,
} from "./delegation.service";
import { assetNameSchema, auditRelease, versionParamSchema } from "./release.routes";
import { resignAsset } from "./release.service";
import { assetSchema, assetView } from "./wire";

// ─── Request schemas ───

const RE_KEY_ID = /^[0-9a-f]{16}$/;
const keyIdSchema = z.string().regex(RE_KEY_ID, "a key id is 16 lowercase hex characters");
const unixSecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// The JSON `lode-cli delegate` writes.
const delegationBodySchema = z.strictObject({
  key: z.string().min(1).max(512),
  name: z.string().min(1).max(128),
  not_before: unixSecondsSchema,
  not_after: unixSecondsSchema,
  issuer: z.string().max(64).optional(),
  sig: z.string().min(1).max(512),
});

// The JSON `lode-cli revoke` writes.
const revocationListBodySchema = z.strictObject({
  schema: z.literal("lode-revocations/v1"),
  issued_at: unixSecondsSchema,
  revoked: z.array(keyIdSchema).max(1000),
  key_id: keyIdSchema,
  delegation: delegationBodySchema.optional(),
  sig: z.string().min(1).max(512),
});

const packageParamSchema = z.object({ ns: z.string(), pkg: z.string() });

// ─── Response schemas ───

const delegationSchema = z.object({
  key_id: z.string(),
  root_key_id: z.string(),
  issuer: z.string().nullable(),
  not_before: z.number(),
  not_after: z.number(),
  status: z.enum(["live", "pending", "expired", "revoked"]),
  updated_at: z.string(),
});

const revocationListSchema = z.object({
  issued_at: z.number(),
  revoked: z.array(z.string()),
  key_id: z.string(),
  updated_at: z.string(),
});

function delegationView(delegation: Delegation, status: z.infer<typeof delegationSchema>["status"]): z.infer<typeof delegationSchema> {
  return {
    key_id: delegation.keyId,
    root_key_id: delegation.rootKeyId,
    issuer: delegation.issuer,
    not_before: delegation.notBefore,
    not_after: delegation.notAfter,
    status,
    updated_at: delegation.updatedAt,
  };
}

function revocationListView(list: RevocationList): z.infer<typeof revocationListSchema> {
  return { issued_at: list.issuedAt, revoked: JSON.parse(list.revoked) as string[], key_id: list.keyId, updated_at: list.updatedAt };
}

const PACKAGE_RESOURCE = { type: "registry_package", name: "" };

/**
 * lode's delegated signing on a package: its delegation, its revocation list,
 * and replacing the signature of an asset after a sub-key changes. Mounted
 * by `registryRoutes` behind its `authRequired`; the `packages:write` scope
 * in `index.ts` lists the mutations.
 */
export function registryDelegationRoutes() {
  const router = new Hono<AppEnv>();

  // ─── Delegation ───

  router.get(
    "/registry/packages/:ns/:pkg/delegation",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "State of the package's delegation",
      description: "The delegation that lets a sub-key sign for the package, or `null`. `key_id` is the sub-key, `root_key_id` the registered key whose signature it carries; `not_before` / `not_after` are Unix seconds. `status`: `live` (served in the manifest; the sub-key signs like a registered key), `pending` (its window has not started), `expired` (its window has passed) or `revoked` (its root key was revoked, or the revocation list names the sub-key). A token needs a `read` grant on the package.",
      security: SECURITY.session,
      responses: { ...jsonOk(delegationSchema.nullable()), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const db = c.get("db");
      const { package: pkg } = await requirePackageAccess(c, "read");
      const stored = await findDelegation(db, pkg.id);
      return c.json({ success: true, data: stored ? delegationView(stored, await delegationStatus(db, stored)) : null });
    },
  );

  router.put(
    "/registry/packages/:ns/:pkg/delegation",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Set the package's delegation",
      description: [
        "Stores the delegation `lode-cli delegate --app <slug>` writes, replacing an earlier one. While it is live the manifest carries it as `delegation`, and the registry accepts the sub-key's signatures on uploads, on the manifest and on re-signed assets. Hosts on lode 0.1.0 or later that trust the root key then accept them too; older hosts refuse sub-key signatures.",
        "Refused with 400 `INVALID_DELEGATION` when `name` is not the package slug, the key is not ed25519 or no active signing key of the package made the signature; 400 `DELEGATION_EXPIRED` when `not_after` has passed; 400 `KEY_REVOKED` when the revocation list names the sub-key; 409 `KEY_REGISTERED` when the sub-key is, or was, a registered key of the package. Needs `write` access.",
      ].join("\n\n"),
      security: SECURITY.session,
      responses: { ...jsonOk(delegationSchema), ...errors(400, 401, 403, 404, 409, 422) },
    }),
    validator("param", packageParamSchema),
    validator("json", delegationBodySchema),
    async (c) => {
      const db = c.get("db");
      const access = await requirePackageAccess(c, "write");
      const stored = await putDelegation(db, access.package, c.req.valid("json"));
      await auditRelease(c, access, "registry.delegation.set", { ...PACKAGE_RESOURCE, id: access.package.id }, {
        key_id: stored.keyId,
        root_key_id: stored.rootKeyId,
        not_after: stored.notAfter,
      });
      return c.json({ success: true, data: delegationView(stored, await delegationStatus(db, stored)) });
    },
  );

  router.delete(
    "/registry/packages/:ns/:pkg/delegation",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Remove the package's delegation",
      description: "The manifest no longer carries it and the sub-key's signatures stop verifying, here and on hosts: assets and a manifest signature it made fail under `require_signature = \"enforce\"` until re-signed. Needs `write` access.",
      security: SECURITY.session,
      responses: { ...jsonOk(z.object({ removed: z.boolean() })), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const removed = await deleteDelegation(c.get("db"), access.package.id);
      if (removed)
        await auditRelease(c, access, "registry.delegation.removed", { ...PACKAGE_RESOURCE, id: access.package.id });
      return c.json({ success: true, data: { removed } });
    },
  );

  // ─── Revocation list ───

  router.get(
    "/registry/packages/:ns/:pkg/revocations",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "The package's revocation list",
      description: "The revoked sub-key ids, with the list's `issued_at` (Unix seconds) and signer, or `null`. Hosts read the signed list itself from the feed, `/r/:ns/:pkg/revocations.json`. A token needs a `read` grant on the package.",
      security: SECURITY.session,
      responses: { ...jsonOk(revocationListSchema.nullable()), ...errors(401, 403, 404) },
    }),
    validator("param", packageParamSchema),
    async (c) => {
      const { package: pkg } = await requirePackageAccess(c, "read");
      const stored = await findRevocationList(c.get("db"), pkg.id);
      return c.json({ success: true, data: stored ? revocationListView(stored) : null });
    },
  );

  router.put(
    "/registry/packages/:ns/:pkg/revocations",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Publish the package's revocation list",
      description: [
        "Stores the list `lode-cli revoke` writes and serves it at `/r/:ns/:pkg/revocations.json`, the URL a host sets as `[trust].revocation_url`. A sub-key it names stops verifying here at once, and the package's delegation for it is no longer served.",
        "It must be signed by an active registered key, or by a sub-key with its own valid `delegation` for the package slug that the stored list does not revoke (400 `INVALID_SIGNATURE`). Hosts keep every id they have seen and ignore a list not newer than theirs, so a list must be issued after the stored one (409 `REVOCATIONS_OUTDATED`), not more than an hour ahead of the server's clock (400 `REVOCATIONS_FUTURE`), and keep every stored id (400 `REVOCATIONS_SHRINK`). Ids are key ids, 16 lowercase hex characters. There is no way to remove a list. Needs `write` access.",
      ].join("\n\n"),
      security: SECURITY.session,
      responses: { ...jsonOk(revocationListSchema), ...errors(400, 401, 403, 404, 409, 422) },
    }),
    validator("param", packageParamSchema),
    validator("json", revocationListBodySchema),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const stored = await putRevocationList(c.get("db"), access.package, c.req.valid("json"));
      await auditRelease(c, access, "registry.revocations.published", { ...PACKAGE_RESOURCE, id: access.package.id }, {
        issued_at: stored.issuedAt,
        key_id: stored.keyId,
        revoked: JSON.parse(stored.revoked) as string[],
      });
      return c.json({ success: true, data: revocationListView(stored) });
    },
  );

  // ─── Asset re-sign ───

  router.put(
    "/registry/packages/:ns/:pkg/versions/:ver/assets/:asset/signature",
    describeRoute({
      tags: [TAGS.Registry],
      summary: "Replace an asset's signature",
      description: [
        "Sets a new `lode.artifact.v2` signature on an asset of a version in any state, published and yanked ones included: what keeps older versions installable under `enforce` after the package moves to another sub-key or root. `sig` is base64url (or standard base64) as `lode-cli sign --app <slug> --version <ver>` prints it.",
        "It is verified like an upload's, over the package slug, the asset name, the version and the asset's stored `sha256`, `run` and `exec`, under an active registered key or the sub-key of the live delegation (400 `INVALID_SIGNATURE`). The bytes and the manifest's catalog do not change, so a manifest signature stays live. Needs `write` access.",
      ].join("\n\n"),
      security: SECURITY.session,
      responses: { ...jsonOk(assetSchema), ...errors(400, 401, 403, 404, 409, 422) },
    }),
    validator("param", versionParamSchema.extend({ asset: assetNameSchema })),
    validator("json", z.strictObject({ sig: z.string().trim().min(1).max(512) })),
    async (c) => {
      const access = await requirePackageAccess(c, "write");
      const { ver, asset: name } = c.req.valid("param");
      const { asset, previousKeyId } = await resignAsset(c.get("db"), access.package, ver, name, c.req.valid("json").sig);
      await auditRelease(c, access, "registry.asset.resigned", { type: "registry_asset", id: asset.id, name: `@${ver}/${asset.name}` }, {
        key_id: asset.keyId,
        previous_key_id: previousKeyId,
      });
      return c.json({ success: true, data: assetView(asset) });
    },
  );

  return router;
}
