import type {
  AdminNamespace,
  AdminPackage,
  Channel,
  CreatedToken,
  CreatePackageInput,
  CreateTokenInput,
  CreateVersionInput,
  Delegation,
  Grants,
  ManifestSignature,
  Namespace,
  Quota,
  QuotaOverride,
  RegisterKeyInput,
  RegistryPackage,
  RegistryToken,
  RevocationList,
  SigningKey,
  UpdatePackageInput,
  UserQuota,
  Version,
  VersionResponse,
  VersionsResponse,
} from "./types";
import { http } from "@/shared/lib/http";

// One function per registry endpoint. Each unwraps the `{ success, data }`
// envelope; failures surface as the `HttpError` thrown by `http()`.

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await http<{ data: T }>(`/registry${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.data;
}

const seg = encodeURIComponent;

function packagePath(ns: string, pkg: string): string {
  return `/packages/${seg(ns)}/${seg(pkg)}`;
}

function versionPath(ns: string, pkg: string, version: string): string {
  return `${packagePath(ns, pkg)}/versions/${seg(version)}`;
}

// ─── Namespace, quota ───

export async function getNamespace(): Promise<Namespace> {
  const data = await request<{ namespace: Namespace }>("/namespace");
  return data.namespace;
}

export function getQuota(): Promise<Quota> {
  return request("/quota");
}

// ─── Packages ───

export function listPackages(): Promise<RegistryPackage[]> {
  return request("/packages");
}

export function createPackage(input: CreatePackageInput): Promise<RegistryPackage> {
  return request("/packages", "POST", input);
}

export function getPackage(ns: string, pkg: string): Promise<RegistryPackage> {
  return request(packagePath(ns, pkg));
}

export function updatePackage(ns: string, pkg: string, input: UpdatePackageInput): Promise<RegistryPackage> {
  return request(packagePath(ns, pkg), "PATCH", input);
}

export function deletePackage(ns: string, pkg: string): Promise<{ id: string }> {
  return request(packagePath(ns, pkg), "DELETE");
}

// ─── Signing keys ───

export function listKeys(ns: string, pkg: string): Promise<SigningKey[]> {
  return request(`${packagePath(ns, pkg)}/keys`);
}

export function getManifestSignature(ns: string, pkg: string): Promise<ManifestSignature | null> {
  return request(`${packagePath(ns, pkg)}/manifest-signature`);
}

export function getDelegation(ns: string, pkg: string): Promise<Delegation | null> {
  return request(`${packagePath(ns, pkg)}/delegation`);
}

export function getRevocations(ns: string, pkg: string): Promise<RevocationList | null> {
  return request(`${packagePath(ns, pkg)}/revocations`);
}

export function registerKey(ns: string, pkg: string, input: RegisterKeyInput): Promise<SigningKey> {
  return request(`${packagePath(ns, pkg)}/keys`, "POST", input);
}

export function revokeKey(ns: string, pkg: string, id: string): Promise<SigningKey> {
  return request(`${packagePath(ns, pkg)}/keys/${seg(id)}`, "DELETE");
}

// ─── Tokens ───

export function listTokens(): Promise<RegistryToken[]> {
  return request("/tokens");
}

export function createToken(input: CreateTokenInput): Promise<CreatedToken> {
  return request("/tokens", "POST", input);
}

export function replaceTokenGrants(id: string, grants: Grants): Promise<RegistryToken> {
  return request(`/tokens/${seg(id)}`, "PUT", { grants });
}

export function revokeToken(id: string): Promise<{ id: string }> {
  return request(`/tokens/${seg(id)}`, "DELETE");
}

// ─── Versions and channels ───

export function listVersions(ns: string, pkg: string): Promise<VersionsResponse> {
  return request(`${packagePath(ns, pkg)}/versions`);
}

export function createVersion(ns: string, pkg: string, input: CreateVersionInput): Promise<Version> {
  return request(`${packagePath(ns, pkg)}/versions`, "POST", input);
}

export function getVersion(ns: string, pkg: string, version: string): Promise<VersionResponse> {
  return request(versionPath(ns, pkg, version));
}

export function deleteVersion(ns: string, pkg: string, version: string): Promise<{ id: string }> {
  return request(versionPath(ns, pkg, version), "DELETE");
}

export function publishVersion(ns: string, pkg: string, version: string, channel: string): Promise<Version> {
  return request(`${versionPath(ns, pkg, version)}/publish`, "POST", { channel });
}

export function setChannel(ns: string, pkg: string, channel: string, version: string): Promise<Channel> {
  return request(`${packagePath(ns, pkg)}/channels/${seg(channel)}`, "PUT", { version });
}

export function yankVersion(ns: string, pkg: string, version: string): Promise<Version> {
  return request(`${versionPath(ns, pkg, version)}/yank`, "POST");
}

export function restoreVersion(ns: string, pkg: string, version: string): Promise<Version> {
  return request(`${versionPath(ns, pkg, version)}/restore`, "POST");
}

// ─── Administration ───

export function adminListNamespaces(): Promise<AdminNamespace[]> {
  return request("/admin/namespaces");
}

export function adminSuspendNamespace(slug: string): Promise<Namespace> {
  return request(`/admin/namespaces/${seg(slug)}/suspend`, "POST");
}

export function adminRestoreNamespace(slug: string): Promise<Namespace> {
  return request(`/admin/namespaces/${seg(slug)}/restore`, "POST");
}

export function adminListPackages(): Promise<AdminPackage[]> {
  return request("/admin/packages");
}

export function adminGetUserQuota(userId: string): Promise<UserQuota> {
  return request(`/admin/users/${seg(userId)}/quota`);
}

/** Replaces the whole override: a limit left out is cleared like a null. */
export function adminSetUserQuota(userId: string, override: Partial<QuotaOverride>): Promise<UserQuota> {
  return request(`/admin/users/${seg(userId)}/quota`, "PUT", override);
}

export function adminListTokens(userId?: string): Promise<RegistryToken[]> {
  return request(`/admin/tokens${userId ? `?user_id=${seg(userId)}` : ""}`);
}

export function adminRevokeToken(id: string): Promise<{ id: string }> {
  return request(`/admin/tokens/${seg(id)}`, "DELETE");
}
