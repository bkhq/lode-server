import { queryOptions } from "@tanstack/react-query";
import {
  adminGetUserQuota,
  adminListNamespaces,
  adminListPackages,
  adminListTokens,
  getDelegation,
  getManifestSignature,
  getNamespace,
  getPackage,
  getQuota,
  getRevocations,
  listCommits,
  listEvents,
  listInstances,
  listKeys,
  listPackages,
  listTokens,
  listVersions,
} from "./api";

// Keys nest, so invalidating a shorter key also invalidates what hangs
// below it: `packages()` covers every `package(ns, pkg)` and its versions,
// `adminTokens()` covers every per-user token list.
export const registryKeys = {
  all: ["registry"] as const,
  namespace: () => [...registryKeys.all, "namespace"] as const,
  quota: () => [...registryKeys.all, "quota"] as const,
  tokens: () => [...registryKeys.all, "tokens"] as const,
  packages: () => [...registryKeys.all, "packages"] as const,
  package: (ns: string, pkg: string) => [...registryKeys.packages(), ns, pkg] as const,
  versions: (ns: string, pkg: string) => [...registryKeys.package(ns, pkg), "versions"] as const,
  keys: (ns: string, pkg: string) => [...registryKeys.package(ns, pkg), "keys"] as const,
  commits: (ns: string, pkg: string) => [...registryKeys.package(ns, pkg), "commits"] as const,
  manifestSignature: (ns: string, pkg: string) => [...registryKeys.package(ns, pkg), "manifest-signature"] as const,
  delegation: (ns: string, pkg: string) => [...registryKeys.package(ns, pkg), "delegation"] as const,
  revocations: (ns: string, pkg: string) => [...registryKeys.package(ns, pkg), "revocations"] as const,
  instances: (ns: string, pkg: string) => [...registryKeys.package(ns, pkg), "instances"] as const,
  events: (ns: string, pkg: string) => [...registryKeys.package(ns, pkg), "events"] as const,
  admin: () => [...registryKeys.all, "admin"] as const,
  adminNamespaces: () => [...registryKeys.admin(), "namespaces"] as const,
  adminPackages: () => [...registryKeys.admin(), "packages"] as const,
  adminUserQuota: (userId: string) => [...registryKeys.admin(), "quota", userId] as const,
  adminTokens: (userId?: string) =>
    userId ? [...registryKeys.admin(), "tokens", userId] as const : [...registryKeys.admin(), "tokens"] as const,
};

export function namespaceQuery() {
  return queryOptions({ queryKey: registryKeys.namespace(), queryFn: getNamespace });
}

export function instancesQuery(ns: string, pkg: string) {
  return queryOptions({ queryKey: registryKeys.instances(ns, pkg), queryFn: () => listInstances(ns, pkg) });
}

export function eventsQuery(ns: string, pkg: string) {
  return queryOptions({ queryKey: registryKeys.events(ns, pkg), queryFn: () => listEvents(ns, pkg) });
}

export function keysQuery(ns: string, pkg: string) {
  return queryOptions({ queryKey: registryKeys.keys(ns, pkg), queryFn: () => listKeys(ns, pkg) });
}

export function commitsQuery(ns: string, pkg: string) {
  return queryOptions({ queryKey: registryKeys.commits(ns, pkg), queryFn: () => listCommits(ns, pkg) });
}

export function manifestSignatureQuery(ns: string, pkg: string) {
  return queryOptions({ queryKey: registryKeys.manifestSignature(ns, pkg), queryFn: () => getManifestSignature(ns, pkg) });
}

export function delegationQuery(ns: string, pkg: string) {
  return queryOptions({ queryKey: registryKeys.delegation(ns, pkg), queryFn: () => getDelegation(ns, pkg) });
}

export function revocationsQuery(ns: string, pkg: string) {
  return queryOptions({ queryKey: registryKeys.revocations(ns, pkg), queryFn: () => getRevocations(ns, pkg) });
}

export function packagesQuery() {
  return queryOptions({ queryKey: registryKeys.packages(), queryFn: listPackages });
}

export function packageQuery(ns: string, pkg: string) {
  return queryOptions({ queryKey: registryKeys.package(ns, pkg), queryFn: () => getPackage(ns, pkg) });
}

export function quotaQuery() {
  return queryOptions({ queryKey: registryKeys.quota(), queryFn: getQuota });
}

export function tokensQuery() {
  return queryOptions({ queryKey: registryKeys.tokens(), queryFn: listTokens });
}

export function versionsQuery(ns: string, pkg: string) {
  return queryOptions({ queryKey: registryKeys.versions(ns, pkg), queryFn: () => listVersions(ns, pkg) });
}

export function adminNamespacesQuery() {
  return queryOptions({ queryKey: registryKeys.adminNamespaces(), queryFn: adminListNamespaces });
}

export function adminPackagesQuery() {
  return queryOptions({ queryKey: registryKeys.adminPackages(), queryFn: adminListPackages });
}

export function adminUserQuotaQuery(userId: string) {
  return queryOptions({ queryKey: registryKeys.adminUserQuota(userId), queryFn: () => adminGetUserQuota(userId) });
}

export function adminTokensQuery(userId?: string) {
  return queryOptions({ queryKey: registryKeys.adminTokens(userId), queryFn: () => adminListTokens(userId) });
}
