#!/usr/bin/env bun
/**
 * Cloudflare Workers smoke test.
 *
 * Boots the app the way it actually runs on Cloudflare — one Durable
 * Object owning a SQLite database — and drives the paths whose behaviour
 * differs from Bun:
 *
 *   1. boot          — migrations run inside the Durable Object
 *   2. transactions  — deleting a resource group and rewriting a relation
 *                      tuple each wrap a multi-statement write, and Durable
 *                      Object transactions are async-callback based (see
 *                      `workers/db.ts`)
 *   3. rate limiting — the platform key/value seam backs the limiter
 *   4. registry      — an asset is streamed into the R2 bucket, its digest
 *                      checked by R2 and its ed25519 signature by WebCrypto,
 *                      then read back through the `/r` feed; a second asset
 *                      goes in as R2 multipart parts and is verified by the
 *                      completion digest
 *
 * With `--oidc` it checks a deployment configured for OpenID Connect
 * instead. Such a deployment has no local password to log in with — the SPA
 * offers one login method or the other — so the authenticated cases are
 * replaced by ones that prove the provider wiring: the app reports an
 * OAuth-configured mode, and starting a login redirects to the issuer
 * carrying a PKCE challenge.
 *
 * With `--base-path /u` (and optionally `--home-page root`) it runs the
 * Worker mounted under that prefix, serving a SPA built for it from
 * apps/web/dist-smoke, and checks the paths the Worker has to serve itself
 * there: the shell and its assets under the prefix, and "/" — a redirect to
 * the app, or the home page when it lives at the origin root.
 *
 * Usage:
 *   bun tests/workers/smoke.ts                 # spawns `wrangler dev`
 *   bun tests/workers/smoke.ts --url https://… # runs against a deployment
 *   bun tests/workers/smoke.ts --url … --oidc  # OIDC deployment
 *
 * Checks for a deployed preview. They are never part of the runs above: a
 * run given one or both flags does only the health check, the login and the
 * selected checks. They work without `--url` too.
 *
 *   --large          One multipart upload of exactly 524288000 bytes (the
 *                    asset limit, 8 parts), published and downloaded again
 *                    with a digest check. While the completion is in flight,
 *                    `/api/health` and a published manifest are probed once
 *                    a second: every probe must answer 200, the slowest
 *                    within 10 s. Prints the part upload time, the
 *                    completion time and the slowest probe. Moves 500 MiB up
 *                    and 500 MiB down: about 10 s against local workerd,
 *                    about 3 minutes on a 50 Mbit/s line. The asset is
 *                    generated and hashed one 64 MiB part at a time, so the
 *                    run needs about 300 MiB of memory.
 *   --refused-body   Sends a 90 MiB single-request upload the server refuses
 *                    before reading it (the version is already published),
 *                    then ordinary requests, which must succeed; prints how
 *                    long the refusal took, which is the cost of draining
 *                    the body. Then the same with a client that aborts its
 *                    own body after 16 MiB. Moves up to 106 MiB up.
 *
 * Both use the suite's session and a package they create and delete again.
 * With the two variables below set they use a token instead, sending
 * nothing but the `Authorization` header — the only way to run them with
 * `--oidc`, where there is no password (without a token they are skipped):
 *
 *   SMOKE_REGISTRY_TOKEN     a personal API token (`pat_…`) with a `write`
 *                            grant on the package
 *   SMOKE_REGISTRY_PACKAGE   that package, as `<namespace>/<slug>`
 *
 * A token cannot delete a published version, so every token run leaves two
 * versions behind (`<run id>-seed`, a few KiB, and with `--large`
 * `<run id>-large`, 500 MiB) and moves the channel `smoke`. The run prints
 * them. A version the channel points at cannot be deleted on its own (409
 * `VERSION_IN_CHANNEL`, and no route removes a channel pointer), so use a
 * package dedicated to these runs and delete the whole package from a
 * session of its owner or of an administrator.
 */
import type { Subprocess } from "bun";
import { Buffer } from "node:buffer";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

// Local runs use the fixture in apps/api/.dev.vars.example. A run against a
// real deployment passes freshly generated credentials instead, so a
// publicly reachable URL never carries a password that is committed here.
const USERNAME = process.env.SMOKE_USERNAME ?? "smoke";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "smoke-test-password";
const PORT = 8787;

// Fixed by the server (docs/modules/registry.md, "Uploads").
const PART_SIZE = 64 * 1024 * 1024;
const ASSET_LIMIT = 500 * 1024 * 1024;
const MIB = 1024 * 1024;

const TOKEN = process.env.SMOKE_REGISTRY_TOKEN ?? "";
const TOKEN_PACKAGE = process.env.SMOKE_REGISTRY_PACKAGE ?? "";

const USAGE = `Usage: bun tests/workers/smoke.ts [--url <base url>] [--oidc] [--large] [--refused-body]
       bun tests/workers/smoke.ts --base-path <prefix> [--home-page <mode>]

  --url <base url>   run against a deployment instead of spawning wrangler dev
  --oidc             the deployment logs in through OpenID Connect
  --large            only: a 500 MiB multipart upload, probed during completion
  --refused-body     only: a refused 90 MiB upload leaves the client usable
  --base-path <p>    spawn wrangler dev with the app under a prefix and check the
                     SPA, the API and the read feed there (needs a build with
                     the same BASE_PATH in apps/web/dist-smoke)
  --home-page <mode> with --base-path: off (default), base or root

  SMOKE_REGISTRY_TOKEN, SMOKE_REGISTRY_PACKAGE (<namespace>/<slug>)
                     run --large / --refused-body with a write-granted token
                     against an existing package (required with --oidc)`;

interface Case {
  name: string;
  run: () => Promise<void>;
}

class SmokeError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond)
    throw new SmokeError(msg);
}

let baseUrl = "";
let cookie = "";

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  // csrfGuard wants both an `X-Requested-With` header and a matching Origin
  // on state-changing requests; the SPA client sets the same pair.
  headers.set("Origin", new URL(baseUrl).origin);
  headers.set("X-Requested-With", "XMLHttpRequest");
  if (cookie)
    headers.set("Cookie", cookie);
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0)
    cookie = setCookie.map(c => c.split(";")[0]).join("; ");
  return res;
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  }
  catch {
    throw new SmokeError(`expected JSON, got ${res.status}: ${text.slice(0, 300)}`);
  }
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function base64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Deterministic filler, so two assets differ and a failure is reproducible. */
function fill(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++)
    out[i] = (i * 31 + seed) & 0xFF;
  return out;
}

interface ApiError { error?: { code?: string } }

type Send = (path: string, init?: RequestInit) => Promise<Response>;

/** A token request carries nothing but its `Authorization` header: no cookie, no Origin. */
async function callWithToken(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  return await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
}

/**
 * A route that takes no payload is sent none. Local workerd drops the
 * client's next request after an answer that left a request body unread, and
 * only the upload routes drain what they refuse.
 */
async function postJson(send: Send, path: string, body?: unknown): Promise<Response> {
  if (body === undefined)
    return await send(`/api/registry${path}`, { method: "POST" });
  return await send(`/api/registry${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The body of an answer that must have the given status. */
async function expectData<T>(res: Response, status: number, what: string): Promise<T> {
  if (res.status !== status)
    throw new SmokeError(`${what} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await json<{ data: T }>(res)).data;
}

/** `PUT` an asset into a draft the way a publisher does: raw body, the rest in the query. */
async function putAsset(pkg: string, version: string, name: string, bytes: Uint8Array<ArrayBuffer>, query: Record<string, string>, send: Send = call): Promise<Response> {
  return await send(`/api/registry/packages/${pkg}/versions/${version}/assets/${name}?${new URLSearchParams(query)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
}

async function expectRefusal(res: Response, status: number, code: string): Promise<void> {
  const body = await json<ApiError>(res);
  assert(res.status === status && body.error?.code === code, `expected ${status} ${code}, got ${res.status} ${body.error?.code}`);
}

/**
 * Part `n` (from 1) of a generated asset of `size` bytes. The asset is never
 * held whole: each part is made when it is hashed and again when it is sent.
 * Every part has its own seed, so parts assembled in another order hash
 * differently.
 */
function partOf(size: number, seed: number, n: number): Uint8Array<ArrayBuffer> {
  return fill(Math.min(PART_SIZE, size - (n - 1) * PART_SIZE), seed + n);
}

function sha256OfParts(size: number, seed: number): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (let n = 1; n <= Math.ceil(size / PART_SIZE); n++)
    hasher.update(partOf(size, seed, n));
  return hasher.digest("hex");
}

/** Hashes a download as it streams in. */
async function digestOf(res: Response): Promise<{ sha256: string; size: number }> {
  assert(res.body !== null, "the download has no body");
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  for await (const chunk of res.body) {
    hasher.update(chunk);
    size += chunk.length;
  }
  return { sha256: hasher.digest("hex"), size };
}

interface Started { uploadId: string; partSize: number; partCount: number }

async function startUpload(send: Send, pkg: string, version: string, body: { asset: string; size: number; sha256: string }): Promise<Started> {
  return await expectData<Started>(await postJson(send, `/packages/${pkg}/versions/${version}/uploads`, body), 201, "multipart start");
}

async function putPart(send: Send, uploadId: string, n: number, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  return await send(`/api/registry/uploads/${uploadId}/parts/${n}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
}

interface ManifestAsset { name: string; url: string; sha256: string; size: number }
interface Manifest { channels: Record<string, { latest: string }>; versions: Record<string, { assets: ManifestAsset[] }> }

function mib(bytes: number): string {
  return `${Math.round(bytes / MIB)} MiB`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** A measurement the owner records; printed above the case's verdict. */
function note(msg: string): void {
  console.log(`        ${msg}`);
}

const cases: Case[] = [
  {
    name: "health endpoint responds",
    async run() {
      const res = await call("/api/health");
      assert(res.status === 200, `health returned ${res.status}`);
      const body = await json<{ status: string }>(res);
      assert(body.status === "ok", `health status was ${body.status}`);
    },
  },
  {
    name: "single-user login issues a session",
    async run() {
      const res = await call("/api/account/auth/login-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      if (res.status !== 200)
        throw new SmokeError(`login returned ${res.status}: ${await res.text()}`);
      assert(cookie !== "", "login did not set a session cookie");
    },
  },
  {
    name: "resource group delete commits its transaction",
    async run() {
      const res = await call("/api/policy/resource-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `smoke group ${Date.now()}` }),
      });
      if (res.status !== 201)
        throw new SmokeError(`create returned ${res.status}: ${await res.text()}`);
      const created = await json<{ data: { id: string } }>(res);
      const id = created.data.id;

      const grant = await call("/api/policy/tuples", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: "resource_group", objectId: id, relation: "viewer", subjectNamespace: "user", subjectId: "smoke-subject" }),
      });
      if (grant.status !== 201)
        throw new SmokeError(`grant returned ${grant.status}: ${await grant.text()}`);
      await grant.text();

      // The delete removes the group and its access tuples in one
      // transaction: every statement must have committed.
      const del = await call(`/api/policy/resource-groups/${id}`, { method: "DELETE" });
      if (del.status >= 300)
        throw new SmokeError(`delete returned ${del.status}: ${await del.text()}`);
      await del.text();

      const groups = await json<{ data: { id: string }[] }>(await call("/api/policy/resource-groups"));
      assert(!groups.data.some(g => g.id === id), "a deleted resource group is still listed");
      const tuples = await json<{ data: unknown[] }>(await call(`/api/policy/tuples?namespace=resource_group&object_id=${id}`));
      assert(tuples.data.length === 0, "a deleted resource group left its access tuples behind");
    },
  },
  {
    name: "colliding tuple rewrite rolls its transaction back",
    async run() {
      const objectId = `smoke-rollback-${Date.now()}`;
      const ids: string[] = [];
      for (const relation of ["viewer", "editor"]) {
        const res = await call("/api/policy/tuples", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace: "resource_group", objectId, relation, subjectNamespace: "user", subjectId: "smoke-subject" }),
        });
        if (res.status !== 201)
          throw new SmokeError(`create returned ${res.status}: ${await res.text()}`);
        ids.push((await json<{ data: { id: string } }>(res)).data.id);
      }

      // The rewrite deletes the row and inserts its replacement in one
      // transaction; the insert collides with the other tuple, so the
      // delete must be rolled back.
      const res = await call(`/api/policy/tuples/${ids[0]}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relation: "editor" }),
      });
      assert(res.status >= 400, `colliding rewrite unexpectedly returned ${res.status}`);
      await res.text();

      const after = await json<{ data: { id: string; relation: string }[] }>(
        await call(`/api/policy/tuples?namespace=resource_group&object_id=${objectId}`),
      );
      assert(after.data.length === 2, `a rejected rewrite left ${after.data.length} tuples, expected 2`);
      assert(after.data.some(t => t.id === ids[0] && t.relation === "viewer"), "a rejected rewrite lost the original tuple");
    },
  },
  {
    name: "the raw API reaches the Worker and carries no browser headers",
    async run() {
      const res = await fetch(`${baseUrl}/api/raw/health`);
      assert(res.status === 200, `raw health returned ${res.status}`);
      assert((res.headers.get("content-type") ?? "").includes("application/json"), "raw API answered with something other than JSON");
      assert(res.headers.get("content-security-policy") === null, "raw API carries a CSP");
      assert(res.headers.get("cross-origin-resource-policy") === null, "raw API restricts cross-origin readers");
    },
  },
  {
    name: "registry round trip: upload to R2, publish, read back through /r",
    async run() {
      const post = async (path: string, body: unknown): Promise<Response> => await call(`/api/registry${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // The namespace is assigned by the server with the first package.
      const slug = `smoke-${Date.now().toString(36)}`;
      const created = await post("/packages", { slug, name: "Smoke" });
      if (created.status !== 201)
        throw new SmokeError(`package create returned ${created.status}: ${await created.text()}`);
      const ns = (await json<{ data: { namespace: string } }>(created)).data.namespace;
      const pkg = `${ns}/${slug}`;
      const version = "1.0.0";

      const draft = await post(`/packages/${pkg}/versions`, { version });
      if (draft.status !== 201)
        throw new SmokeError(`draft create returned ${draft.status}: ${await draft.text()}`);
      await draft.text();

      // R2 checks the digest itself: bytes that do not hash to the declared
      // sha256 are refused and nothing is stored.
      const plain = fill(70_000, 7);
      const plainSha = await sha256Hex(plain);
      await expectRefusal(await putAsset(pkg, version, "smoke-plain.bin", plain, { sha256: await sha256Hex(fill(70_000, 8)) }), 422, "DIGEST_MISMATCH");
      const stored = await putAsset(pkg, version, "smoke-plain.bin", plain, { sha256: plainSha });
      if (stored.status !== 201)
        throw new SmokeError(`upload returned ${stored.status}: ${await stored.text()}`);
      await stored.text();

      // A signed asset: the message is the one registry/signature.ts builds,
      // `lode.artifact.v2\n{app}\n{name}\n{version}\n{sha256}\n{run}\n{exec}`,
      // with `app` the package slug, `name` the asset filename and empty
      // `run` / `exec`.
      const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
      const key = await post(`/packages/${pkg}/keys`, { public_key: base64Url(await crypto.subtle.exportKey("raw", pair.publicKey)), name: "smoke" });
      if (key.status !== 201)
        throw new SmokeError(`key registration returned ${key.status}: ${await key.text()}`);
      const keyId = (await json<{ data: { key_id: string } }>(key)).data.key_id;
      const sign = async (name: string, sha256: string): Promise<string> =>
        base64Url(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(`lode.artifact.v2\n${slug}\n${name}\n${version}\n${sha256}\n\n`)));

      const signed = fill(4096, 3);
      const signedSha = await sha256Hex(signed);
      // A signature over another digest does not cover these bytes.
      await expectRefusal(await putAsset(pkg, version, "smoke-signed.bin", signed, { sha256: signedSha, sig: await sign("smoke-signed.bin", plainSha) }), 400, "INVALID_SIGNATURE");
      const sig = await sign("smoke-signed.bin", signedSha);
      const storedSigned = await putAsset(pkg, version, "smoke-signed.bin", signed, { sha256: signedSha, sig });
      if (storedSigned.status !== 201)
        throw new SmokeError(`signed upload returned ${storedSigned.status}: ${await storedSigned.text()}`);
      await storedSigned.text();

      const published = await post(`/packages/${pkg}/versions/${version}/publish`, { channel: "stable" });
      if (published.status !== 200)
        throw new SmokeError(`publish returned ${published.status}: ${await published.text()}`);
      await published.text();

      // The feed is read the way lode reads it: a bare GET, no cookie, no
      // Origin. It must reach the Worker, not the SPA fallback.
      const manifestUrl = `${new URL(baseUrl).origin}/r/${pkg}/manifest.json`;
      const res = await fetch(manifestUrl);
      assert(res.status === 200, `manifest returned ${res.status}`);
      assert((res.headers.get("content-type") ?? "").includes("application/json"), "the manifest is not JSON: the feed did not reach the Worker");
      assert(res.headers.get("cache-control") === "public, max-age=60", `manifest Cache-Control was ${res.headers.get("cache-control")}`);
      assert(res.headers.getSetCookie().length === 0, "the feed set a cookie");
      const etag = res.headers.get("etag");
      assert(etag !== null, "a public manifest carried no ETag");
      interface Asset { name: string; url: string; sha256: string; size: number; sig?: string; key_id?: string; alg?: string }
      const manifest = await json<{ schema: string; name: string; channels: Record<string, { latest: string }>; versions: Record<string, { assets: Asset[] }> }>(res);
      assert(manifest.schema === "lode/v1", `schema was ${manifest.schema}`);
      assert(manifest.name === slug, `manifest name was ${manifest.name}, expected the package slug`);
      assert(manifest.channels.stable?.latest === version, "the stable channel does not point at the published version");
      const assets = manifest.versions[version]?.assets ?? [];
      assert(assets.length === 2, `the manifest lists ${assets.length} assets, expected 2`);

      const cached = await fetch(manifestUrl, { headers: { "If-None-Match": etag } });
      assert(cached.status === 304, `a matching If-None-Match returned ${cached.status}`);
      await cached.arrayBuffer();

      const signedAsset = assets.find(a => a.name === "smoke-signed.bin");
      assert(signedAsset !== undefined, "the signed asset is missing from the manifest");
      assert(signedAsset.sig === sig && signedAsset.key_id === keyId && signedAsset.alg === "ed25519", "the signed asset does not carry its sig, key_id and alg");
      const plainAsset = assets.find(a => a.name === "smoke-plain.bin");
      assert(plainAsset !== undefined, "the unsigned asset is missing from the manifest");
      assert(!("sig" in plainAsset) && !("key_id" in plainAsset), "an unsigned asset carries signature fields");

      for (const [asset, bytes, sha] of [[plainAsset, plain, plainSha], [signedAsset, signed, signedSha]] as const) {
        assert(asset.sha256 === sha && asset.size === bytes.length, `${asset.name}: the manifest's sha256 or size is wrong`);
        assert(asset.url === `${new URL(asset.url).origin}/r/${pkg}/${version}/${asset.name}`, `${asset.name}: unexpected url ${asset.url}`);
        // Downloaded through the url the manifest gives, as lode does.
        const download = await fetch(asset.url);
        assert(download.status === 200, `${asset.name}: download returned ${download.status}`);
        assert(download.headers.get("content-type") === "application/octet-stream", `${asset.name}: Content-Type was ${download.headers.get("content-type")}`);
        assert(download.headers.get("content-length") === String(bytes.length), `${asset.name}: Content-Length was ${download.headers.get("content-length")}`);
        assert(download.headers.get("cache-control") === "public, max-age=31536000, immutable", `${asset.name}: Cache-Control was ${download.headers.get("cache-control")}`);
        const got = new Uint8Array(await download.arrayBuffer());
        assert(got.length === bytes.length && got.every((byte, i) => byte === bytes[i]), `${asset.name}: the downloaded bytes differ from the uploaded ones`);
        assert(await sha256Hex(got) === asset.sha256, `${asset.name}: the downloaded bytes do not hash to the manifest's sha256`);
      }

      const missing = await fetch(`${new URL(baseUrl).origin}/r/${pkg}/${version}/nothing.bin`);
      assert(missing.status === 404 && (missing.headers.get("content-type") ?? "").includes("application/json"), "an unknown asset was not a JSON 404");
      await missing.text();
    },
  },
  {
    // Creation budgets are counted per route, so the package and the draft
    // made here take nothing from the resource-group budget of the last case.
    name: "registry multipart: parts into R2, completion digest, read back through /r",
    async run() {
      const slug = `smoke-multipart-${Date.now().toString(36)}`;
      const created = await expectData<{ namespace: string }>(await postJson(call, "/packages", { slug, name: "Smoke multipart" }), 201, "package create");
      const pkg = `${created.namespace}/${slug}`;
      const version = "1.0.0";
      await expectData(await postJson(call, `/packages/${pkg}/versions`, { version }), 201, "draft create");

      // One full part and a remainder.
      const size = PART_SIZE + MIB;
      const sha256 = sha256OfParts(size, 11);
      const started = await startUpload(call, pkg, version, { asset: "smoke-multipart.bin", size, sha256 });
      assert(typeof started.uploadId === "string" && started.uploadId !== "", "the start answer carries no uploadId");
      assert(started.partSize === PART_SIZE, `partSize was ${started.partSize}, expected ${PART_SIZE}`);
      assert(started.partCount === 2, `partCount was ${started.partCount}, expected 2`);
      const upload = `/uploads/${started.uploadId}`;

      const first = await expectData<{ part_number: number; size: number }>(await putPart(call, started.uploadId, 1, partOf(size, 11, 1)), 200, "part 1");
      assert(first.part_number === 1 && first.size === PART_SIZE, `part 1 was stored as part ${first.part_number} of ${first.size} bytes`);
      // Not complete without its last part, and a part has to be exactly its size.
      await expectRefusal(await postJson(call, `${upload}/complete`), 409, "UPLOAD_INCOMPLETE");
      await expectRefusal(await putPart(call, started.uploadId, 2, fill(16, 1)), 422, "INVALID_PART_SIZE");
      await expectData(await putPart(call, started.uploadId, 2, partOf(size, 11, 2)), 200, "part 2");

      // The parts carry no digest of the whole: the server reads the
      // assembled object back through SHA-256 before the asset exists.
      const asset = await expectData<{ name: string; size: number; sha256: string }>(await postJson(call, `${upload}/complete`), 201, "completion");
      assert(asset.name === "smoke-multipart.bin" && asset.size === size && asset.sha256 === sha256, "the completed asset does not carry the declared name, size and sha256");

      // Assembled bytes that do not hash to the digest declared at start
      // are refused, and upload and object are gone.
      const other = await startUpload(call, pkg, version, { asset: "smoke-mismatch.bin", size: 70_000, sha256: await sha256Hex(fill(70_000, 8)) });
      assert(other.partCount === 1, `partCount of a 70000 byte upload was ${other.partCount}`);
      await expectData(await putPart(call, other.uploadId, 1, fill(70_000, 7)), 200, "the mismatching part");
      await expectRefusal(await postJson(call, `/uploads/${other.uploadId}/complete`), 422, "DIGEST_MISMATCH");
      const gone = await postJson(call, `/uploads/${other.uploadId}/complete`);
      assert(gone.status === 404, `completing a refused upload again returned ${gone.status}`);
      await gone.text();

      await expectData(await postJson(call, `/packages/${pkg}/versions/${version}/publish`, { channel: "stable" }), 200, "publish");

      const res = await fetch(`${new URL(baseUrl).origin}/r/${pkg}/manifest.json`);
      assert(res.status === 200, `manifest returned ${res.status}`);
      const manifest = await json<Manifest>(res);
      assert(manifest.channels.stable?.latest === version, "the stable channel does not point at the published version");
      const assets = manifest.versions[version]?.assets ?? [];
      assert(assets.length === 1, `the manifest lists ${assets.map(a => a.name).join(", ")}, expected only smoke-multipart.bin`);
      const listed = assets[0];
      assert(listed !== undefined && listed.name === "smoke-multipart.bin" && listed.size === size && listed.sha256 === sha256, "the manifest does not list the asset with the declared size and sha256");

      const download = await fetch(listed.url);
      assert(download.status === 200, `download returned ${download.status}`);
      assert(download.headers.get("content-length") === String(size), `Content-Length was ${download.headers.get("content-length")}`);
      const got = await digestOf(download);
      assert(got.size === size && got.sha256 === sha256, `downloaded ${got.size} bytes hashing to ${got.sha256}, expected ${size} bytes and ${sha256}`);
      const missing = await fetch(`${new URL(baseUrl).origin}/r/${pkg}/${version}/smoke-mismatch.bin`);
      assert(missing.status === 404, `the refused asset is served: ${missing.status}`);
      await missing.text();
    },
  },
  {
    // Runs last: it spends whatever creation budget the cases above left.
    name: "creation rate limit is enforced from the database",
    async run() {
      let limited: Response | undefined;
      for (let i = 0; i < 40; i++) {
        const res = await call("/api/policy/resource-groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `burst ${Date.now()} ${i}` }),
        });
        if (res.status === 429) {
          limited = res;
          break;
        }
        await res.text();
      }
      assert(limited !== undefined, "the creation limit never tripped");
      const body = await limited.json() as { error: { code: string } };
      assert(body.error.code === "RATE_LIMITED", `unexpected error code ${body.error.code}`);
      const retryAfter = Number(limited.headers.get("Retry-After"));
      assert(retryAfter > 0, "429 carried no usable Retry-After");
    },
  },
];

const oidcCases: Case[] = [
  {
    name: "health endpoint responds",
    async run() {
      const res = await call("/api/health");
      assert(res.status === 200, `health returned ${res.status}`);
    },
  },
  {
    name: "the raw API reaches the Worker and carries no browser headers",
    async run() {
      const res = await fetch(`${baseUrl}/api/raw/health`);
      assert(res.status === 200, `raw health returned ${res.status}`);
      assert((res.headers.get("content-type") ?? "").includes("application/json"), "raw API answered with something other than JSON");
      assert(res.headers.get("content-security-policy") === null, "raw API carries a CSP");
      assert(res.headers.get("cross-origin-resource-policy") === null, "raw API restricts cross-origin readers");
    },
  },
  {
    name: "the SPA is served from the asset pipeline",
    async run() {
      const res = await call("/");
      assert(res.status === 200, `index returned ${res.status}`);
      const body = await res.text();
      assert(body.includes("<!doctype html") || body.includes("<!DOCTYPE html"), "index was not HTML");
    },
  },
  {
    name: "login mode reports a configured OAuth provider",
    async run() {
      const res = await call("/api/account/auth/mode");
      assert(res.status === 200, `mode returned ${res.status}`);
      const body = await json<{ data: { mode: string; oauthConfigured: boolean } }>(res);
      assert(body.data.mode === "oauth", `mode was '${body.data.mode}', so the SPA would not offer OAuth`);
      // False here means discovery did not resolve the endpoints at boot.
      assert(body.data.oauthConfigured, "the provider's endpoints are not configured");
    },
  },
  {
    name: "starting a login redirects to the issuer with a PKCE challenge",
    async run() {
      const res = await call("/api/account/auth/login");
      assert(res.status === 302, `login returned ${res.status}, expected a redirect`);
      const location = res.headers.get("Location");
      assert(location !== null, "the redirect carried no Location");

      const target = new URL(location);
      const issuer = process.env.SMOKE_OAUTH_ISSUER;
      if (issuer)
        assert(target.host === new URL(issuer).host, `redirected to ${target.host}, not the issuer's host`);

      const clientId = process.env.SMOKE_OAUTH_CLIENT_ID;
      if (clientId)
        assert(target.searchParams.get("client_id") === clientId, "the redirect carried a different client_id");

      assert(target.searchParams.get("response_type") === "code", "response_type was not 'code'");
      assert(target.searchParams.get("code_challenge_method") === "S256", "PKCE is not in use: no S256 challenge method");
      assert((target.searchParams.get("code_challenge") ?? "").length > 0, "PKCE is not in use: the challenge is empty");
      assert(
        target.searchParams.get("redirect_uri") === `${baseUrl}/api/account/auth/callback`,
        `redirect_uri was ${target.searchParams.get("redirect_uri")}, which the provider must have registered`,
      );
    },
  },
];

// --- Checks for a deployed preview (`--large`, `--refused-body`) ---

const RUN_ID = Date.now().toString(36);
// Not `stable`: with a token the checks publish into somebody's package.
const PREVIEW_CHANNEL = "smoke";
const REFUSED_BODY_SIZE = 90 * MIB;
const ABORT_AFTER = 16 * MIB;
const PROBE_INTERVAL_MS = 1000;
// A completion may keep the Durable Object busy, but not so long that a
// lode client polling its manifest would give up.
const PROBE_LIMIT_MS = 10_000;

/** Run after the suite, pass or fail. */
const cleanups: (() => Promise<void>)[] = [];
/** What a token run could not delete. */
const leftBehind: string[] = [];

interface Target {
  send: Send;
  /** `<namespace>/<slug>` */
  pkg: string;
  /** A small version, published before either check starts. */
  published: string;
}

let target: Promise<Target> | undefined;

/** The package both checks work in, prepared once. */
async function previewTarget(): Promise<Target> {
  target ??= prepareTarget();
  return await target;
}

async function prepareTarget(): Promise<Target> {
  const send = TOKEN ? callWithToken : call;
  let pkg = TOKEN_PACKAGE;
  if (!TOKEN) {
    const slug = `smoke-preview-${RUN_ID}`;
    const created = await expectData<{ namespace: string }>(await postJson(call, "/packages", { slug, name: "Smoke preview" }), 201, "package create");
    pkg = `${created.namespace}/${slug}`;
    cleanups.push(async () => {
      const res = await call(`/api/registry/packages/${pkg}`, { method: "DELETE" });
      note(res.status < 300 ? `deleted the package ${pkg}` : `could not delete the package ${pkg}: ${res.status}`);
      await res.text();
    });
  }

  // The refusal check uploads to this version because it is published; the
  // large check probes the manifest it appears in.
  const published = `${RUN_ID}-seed`;
  await expectData(await postJson(send, `/packages/${pkg}/versions`, { version: published }), 201, "draft create");
  if (TOKEN)
    leftBehind.push(`${pkg}: version ${published} (4096 bytes), channel ${PREVIEW_CHANNEL}`);
  const seed = fill(4096, 5);
  const stored = await putAsset(pkg, published, "smoke-seed.bin", seed, { sha256: await sha256Hex(seed) }, send);
  await expectData(stored, 201, "seed upload");
  await expectData(await postJson(send, `/packages/${pkg}/versions/${published}/publish`, { channel: PREVIEW_CHANNEL }), 200, "publish");
  return { send, pkg, published };
}

/**
 * The read feed as lode reads it. A private package needs the token; it is
 * only ever sent to the host under test.
 */
async function readFeed(url: string): Promise<Response> {
  const headers = new Headers();
  if (TOKEN && new URL(url).origin === new URL(baseUrl).origin)
    headers.set("Authorization", `Bearer ${TOKEN}`);
  return await fetch(url, { headers });
}

/** A request body of `size` generated bytes that is never held whole. */
function generatedBody(size: number, onSent: (sent: number) => void): ReadableStream<Uint8Array> {
  const block = fill(MIB, 9);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const chunk = block.subarray(0, Math.min(block.length, size - sent));
      sent += chunk.length;
      onSent(sent);
      controller.enqueue(chunk);
    },
  });
}

/**
 * What a client does next; each request must be answered, not fail on a
 * dropped connection. One of them carries a body, because wrangler's proxy
 * quietly retries a dropped request that has none.
 */
async function expectUsable({ send, pkg, published }: Target, after: string): Promise<void> {
  const requests: [string, RequestInit][] = [
    ["/api/health", {}],
    [`/api/registry/packages/${pkg}/channels/${PREVIEW_CHANNEL}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: published }) }],
    [`/api/registry/packages/${pkg}/versions/${published}`, {}],
  ];
  for (let round = 0; round < 3; round++) {
    for (const [path, init] of requests) {
      const what = `after ${after}, ${init.method ?? "GET"} ${path}`;
      let res: Response;
      try {
        res = await send(path, init);
      }
      catch (err) {
        throw new SmokeError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const text = await res.text();
      assert(res.status === 200, `${what} returned ${res.status}: ${text.slice(0, 300)}`);
    }
  }
}

const previewCases: Record<"large" | "refusedBody", Case> = {
  large: {
    name: "500 MiB multipart upload: completion leaves the app responsive, download matches",
    async run() {
      const t = await previewTarget();
      const { send, pkg } = t;
      const version = `${RUN_ID}-large`;
      const size = ASSET_LIMIT;
      const sha256 = sha256OfParts(size, 21);
      await expectData(await postJson(send, `/packages/${pkg}/versions`, { version }), 201, "draft create");
      if (TOKEN)
        leftBehind.push(`${pkg}: version ${version} (${mib(size)})`);

      const started = await startUpload(send, pkg, version, { asset: "smoke-large.bin", size, sha256 });
      assert(started.partSize === PART_SIZE && started.partCount === 8, `started with ${started.partCount} parts of ${started.partSize} bytes, expected 8 of ${PART_SIZE}`);
      const uploading = performance.now();
      for (let n = 1; n <= started.partCount; n++)
        await expectData(await putPart(send, started.uploadId, n, partOf(size, 21, n)), 200, `part ${n}`);
      note(`part upload: ${seconds(performance.now() - uploading)} for ${mib(size)} in ${started.partCount} parts`);

      // The completion reads the whole object back through SHA-256 inside
      // the Durable Object that also serves every other request.
      const completing = performance.now();
      let completedIn = 0;
      const completion = postJson(send, `/uploads/${started.uploadId}/complete`).then((res) => {
        completedIn = performance.now() - completing;
        return res;
      });
      const manifestUrl = `${new URL(baseUrl).origin}/r/${pkg}/manifest.json`;
      const probes: { what: string; status: number; ms: number }[] = [];
      const probe = async (what: string, request: () => Promise<Response>): Promise<void> => {
        const at = performance.now();
        const res = await request();
        await res.text();
        probes.push({ what, status: res.status, ms: performance.now() - at });
      };
      for (;;) {
        await Promise.all([
          probe("/api/health", async () => await fetch(`${baseUrl}/api/health`)),
          probe("the manifest", async () => await readFeed(manifestUrl)),
        ]);
        if (await Promise.race([completion.then(() => true), sleep(PROBE_INTERVAL_MS, false)]))
          break;
      }

      const asset = await expectData<{ size: number; sha256: string }>(await completion, 201, "completion");
      assert(asset.size === size && asset.sha256 === sha256, "the completed asset does not carry the declared size and sha256");
      const slowest = probes.reduce((a, b) => (b.ms > a.ms ? b : a));
      note(`completion: ${seconds(completedIn)}`);
      note(`slowest of ${probes.length} probes during completion: ${Math.round(slowest.ms)} ms (${slowest.what})`);
      const failed = probes.find(p => p.status !== 200);
      assert(failed === undefined, `a probe of ${failed?.what} during completion returned ${failed?.status}`);
      assert(slowest.ms < PROBE_LIMIT_MS, `a probe of ${slowest.what} took ${Math.round(slowest.ms)} ms during completion, limit ${PROBE_LIMIT_MS} ms`);

      await expectData(await postJson(send, `/packages/${pkg}/versions/${version}/publish`, { channel: PREVIEW_CHANNEL }), 200, "publish");
      const feed = await readFeed(manifestUrl);
      assert(feed.status === 200, `manifest returned ${feed.status}`);
      const manifest = await json<Manifest>(feed);
      assert(manifest.channels[PREVIEW_CHANNEL]?.latest === version, `the ${PREVIEW_CHANNEL} channel does not point at ${version}`);
      const listed = manifest.versions[version]?.assets.find(a => a.name === "smoke-large.bin");
      assert(listed !== undefined && listed.size === size && listed.sha256 === sha256, "the manifest does not list the asset with the declared size and sha256");

      const downloading = performance.now();
      const download = await readFeed(listed.url);
      assert(download.status === 200, `download returned ${download.status}`);
      assert(download.headers.get("content-length") === String(size), `Content-Length was ${download.headers.get("content-length")}`);
      const got = await digestOf(download);
      assert(got.size === size && got.sha256 === sha256, `downloaded ${got.size} bytes hashing to ${got.sha256}, expected ${size} bytes and ${sha256}`);
      note(`download: ${seconds(performance.now() - downloading)}`);
    },
  },
  refusedBody: {
    name: "a refused or aborted upload body leaves the client usable",
    async run() {
      const t = await previewTarget();
      // Refused before the body is read: the version is not a draft.
      const path = `/api/registry/packages/${t.pkg}/versions/${t.published}/assets/smoke-refused.bin?sha256=${"0".repeat(64)}`;
      const upload = (body: ReadableStream<Uint8Array>, signal: AbortSignal | null = null): Promise<Response> => t.send(path, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(REFUSED_BODY_SIZE) },
        body,
        signal,
      });

      let sent = 0;
      const refusing = performance.now();
      const refused = await upload(generatedBody(REFUSED_BODY_SIZE, (n) => {
        sent = n;
      }));
      const answeredAfter = sent;
      await expectRefusal(refused, 409, "VERSION_NOT_DRAFT");
      // The server reads the refused body to its end; this is what that costs.
      note(`refusal of a ${mib(REFUSED_BODY_SIZE)} body: ${Math.round(performance.now() - refusing)} ms, answered with ${mib(answeredAfter)} handed to the connection`);
      await expectUsable(t, "a refused upload");

      // The client gives up on its own body part-way.
      const aborter = new AbortController();
      const aborting = performance.now();
      let outcome: string;
      try {
        const res = await upload(generatedBody(REFUSED_BODY_SIZE, (n) => {
          if (n >= ABORT_AFTER)
            aborter.abort();
        }), aborter.signal);
        outcome = `the server had already answered ${res.status}`;
        await res.text().catch(() => {});
      }
      catch (err) {
        assert(aborter.signal.aborted, `the upload failed before it was aborted: ${err instanceof Error ? err.message : String(err)}`);
        outcome = "the request was abandoned";
      }
      note(`client abort after ${mib(ABORT_AFTER)} of ${mib(REFUSED_BODY_SIZE)}: ${outcome}, ${Math.round(performance.now() - aborting)} ms`);
      await expectUsable(t, "an upload the client aborted");
    },
  },
};

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

// Cases for a deployment mounted under a base path. `baseUrl` already ends
// with the prefix, so `origin` is what the browser would call "/".
const homePage = argValue("--home-page") ?? "off";
const baseCases: Case[] = [
  {
    name: "the API answers under the prefix",
    async run() {
      const res = await fetch(`${baseUrl}/api/health`);
      assert(res.status === 200, `health under the prefix returned ${res.status}`);
      await res.text();
    },
  },
  {
    name: "the SPA shell is served under the prefix, with prefixed asset URLs",
    async run() {
      const prefix = new URL(baseUrl).pathname;
      const res = await fetch(`${baseUrl}/`);
      const html = await res.text();
      assert(res.status === 200 && html.includes("id=\"root\""), `the shell under the prefix returned ${res.status}`);
      assert(html.includes(`${prefix}/assets/`), `the shell does not reference ${prefix}/assets/`);
    },
  },
  {
    name: "a prefixed asset is served from the build root",
    async run() {
      const html = await (await fetch(`${baseUrl}/`)).text();
      const src = /src="([^"]+\.js)"/.exec(html)?.[1];
      assert(src, "no script tag in the shell");
      const res = await fetch(new URL(src, new URL(baseUrl).origin));
      assert(res.status === 200, `${src} returned ${res.status}`);
      assert((res.headers.get("content-type") ?? "").includes("javascript"), `${src} was served as ${res.headers.get("content-type")}`);
      await res.arrayBuffer();
    },
  },
  {
    name: "a client route under the prefix gets the SPA shell",
    async run() {
      const res = await fetch(`${baseUrl}/overview`);
      assert(res.status === 200 && (await res.text()).includes("id=\"root\""), "a client route did not return the shell");
    },
  },
  {
    name: homePage === "root" ? "the origin root is the SPA's home page" : "the origin root sends the visitor to the app",
    async run() {
      const origin = new URL(baseUrl).origin;
      const prefix = new URL(baseUrl).pathname;
      const res = await fetch(`${origin}/`, { redirect: "manual" });
      const body = await res.text();
      if (homePage === "root")
        assert(res.status === 200 && body.includes("id=\"root\""), "the origin root did not return the SPA shell");
      else
        assert(body.includes(`url=${prefix}/`), `the origin root does not point at ${prefix}/: ${body.slice(0, 120)}`);
    },
  },
];

// The registry's read feed is mounted at the origin root, outside the prefix:
// the Worker has to see `/r/*` there, and the feed, not the SPA, has to answer.
const feedBaseCases: Case[] = [
  {
    name: "the read feed answers at the origin root, outside the prefix",
    async run() {
      const origin = new URL(baseUrl).origin;
      const res = await fetch(`${origin}/r/nobody/nothing/manifest.json`);
      const body = await res.text();
      assert(res.status === 404 && body.includes("\"success\":false"), `the feed at the origin root returned ${res.status}: ${body.slice(0, 120)}`);
    },
  },
  {
    name: "llms.txt is served at the origin root, as text",
    async run() {
      const origin = new URL(baseUrl).origin;
      const res = await fetch(`${origin}/llms.txt`);
      const body = await res.text();
      assert(res.status === 200 && body.startsWith("# Lode Server"), `llms.txt at the origin root returned ${res.status}: ${body.slice(0, 80)}`);
      assert((res.headers.get("content-type") ?? "").startsWith("text/plain"), `llms.txt was served as ${res.headers.get("content-type")}`);
    },
  },
];

async function waitForBoot(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok)
        return;
    }
    catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new SmokeError(`app did not become healthy within ${timeoutMs}ms`);
}

interface Options { url: string; oidc: boolean; large: boolean; refusedBody: boolean }

/** Anything not understood ends the run: a mistyped flag must not pass as a default run. */
function parseArgs(argv: string[]): Options {
  const options: Options = { url: "", oidc: false, large: false, refusedBody: false };
  const fail = (msg: string): never => {
    console.error(`${msg}\n\n${USAGE}`);
    process.exit(2);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--"))
        fail("--url needs a value");
      else
        options.url = value.replace(/\/+$/, "");
    }
    else if (arg === "--oidc") {
      options.oidc = true;
    }
    else if (arg === "--large") {
      options.large = true;
    }
    else if (arg === "--refused-body") {
      options.refusedBody = true;
    }
    else if (arg === "--base-path" || arg === "--home-page") {
      // Read where they are used, through `argValue`.
      i++;
    }
    else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (options.url === "" && argv.includes("--url"))
    fail("--url needs a value");
  if ((TOKEN === "") !== (TOKEN_PACKAGE === ""))
    fail("SMOKE_REGISTRY_TOKEN and SMOKE_REGISTRY_PACKAGE go together");
  if (TOKEN_PACKAGE !== "" && !/^[^/]+\/[^/]+$/.test(TOKEN_PACKAGE))
    fail("SMOKE_REGISTRY_PACKAGE must be <namespace>/<slug>");
  return options;
}

/** The cases of this run, and the selected checks it cannot do. */
function selectSuite(options: Options): { suite: Case[]; skipped: Case[] } {
  const selected = [...(options.large ? [previewCases.large] : []), ...(options.refusedBody ? [previewCases.refusedBody] : [])];
  if (selected.length === 0)
    return { suite: options.oidc ? oidcCases : cases, skipped: [] };
  // The checks need the app up and, unless a token stands in, a session:
  // the first two default cases.
  if (TOKEN)
    return { suite: [...cases.slice(0, 1), ...selected], skipped: [] };
  if (options.oidc)
    return { suite: cases.slice(0, 1), skipped: selected };
  return { suite: [...cases.slice(0, 2), ...selected], skipped: [] };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let dev: Subprocess | undefined;

  const basePath = argValue("--base-path")?.replace(/\/+$/, "");
  const apiDir = new URL("../../apps/api/", import.meta.url).pathname;
  const smokeConfig = `${apiDir}wrangler.smoke.toml`;

  if (options.url !== "") {
    baseUrl = options.url;
  }
  else {
    baseUrl = `http://127.0.0.1:${PORT}${basePath ?? ""}`;
    // wrangler keeps the Durable Object's SQLite between runs. Start clean so
    // the run is deterministic: a regenerated baseline migration would
    // collide with the old schema, and the rate-limit case needs a fresh
    // creation budget.
    rmSync(new URL("../../apps/api/.wrangler/state", import.meta.url).pathname, {
      recursive: true,
      force: true,
    });
    const args = ["dev", "--port", String(PORT), "--ip", "127.0.0.1"];
    if (basePath) {
      // The deploy workflow rewrites these two lines the same way: assets
      // from the prefix-aware build, and the Worker first for "/" and the
      // prefix.
      const toml = readFileSync(`${apiDir}wrangler.toml`, "utf-8")
        .replace("directory = \"../web/dist\"", "directory = \"../web/dist-smoke\"")
        .replace(/^run_worker_first = .*$/m, `run_worker_first = ["/", "${basePath}/*", "/r/*"]`);
      assert(toml.includes("dist-smoke") && toml.includes(`"${basePath}/*"`), "could not derive the base-path wrangler config");
      writeFileSync(smokeConfig, toml);
      args.push("-c", "wrangler.smoke.toml", "--var", `BASE_PATH:${basePath}`, "--var", `HOME_PAGE:${homePage}`);
    }
    dev = Bun.spawn(
      ["./node_modules/.bin/wrangler", ...args],
      {
        cwd: new URL("../../apps/api", import.meta.url).pathname,
        env: {
          ...process.env,
          CI: "1",
          WRANGLER_SEND_METRICS: "false",
        },
        stdout: process.env.WORKERS_SMOKE_DEBUG ? "inherit" : "pipe",
        stderr: process.env.WORKERS_SMOKE_DEBUG ? "inherit" : "pipe",
      },
    );
  }

  const { suite, skipped }: { suite: Case[]; skipped: Case[] } = basePath
    ? { suite: [...baseCases, ...feedBaseCases], skipped: [] }
    : selectSuite(options);

  let failures = 0;
  try {
    await waitForBoot(120_000);
    for (const c of suite) {
      try {
        await c.run();
        console.log(`  ok    ${c.name}`);
      }
      catch (err) {
        failures++;
        console.error(`  FAIL  ${c.name}`);
        console.error(`        ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const c of skipped)
      console.log(`  skip  ${c.name}\n        an OIDC deployment has no password to log in with: set SMOKE_REGISTRY_TOKEN and SMOKE_REGISTRY_PACKAGE`);
    for (const cleanup of cleanups)
      await cleanup().catch(err => note(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`));
    if (leftBehind.length > 0)
      console.log(`\nLeft behind, unless the run failed before publishing them (a token cannot delete a published version):\n${leftBehind.map(l => `  ${l}`).join("\n")}\nThe channel keeps its version from being deleted on its own: delete the whole package (a dedicated one) from a session of its owner or of an administrator.`);
  }
  finally {
    dev?.kill();
    rmSync(smokeConfig, { force: true });
  }

  console.log(`\n${suite.length - failures}/${suite.length} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
