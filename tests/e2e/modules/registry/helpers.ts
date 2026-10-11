import type { ApiClient } from "../../lib/api";
import { Buffer } from "node:buffer";
import { API_BASE } from "../../lib/api";

// Shared by the registry suites: thin wrappers over the management API under
// `/api/registry` and the read feed under `/r`, so a suite reads as the
// release flow it exercises.

export interface Envelope<T> { success: boolean; data: T }
export interface ErrorBody { success: false; error: { code: string; message: string } }

export interface PackageView {
  id: string;
  namespace: string;
  slug: string;
  name: string;
  visibility: "public" | "private";
  description: string | null;
  require_signature: boolean;
}

export interface AssetView {
  name: string;
  size: number;
  sha256: string;
  sig: string | null;
  key_id: string | null;
  alg: string | null;
  run: string | null;
  exec: string | null;
}

export interface VersionView {
  id: string;
  version: string;
  status: "draft" | "published" | "yanked";
  notes: string | null;
  assets: AssetView[];
}

export interface TokenView {
  id: string;
  name: string;
  grants: { all: string } | { package: string; access: string }[];
  token: string;
}

export type Grants = { all: "read" | "write" | "admin" } | { package: string; access: "read" | "write" | "admin" }[];

export interface ManifestAsset {
  name: string;
  url: string;
  sha256: string;
  size: number;
  sig?: string;
  key_id?: string;
  alg?: string;
  run?: string;
  exec?: string;
}

export interface Manifest {
  schema: string;
  name: string;
  channels: Record<string, { latest: string }>;
  versions: Record<string, { notes?: string; assets: ManifestAsset[] }>;
}

/** The read feed is mounted next to `/api`, below the same base path. */
// The read feed is at the origin root, outside the API's base path.
export const FEED_BASE = `${new URL(API_BASE).origin}/r`;

let counter = 0;

/** A package slug no earlier run or suite has used. */
export function uniqueSlug(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)).toString("hex");
}

export function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** The error code of a refused request, next to its status. */
export async function refusal(res: Response): Promise<{ status: number; code: string | undefined }> {
  const body = await res.json().catch(() => ({})) as Partial<ErrorBody>;
  return { status: res.status, code: body.error?.code };
}

/**
 * A token request the way CI or an operator host sends it: the bearer header
 * only, no cookie, no CSRF header, no Origin.
 */
export async function withToken(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(typeof init.body === "string" && { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
}

/** Either a signed-in session or a bare token secret. */
export type Caller = ApiClient | string;

/** Send a request with a raw (non-JSON) body as `caller`. `fetch` sets `Content-Length` from the bytes. */
export async function send(caller: Caller, method: string, path: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  if (typeof caller === "string")
    return await withToken(caller, path, { method, body, headers });
  return await fetch(`${API_BASE}${path}`, {
    method,
    body,
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Origin": new URL(API_BASE).origin,
      "Cookie": caller.cookies.header(),
      ...headers,
    },
  });
}

async function sendJson(caller: Caller, method: string, path: string, body: unknown): Promise<Response> {
  return await send(caller, method, path, JSON.stringify(body), { "Content-Type": "application/json" });
}

async function data<T>(res: Response, what: string): Promise<T> {
  if (!res.ok)
    throw new Error(`${what} -> ${res.status}: ${await res.text()}`);
  return ((await res.json()) as Envelope<T>).data;
}

export async function namespaceOf(client: ApiClient): Promise<string> {
  const res = await client.json<Envelope<{ namespace: { slug: string } }>>("/api/registry/namespace");
  return res.data.namespace.slug;
}

export async function createPackage(
  client: ApiClient,
  input: { slug?: string; name?: string; visibility?: "public" | "private"; require_signature?: boolean } = {},
): Promise<PackageView> {
  const slug = input.slug ?? uniqueSlug("pkg");
  const res = await client.json<Envelope<PackageView>>("/api/registry/packages", {
    method: "POST",
    body: { name: `E2E ${slug}`, ...input, slug },
  });
  return res.data;
}

export function packagePath(pkg: Pick<PackageView, "namespace" | "slug">): string {
  return `/api/registry/packages/${pkg.namespace}/${pkg.slug}`;
}

export async function createToken(client: ApiClient, grants: Grants): Promise<TokenView> {
  const res = await client.json<Envelope<TokenView>>("/api/registry/tokens", {
    method: "POST",
    body: { name: uniqueSlug("e2e-token"), grants },
  });
  return res.data;
}

export async function createDraft(caller: Caller, pkg: PackageView, version: string, notes?: string): Promise<VersionView> {
  return await data(await sendJson(caller, "POST", `${packagePath(pkg)}/versions`, { version, ...(notes !== undefined && { notes }) }), `create draft ${version}`);
}

export interface UploadOptions { sha256?: string; sig?: string; run?: string; exec?: string }

/** The single-request upload; the response is returned as is so a suite can assert on a refusal. */
export async function putAsset(caller: Caller, pkg: PackageView, version: string, name: string, bytes: Uint8Array, opts: UploadOptions = {}): Promise<Response> {
  const query = new URLSearchParams({ sha256: opts.sha256 ?? await sha256Hex(bytes) });
  for (const key of ["sig", "run", "exec"] as const) {
    if (opts[key] !== undefined)
      query.set(key, opts[key]);
  }
  return await send(caller, "PUT", `${packagePath(pkg)}/versions/${version}/assets/${name}?${query}`, bytes as Uint8Array<ArrayBuffer>, { "Content-Type": "application/octet-stream" });
}

export async function uploadAsset(caller: Caller, pkg: PackageView, version: string, name: string, bytes: Uint8Array, opts: UploadOptions = {}): Promise<AssetView> {
  return await data(await putAsset(caller, pkg, version, name, bytes, opts), `upload ${name}`);
}

export async function publish(caller: Caller, pkg: PackageView, version: string, channel = "stable"): Promise<VersionView> {
  return await data(await sendJson(caller, "POST", `${packagePath(pkg)}/versions/${version}/publish`, { channel }), `publish ${version}`);
}

export async function setChannel(caller: Caller, pkg: PackageView, channel: string, version: string): Promise<Response> {
  return await sendJson(caller, "PUT", `${packagePath(pkg)}/channels/${channel}`, { version });
}

/** Draft, one asset, publish: the shortest complete release. */
export async function release(
  caller: Caller,
  pkg: PackageView,
  version: string,
  asset: { name: string; bytes: Uint8Array } & UploadOptions,
  channel = "stable",
): Promise<AssetView> {
  await createDraft(caller, pkg, version);
  const { name, bytes, ...opts } = asset;
  const uploaded = await uploadAsset(caller, pkg, version, name, bytes, opts);
  await publish(caller, pkg, version, channel);
  return uploaded;
}

export async function deletePackage(client: ApiClient, pkg: PackageView): Promise<void> {
  await client.json(packagePath(pkg), { method: "DELETE" });
}

/** A read-feed request: no session, only the bearer header when a token is given. */
export async function feed(path: string, token?: string, headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(`${FEED_BASE}${path}`, { headers: { ...(token !== undefined && { Authorization: `Bearer ${token}` }), ...headers } });
}

export async function manifestOf(pkg: Pick<PackageView, "namespace" | "slug">, token?: string): Promise<Manifest> {
  const res = await feed(`/${pkg.namespace}/${pkg.slug}/manifest.json`, token);
  if (!res.ok)
    throw new Error(`manifest of ${pkg.namespace}/${pkg.slug} -> ${res.status}`);
  return await res.json() as Manifest;
}

// ─── Signing, the way `lode-cli sign` does it ───

export interface SigningKey {
  /** Raw public key as unpadded base64url: what `POST …/keys` takes. */
  publicKey: string;
  /** First 16 hex characters of sha256 over the raw public key. */
  keyId: string;
  /** `app` is the package slug the asset is uploaded into. */
  sign: (identity: { app: string; name: string; version: string; sha256: string; run?: string; exec?: string }) => Promise<string>;
}

/** A fresh ed25519 keypair, kept in memory for the length of the run. */
export async function generateSigningKey(): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey: Buffer.from(raw).toString("base64url"),
    keyId: (await sha256Hex(raw)).slice(0, 16),
    sign: async ({ app, name, version, sha256, run = "", exec = "" }) => {
      const message = text(`lode.artifact.v2\n${app}\n${name}\n${version}\n${sha256}\n${run}\n${exec}`);
      return Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message as Uint8Array<ArrayBuffer>)).toString("base64url");
    },
  };
}

/** Register a signing key for a package. */
export async function registerKey(client: ApiClient, pkg: Pick<PackageView, "namespace" | "slug">, publicKey: string): Promise<{ id: string; key_id: string }> {
  const res = await client.json<Envelope<{ id: string; key_id: string }>>(`${packagePath(pkg)}/keys`, {
    method: "POST",
    body: { public_key: publicKey, name: uniqueSlug("e2e-key") },
  });
  return res.data;
}
