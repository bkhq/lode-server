import { registerBackupContribution } from "@/modules/backup/registry";
import { policyBackupContribution } from "./policy.backup";

export { policyContext, policyMiddleware, requirePermission } from "./middleware";
export { registerNamespace } from "./namespace-config";
export type { NamespaceConfig } from "./namespace-config";
export { createPermissionCache, defineResource, ResourceAccess } from "./permission";
export { NOOP_POLICY_LOGGER } from "./policy-logger";
export { policyRoutes } from "./policy.routes";
export {
  __resetResourceRegistryForTests,
  getAllResources,
  getPermissionManifest,
  getResource,
  groupSubject,
  registerResource,
  userSubject,
} from "./registry";
export type {
  EntityDescriptor,
  GrantParams,
  PermissionCache,
  PolicyActor,
  PolicyContext,
  PolicyRequest,
  ResourceDefinition,
  ResourceHooks,
  ResourceManifestEntry,
  Subject,
  TupleKey,
} from "./registry";
export {
  __resetRouteBindingsForTests,
  getAllRouteBindings,
  getRouteBindingsForResource,
} from "./route-registry";
export type { HttpMethod, RouteBinding } from "./route-registry";

registerBackupContribution(policyBackupContribution);
