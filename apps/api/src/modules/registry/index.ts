import { registerBackupContribution } from "@/modules/backup/registry";
import { registerNamespace } from "@/modules/policy";
import { registerTokenScope } from "@/shared/lib/token-scopes";
import { registryBackupContribution } from "./registry.backup";

export { packageAccess, requirePackageAccess, resolveReadToken } from "./access";
export type { GrantLevel, PackageAccessLevel, PackageRequest, ResolvedPackage } from "./access";
export { READ_FEED_PREFIX, registryFeedRoutes } from "./feed.routes";
export { startObserveRetentionSweep, stopObserveRetentionSweep } from "./observe.retention";
export { registryRoutes } from "./registry.routes";
export { assertUploadAllowed, getEffectiveQuota, getUsage } from "./registry.service";
export { startRegistryUploadSweep, stopRegistryUploadSweep } from "./upload.sweep";

// The access ladder of a package: an owner is a maintainer, a maintainer is
// a reader. Only `owner` is granted so far (at package creation).
registerNamespace({
  name: "package",
  relations: {
    owner: { union: [{ this: {} }] },
    maintainer: { union: [{ this: {} }, { computed_userset: { relation: "owner" } }] },
    reader: { union: [{ this: {} }, { computed_userset: { relation: "maintainer" } }] },
  },
});

registerBackupContribution(registryBackupContribution);

// What a personal API token may call. The scopes are derived from a token's
// package grants when it is saved (see token.service.ts); which packages it
// reaches is decided per request by `requirePackageAccess`. The release routes
// are listed ahead of their implementation so the table is complete.
//
// Deliberately in no scope, and so session only whatever the grants: creating
// and deleting packages, revoking signing keys, token management, the
// namespace, the quota and everything under /registry/admin.
registerTokenScope({
  name: "packages:read",
  description: "Read the metadata of packages the token has a grant on",
  routes: [
    { method: "GET", path: "/registry/packages" },
    { method: "GET", path: "/registry/packages/:ns/:pkg" },
    { method: "GET", path: "/registry/packages/:ns/:pkg/*" },
  ],
});

registerTokenScope({
  name: "packages:write",
  description: "Release to packages the token has a write grant on: drafts, uploads, publish, channels; register signing keys, sign the manifest, delegate and revoke sub-keys",
  routes: [
    { method: "POST", path: "/registry/packages/:ns/:pkg/versions" },
    { method: "PUT", path: "/registry/packages/:ns/:pkg/versions/:ver/assets/:asset" },
    { method: "DELETE", path: "/registry/packages/:ns/:pkg/versions/:ver/assets/:asset" },
    { method: "POST", path: "/registry/packages/:ns/:pkg/versions/:ver/uploads" },
    { method: "PUT", path: "/registry/uploads/:uploadId/parts/:n" },
    { method: "POST", path: "/registry/uploads/:uploadId/complete" },
    { method: "DELETE", path: "/registry/uploads/:uploadId" },
    { method: "POST", path: "/registry/packages/:ns/:pkg/versions/:ver/publish" },
    { method: "POST", path: "/registry/packages/:ns/:pkg/commits" },
    { method: "PUT", path: "/registry/packages/:ns/:pkg/channels/:channel" },
    { method: "DELETE", path: "/registry/packages/:ns/:pkg/versions/:ver" },
    // A release pipeline registers the public half of its signing key itself.
    { method: "POST", path: "/registry/packages/:ns/:pkg/keys" },
    // And signs the manifest after each release step.
    { method: "PUT", path: "/registry/packages/:ns/:pkg/manifest-signature" },
    { method: "DELETE", path: "/registry/packages/:ns/:pkg/manifest-signature" },
    // Delegated signing: the delegation, the revocation list, re-signed assets.
    { method: "PUT", path: "/registry/packages/:ns/:pkg/delegation" },
    { method: "DELETE", path: "/registry/packages/:ns/:pkg/delegation" },
    { method: "PUT", path: "/registry/packages/:ns/:pkg/revocations" },
    { method: "PUT", path: "/registry/packages/:ns/:pkg/versions/:ver/assets/:asset/signature" },
  ],
});

registerTokenScope({
  name: "packages:admin",
  description: "Manage packages the token has an admin grant on: settings, yank and restore",
  routes: [
    { method: "PATCH", path: "/registry/packages/:ns/:pkg" },
    { method: "POST", path: "/registry/packages/:ns/:pkg/versions/:ver/yank" },
    { method: "POST", path: "/registry/packages/:ns/:pkg/versions/:ver/restore" },
  ],
});
