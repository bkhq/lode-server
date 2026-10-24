import type { AppDeps } from "@/app";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { buildOuterApp, buildRawApp } from "@/app";
import { configSchema } from "@/config/schema";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { users } from "@/modules/account/users/schema";
import { policyMiddleware } from "@/modules/policy";
import { errorHandler } from "@/shared/middleware/error-handler";
import { __resetRateLimitForTests } from "@/shared/middleware/rate-limit";
import { registryFeedRoutes, registryRoutes } from ".";
import { __resetBlobStoresForTests } from "./blob";
import { bytesOf, sha256Hex } from "./blob/testing";
import { registryDelegations, registryNamespaces } from "./schema";
import { artifactMessage, canonicalCatalog, delegationMessage, encodeBase64Url, keyIdOf, manifestMessage, revocationMessage, verifyEd25519 } from "./signature";
import vectors from "./testdata/delegation-vectors.json";
import "@/modules/account";

const noop = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  flush() {},
} as unknown as Logger;
const ORIGIN = "https://pkg.example.test";
const NOW = () => Math.floor(Date.now() / 1000);

let dir: string;
let db: AppDatabase;
let config: Config;

beforeEach(async () => {
  __resetBlobStoresForTests();
  await __resetRateLimitForTests();
  dir = mkdtempSync(resolve(tmpdir(), "registry-delegation-"));
  db = await createDb(resolve(dir, "app.db"));
  config = configSchema.parse({
    NODE_ENV: "test",
    APP_URL: ORIGIN,
    REGISTRY_BLOB_LOCAL_ROOT: join(dir, "blobs"),
  });
});

afterEach(() => {
  __resetBlobStoresForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function app() {
  const api = new Hono<AppEnv>();
  api.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("logger", noop);
    await next();
  });
  api.use("*", policyMiddleware({ basePath: `${config.BASE_PATH}/api` }));
  api.route("/", registryRoutes());
  api.onError(errorHandler);
  const deps: AppDeps = {
    config,
    db,
    logger: noop,
    encryption: {
      isSystemLocked: () => false,
    } as unknown as AppDeps["encryption"],
  };
  return buildOuterApp(api, config, undefined, undefined, buildRawApp(deps, registryFeedRoutes()));
}

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

interface Publisher {
  readonly call: Call;
  readonly put: (path: string, body: Uint8Array, query?: Record<string, string>) => Promise<Response>;
}

/** A signed-in user whose namespace slug is their id, owning the public package `slug`. */
async function seedPublisher(id: string, slug: string): Promise<Publisher> {
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: id,
    name: id,
    email: `${id}@t.io`,
    role: "user",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  await db.insert(registryNamespaces).values({ id: `ns-${id}`, slug: id, ownerUserId: id }).run();
  const cookie = `session_id=${await createSession(db, id, "access", undefined, 3600)}`;
  const publisher: Publisher = {
    call: async (method, path, body) => await app().request(`/api/registry${path}`, {
      method,
      headers: { "Cookie": cookie, "Content-Type": "application/json" },
      ...(body !== undefined && {
        body: JSON.stringify(body),
      }),
    }),
    put: async (path, body, query = {}) => await app().request(`/api/registry${path}?${new URLSearchParams({
      sha256: sha256Hex(body),
      ...query,
    })}`, {
      method: "PUT",
      headers: {
        "Cookie": cookie,
        "Content-Length": String(body.length),
      },
      body,
    } as RequestInit),
  };
  expect((await publisher.call("POST", "/packages", { name: slug, slug })).status).toBe(201);
  return publisher;
}

function withToken(bearer: string): Call {
  return async (method, path, body) => await app().request(`/api/registry${path}`, {
    method,
    headers: { "Authorization": `Bearer ${bearer}`, "Content-Type": "application/json" },
    ...(body !== undefined && {
      body: JSON.stringify(body),
    }),
  });
}

async function token(owner: Publisher, pkg: string, access: string): Promise<string> {
  const res = await owner.call("POST", "/tokens", {
    name: "ci",
    grants: [
      { package: pkg, access },
    ],
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { token: string } }).data.token;
}

async function refusal(res: Response): Promise<string> {
  return `${res.status} ${((await res.json()) as { error: { code: string } }).error.code}`;
}

async function dataOf<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: T }).data;
}

interface Key {
  readonly keyId: string;
  readonly publicKey: string;
  readonly sign: (message: Uint8Array<ArrayBuffer>) => Promise<string>;
}

/** A fresh ed25519 keypair, what `lode-cli keygen` makes. */
async function keygen(): Promise<Key> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    keyId: await keyIdOf(raw),
    publicKey: encodeBase64Url(raw),
    sign: async message => encodeBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message))),
  };
}

/** What `lode-cli delegate --key <root> --sub <sub> --app <name>` writes. */
async function delegate(root: Key, sub: Key, name: string, window: { notBefore?: number; notAfter?: number } = {}) {
  const notBefore = window.notBefore ?? NOW() - 300;
  const notAfter = window.notAfter ?? NOW() + 30 * 86400;
  return {
    key: `ed25519:${sub.keyId}:${sub.publicKey}`,
    name,
    not_before: notBefore,
    not_after: notAfter,
    issuer: root.keyId,
    sig: await root.sign(delegationMessage(name, sub.publicKey, notBefore, notAfter)),
  };
}

/** What `lode-cli revoke` writes. */
async function revocations(signer: Key, issuedAt: number, revoked: string[], delegation?: unknown) {
  return {
    schema: "lode-revocations/v1",
    issued_at: issuedAt,
    revoked,
    key_id: signer.keyId,
    ...(delegation !== undefined && { delegation }),
    sig: await signer.sign(revocationMessage(signer.keyId, issuedAt, revoked)),
  };
}

interface Manifest {
  name: string;
  key_id?: string;
  sig?: string;
  delegation?: Record<string, unknown>;
  channels: Record<string, { latest: string }>;
  versions: Record<string, { assets: { name: string; sha256: string; sig?: string; key_id?: string }[] }>;
}

async function manifestOf(pkg: string): Promise<Manifest> {
  const res = await app().request(`/r/${pkg}/manifest.json`);
  expect(res.status).toBe(200);
  return (await res.json()) as Manifest;
}

const PKG = "alice/demo";
const DELEGATION = `/packages/${PKG}/delegation`;
const REVOCATIONS = `/packages/${PKG}/revocations`;

interface Seeded {
  readonly alice: Publisher;
  readonly root: Key;
  readonly sub: Key;
}

/** alice/demo with a registered root key, and a sub-key that is not registered. */
async function seed(): Promise<Seeded> {
  const alice = await seedPublisher("alice", "demo");
  const root = await keygen();
  expect((await alice.call("POST", `/packages/${PKG}/keys`, { public_key: root.publicKey, name: "root" })).status).toBe(201);
  return { alice, root, sub: await keygen() };
}

/** Upload `bytes` as asset `tool` of a new draft, signed by `signer` when given. */
async function uploadSigned(alice: Publisher, version: string, signer?: Key, bytes = bytesOf(64, version.length)): Promise<Response> {
  expect((await alice.call("POST", `/packages/${PKG}/versions`, { version })).status).toBe(201);
  const sha256 = sha256Hex(bytes);
  const sig = signer && await signer.sign(artifactMessage({
    app: "demo",
    name: "tool",
    version,
    sha256,
  }));
  return await alice.put(`/packages/${PKG}/versions/${version}/assets/tool`, bytes, sig === undefined
    ? {}
    : { sig });
}

describe("delegation", () => {
  interface State { key_id: string; root_key_id: string; status: string; not_after: number }

  test("lode's own delegation is stored and served verbatim in the manifest", async () => {
    const alice = await seedPublisher("alice", "demo");
    expect((await alice.call("POST", "/packages/alice/demo/keys", { public_key: vectors.root.publicKey, name: "root" })).status).toBe(201);
    expect((await alice.call("POST", "/packages/alice/demo/versions", { version: "1.0.0" })).status).toBe(201);
    expect((await alice.put("/packages/alice/demo/versions/1.0.0/assets/tool", bytesOf(8))).status).toBe(201);
    expect((await alice.call("POST", "/packages/alice/demo/versions/1.0.0/publish", { channel: "stable" })).status).toBe(200);

    const state = await dataOf<State>(await alice.call("PUT", DELEGATION, vectors.delegation));
    expect(state).toMatchObject({ key_id: vectors.sub.keyId, root_key_id: vectors.root.keyId, status: "live" });
    expect(await dataOf<State>(await alice.call("GET", DELEGATION))).toEqual(state);
    expect((await manifestOf(PKG)).delegation).toEqual(vectors.delegation);
  });

  test("the sub-key signs uploads and the manifest while the delegation is live", async () => {
    const { alice, root, sub } = await seed();
    expect(await refusal(await uploadSigned(alice, "1.0.0", sub))).toBe("400 INVALID_SIGNATURE");

    expect((await alice.call("PUT", DELEGATION, await delegate(root, sub, "demo"))).status).toBe(200);
    const res = await alice.put(`/packages/${PKG}/versions/1.0.0/assets/tool`, bytesOf(64, 5), {
      sig: await sub.sign(artifactMessage({
        app: "demo",
        name: "tool",
        version: "1.0.0",
        sha256: sha256Hex(bytesOf(64, 5)),
      })),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { key_id: string } }).data.key_id).toBe(sub.keyId);
    expect((await alice.call("POST", `/packages/${PKG}/versions/1.0.0/publish`, { channel: "stable" })).status).toBe(200);

    const manifest = await manifestOf(PKG);
    expect(manifest.delegation).toMatchObject({ key: `ed25519:${sub.keyId}:${sub.publicKey}`, name: "demo", issuer: root.keyId });
    const signature = { key_id: sub.keyId, sig: await sub.sign(manifestMessage("demo", sub.keyId, canonicalCatalog(manifest))) };
    expect(await dataOf<{ status: string }>(await alice.call("PUT", `/packages/${PKG}/manifest-signature`, signature))).toMatchObject({ status: "live" });
    const served = await manifestOf(PKG);
    expect(served).toMatchObject({ ...signature, delegation: manifest.delegation });
    expect(await verifyEd25519(sub.publicKey, served.sig!, manifestMessage(served.name, served.key_id!, canonicalCatalog(served)))).toBe(true);

    // Without the delegation the sub-key is nobody.
    expect(await dataOf<{ removed: boolean }>(await alice.call("DELETE", DELEGATION))).toEqual({ removed: true });
    expect(await dataOf<{ removed: boolean }>(await alice.call("DELETE", DELEGATION))).toEqual({ removed: false });
    expect(await dataOf<null>(await alice.call("GET", DELEGATION))).toBeNull();
    const after = await manifestOf(PKG);
    expect(after.delegation).toBeUndefined();
    expect(after.sig).toBeUndefined();
    expect(await dataOf<{ status: string }>(await alice.call("GET", `/packages/${PKG}/manifest-signature`))).toMatchObject({ status: "revoked" });
    expect(await refusal(await uploadSigned(alice, "1.1.0", sub))).toBe("400 INVALID_SIGNATURE");
  });

  test("outside its window or with its root revoked it is not served and verifies nothing", async () => {
    const { alice, root, sub } = await seed();
    expect((await alice.call("PUT", DELEGATION, await delegate(root, sub, "demo", { notBefore: NOW() + 3600 }))).status).toBe(200);
    expect(await dataOf<State>(await alice.call("GET", DELEGATION))).toMatchObject({ status: "pending" });
    expect((await manifestOf(PKG)).delegation).toBeUndefined();
    expect(await refusal(await uploadSigned(alice, "1.0.0", sub))).toBe("400 INVALID_SIGNATURE");

    await db.update(registryDelegations).set({
      notBefore: NOW() - 7200,
      notAfter: NOW(),
    }).run();
    expect(await dataOf<State>(await alice.call("GET", DELEGATION))).toMatchObject({ status: "expired" });
    expect((await manifestOf(PKG)).delegation).toBeUndefined();

    await db.update(registryDelegations).set({ notAfter: NOW() + 3600 }).run();
    expect(await dataOf<State>(await alice.call("GET", DELEGATION))).toMatchObject({ status: "live" });
    const keys = await dataOf<{ id: string }[]>(await alice.call("GET", `/packages/${PKG}/keys`));
    expect((await alice.call("DELETE", `/packages/${PKG}/keys/${keys[0]!.id}`)).status).toBe(200);
    expect(await dataOf<State>(await alice.call("GET", DELEGATION))).toMatchObject({ status: "revoked" });
    expect((await manifestOf(PKG)).delegation).toBeUndefined();
  });

  test("nothing unverified is stored", async () => {
    const { alice, root, sub } = await seed();
    const stranger = await keygen();
    const good = await delegate(root, sub, "demo");

    expect(await refusal(await alice.call("PUT", DELEGATION, await delegate(root, sub, "other")))).toBe("400 INVALID_DELEGATION");
    expect(await refusal(await alice.call("PUT", DELEGATION, await delegate(stranger, sub, "demo")))).toBe("400 INVALID_DELEGATION");
    expect(await refusal(await alice.call("PUT", DELEGATION, { ...good, not_after: good.not_after + 1 }))).toBe("400 INVALID_DELEGATION");
    expect(await refusal(await alice.call("PUT", DELEGATION, { ...good, key: `ecdsa-p256:${sub.publicKey}` }))).toBe("400 INVALID_DELEGATION");
    expect(await refusal(await alice.call("PUT", DELEGATION, await delegate(root, sub, "demo", { notBefore: NOW() - 7200, notAfter: NOW() - 1 })))).toBe("400 DELEGATION_EXPIRED");
    expect(await refusal(await alice.call("PUT", DELEGATION, await delegate(root, sub, "demo", { notBefore: NOW() + 10, notAfter: NOW() + 10 })))).toBe("400 INVALID_DELEGATION");
    // A root is not a sub-key, revoked or not.
    expect(await refusal(await alice.call("PUT", DELEGATION, await delegate(root, root, "demo")))).toBe("409 KEY_REGISTERED");
    expect((await alice.call("PUT", DELEGATION, { ...good, alg: "ed25519" })).status).toBe(422);
    // lode's vector is signed by a root this package does not have.
    expect(await refusal(await alice.call("PUT", DELEGATION, vectors.delegation))).toBe("400 INVALID_DELEGATION");

    expect(await dataOf<null>(await alice.call("GET", DELEGATION))).toBeNull();
  });

  test("the sub-key cannot be registered as a key of the package", async () => {
    const { alice, root, sub } = await seed();
    expect((await alice.call("PUT", DELEGATION, await delegate(root, sub, "demo"))).status).toBe(200);
    // `lode-cli publish --key-env` registers its key first and goes on at KEY_EXISTS.
    expect(await refusal(await alice.call("POST", `/packages/${PKG}/keys`, { public_key: sub.publicKey, name: "ci" }))).toBe("409 KEY_EXISTS");
    expect((await dataOf<unknown[]>(await alice.call("GET", `/packages/${PKG}/keys`))).length).toBe(1);
  });

  test("a write token manages it, a read token only sees it, another user neither", async () => {
    const { alice, root, sub } = await seed();
    const body = await delegate(root, sub, "demo");
    const reader = withToken(await token(alice, PKG, "read"));
    const writer = withToken(await token(alice, PKG, "write"));
    const bob = await seedPublisher("bob", "other");

    expect((await reader("PUT", DELEGATION, body)).status).toBe(403);
    expect((await bob.call("PUT", DELEGATION, body)).status).toBe(403);
    expect((await writer("PUT", DELEGATION, body)).status).toBe(200);
    expect((await reader("GET", DELEGATION)).status).toBe(200);
    expect((await reader("DELETE", DELEGATION)).status).toBe(403);
    expect((await bob.call("DELETE", DELEGATION)).status).toBe(403);
    expect((await writer("DELETE", DELEGATION)).status).toBe(200);
  });
});

describe("revocation list", () => {
  interface View { issued_at: number; revoked: string[]; key_id: string }

  async function feedList(pkg = PKG): Promise<Response> {
    return await app().request(`/r/${pkg}/revocations.json`);
  }

  test("lode's own lists, by the root and then by a delegated sub-key, are stored and served verbatim", async () => {
    const alice = await seedPublisher("alice", "demo");
    expect((await alice.call("POST", "/packages/alice/demo/keys", { public_key: vectors.root.publicKey, name: "root" })).status).toBe(201);
    expect((await feedList()).status).toBe(404);
    expect(await dataOf<null>(await alice.call("GET", REVOCATIONS))).toBeNull();

    expect(await dataOf<View>(await alice.call("PUT", REVOCATIONS, vectors.revocationsByRoot))).toMatchObject({ revoked: vectors.revocationsByRoot.revoked, key_id: vectors.root.keyId });
    let served = await feedList();
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await served.json()).toEqual(vectors.revocationsByRoot);

    expect((await alice.call("PUT", REVOCATIONS, vectors.revocationsBySub)).status).toBe(200);
    served = await feedList();
    expect(await served.json()).toEqual(vectors.revocationsBySub);
    expect(await dataOf<View>(await alice.call("GET", REVOCATIONS))).toMatchObject({ issued_at: vectors.revocationsBySub.issued_at, revoked: vectors.revocationsBySub.revoked });
  });

  test("revoking the sub-key ends its delegation and its signatures at once", async () => {
    const { alice, root, sub } = await seed();
    expect((await alice.call("PUT", DELEGATION, await delegate(root, sub, "demo"))).status).toBe(200);
    expect((await uploadSigned(alice, "1.0.0", sub)).status).toBe(201);

    expect((await alice.call("PUT", REVOCATIONS, await revocations(root, NOW(), [sub.keyId]))).status).toBe(200);
    expect(await dataOf<{ status: string }>(await alice.call("GET", DELEGATION))).toMatchObject({ status: "revoked" });
    expect((await manifestOf(PKG)).delegation).toBeUndefined();
    expect(await refusal(await uploadSigned(alice, "1.1.0", sub))).toBe("400 INVALID_SIGNATURE");
    // It cannot come back as a delegation or as a registered key.
    expect(await refusal(await alice.call("PUT", DELEGATION, await delegate(root, sub, "demo")))).toBe("400 KEY_REVOKED");
    expect(await refusal(await alice.call("POST", `/packages/${PKG}/keys`, { public_key: sub.publicKey, name: "ci" }))).toBe("400 KEY_REVOKED");
  });

  test("a sub-key signs a list with its own delegation, unless it is revoked", async () => {
    const { alice, root, sub } = await seed();
    const other = await keygen();
    const delegation = await delegate(root, sub, "demo");
    expect((await alice.call("PUT", REVOCATIONS, await revocations(sub, NOW() - 10, [other.keyId], delegation))).status).toBe(200);
    // Without its delegation, or with one for another app, it is nobody.
    expect(await refusal(await alice.call("PUT", REVOCATIONS, await revocations(sub, NOW() - 5, [other.keyId])))).toBe("400 INVALID_SIGNATURE");
    expect(await refusal(await alice.call("PUT", REVOCATIONS, await revocations(sub, NOW() - 5, [other.keyId], await delegate(root, sub, "other"))))).toBe("400 INVALID_SIGNATURE");

    expect((await alice.call("PUT", REVOCATIONS, await revocations(root, NOW() - 5, [other.keyId, sub.keyId]))).status).toBe(200);
    expect(await refusal(await alice.call("PUT", REVOCATIONS, await revocations(sub, NOW(), [other.keyId, sub.keyId, "0123456789abcdef"], delegation)))).toBe("400 INVALID_SIGNATURE");
  });

  test("a list only ever grows, and only forward", async () => {
    const { alice, root } = await seed();
    const [a, b] = ["0123456789abcdef", "fedcba9876543210"];
    expect((await alice.call("PUT", REVOCATIONS, await revocations(root, NOW() - 100, [a]))).status).toBe(200);

    expect(await refusal(await alice.call("PUT", REVOCATIONS, await revocations(root, NOW() - 100, [a, b])))).toBe("409 REVOCATIONS_OUTDATED");
    expect(await refusal(await alice.call("PUT", REVOCATIONS, await revocations(root, NOW() - 50, [b])))).toBe("400 REVOCATIONS_SHRINK");
    expect(await refusal(await alice.call("PUT", REVOCATIONS, await revocations(root, NOW() + 7200, [a, b])))).toBe("400 REVOCATIONS_FUTURE");
    const signed = await revocations(root, NOW() - 50, [a, b]);
    expect(await refusal(await alice.call("PUT", REVOCATIONS, { ...signed, issued_at: signed.issued_at + 1 }))).toBe("400 INVALID_SIGNATURE");
    expect(await refusal(await alice.call("PUT", REVOCATIONS, await revocations(await keygen(), NOW() - 50, [a, b])))).toBe("400 INVALID_SIGNATURE");
    expect((await alice.call("PUT", REVOCATIONS, {
      ...signed,
      revoked: ["not-a-key-id"],
    })).status).toBe(422);
    expect((await alice.call("PUT", REVOCATIONS, { ...signed, schema: "lode-revocations/v2" })).status).toBe(422);
    expect(await dataOf<View>(await alice.call("GET", REVOCATIONS))).toMatchObject({
      revoked: [a],
    });

    expect((await alice.call("PUT", REVOCATIONS, signed)).status).toBe(200);
    expect(await dataOf<View>(await alice.call("GET", REVOCATIONS))).toMatchObject({
      revoked: [a, b],
    });
  });

  test("a private package's list needs a read token, like its manifest", async () => {
    const { alice, root } = await seed();
    expect((await alice.call("PATCH", `/packages/${PKG}`, { visibility: "private" })).status).toBe(200);
    expect((await alice.call("PUT", REVOCATIONS, await revocations(root, NOW(), ["0123456789abcdef"]))).status).toBe(200);
    expect((await feedList()).status).toBe(404);
    const res = await app().request(`/r/${PKG}/revocations.json`, {
      headers: { Authorization: `Bearer ${await token(alice, PKG, "read")}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("a write token publishes it, a read token only sees it", async () => {
    const { alice, root } = await seed();
    const body = await revocations(root, NOW(), ["0123456789abcdef"]);
    const reader = withToken(await token(alice, PKG, "read"));
    expect((await reader("PUT", REVOCATIONS, body)).status).toBe(403);
    expect((await withToken(await token(alice, PKG, "write"))("PUT", REVOCATIONS, body)).status).toBe(200);
    expect((await reader("GET", REVOCATIONS)).status).toBe(200);
  });
});

describe("asset re-sign", () => {
  const SIGNATURE = `/packages/${PKG}/versions/1.0.0/assets/tool/signature`;

  async function signatureFor(signer: Key, bytes: Uint8Array): Promise<string> {
    return await signer.sign(artifactMessage({
      app: "demo",
      name: "tool",
      version: "1.0.0",
      sha256: sha256Hex(bytes),
    }));
  }

  test("a published asset moves to a new sub-key, and the manifest signature stays live", async () => {
    const { alice, root, sub } = await seed();
    const bytes = bytesOf(64, 9);
    expect((await alice.call("PUT", DELEGATION, await delegate(root, sub, "demo"))).status).toBe(200);
    expect((await uploadSigned(alice, "1.0.0", sub, bytes)).status).toBe(201);
    expect((await alice.call("POST", `/packages/${PKG}/versions/1.0.0/publish`, { channel: "stable" })).status).toBe(200);

    // The sub-key rotates.
    const next = await keygen();
    expect((await alice.call("PUT", DELEGATION, await delegate(root, next, "demo"))).status).toBe(200);
    const manifest = await manifestOf(PKG);
    const signature = { key_id: next.keyId, sig: await next.sign(manifestMessage("demo", next.keyId, canonicalCatalog(manifest))) };
    expect((await alice.call("PUT", `/packages/${PKG}/manifest-signature`, signature)).status).toBe(200);

    expect(await refusal(await alice.call("PUT", SIGNATURE, { sig: await signatureFor(sub, bytes) }))).toBe("400 INVALID_SIGNATURE");
    const sig = await signatureFor(next, bytes);
    expect(await dataOf<{ key_id: string; sig: string }>(await alice.call("PUT", SIGNATURE, { sig }))).toMatchObject({ key_id: next.keyId, sig });
    const served = await manifestOf(PKG);
    expect(served.versions["1.0.0"]!.assets[0]).toMatchObject({ sig, key_id: next.keyId });
    expect(served.sig).toBe(signature.sig);
    expect(await dataOf<{ status: string }>(await alice.call("GET", `/packages/${PKG}/manifest-signature`))).toMatchObject({ status: "live" });

    // A registered root signs it as well.
    expect(await dataOf<{ key_id: string }>(await alice.call("PUT", SIGNATURE, { sig: await signatureFor(root, bytes) }))).toMatchObject({ key_id: root.keyId });
  });

  test("an unsigned asset of a yanked version can be signed; what does not verify or exist is refused", async () => {
    const { alice, root } = await seed();
    const bytes = bytesOf(64, 9);
    expect((await uploadSigned(alice, "1.0.0", undefined, bytes)).status).toBe(201);
    expect((await uploadSigned(alice, "2.0.0")).status).toBe(201);
    expect((await alice.call("POST", `/packages/${PKG}/versions/1.0.0/publish`, { channel: "old" })).status).toBe(200);
    expect((await alice.call("POST", `/packages/${PKG}/versions/2.0.0/publish`, { channel: "old" })).status).toBe(200);
    expect((await alice.call("POST", `/packages/${PKG}/versions/1.0.0/yank`)).status).toBe(200);

    expect(await refusal(await alice.call("PUT", SIGNATURE, { sig: await signatureFor(root, bytesOf(64, 8)) }))).toBe("400 INVALID_SIGNATURE");
    expect((await alice.call("PUT", `/packages/${PKG}/versions/1.0.0/assets/missing/signature`, { sig: "x" })).status).toBe(404);
    expect((await alice.call("PUT", `/packages/${PKG}/versions/9.9.9/assets/tool/signature`, { sig: "x" })).status).toBe(404);
    expect((await alice.call("PUT", SIGNATURE, { sig: "" })).status).toBe(422);
    expect((await alice.call("PUT", SIGNATURE, { sig: await signatureFor(root, bytes) })).status).toBe(200);
  });

  test("a write token re-signs, a read token cannot", async () => {
    const { alice, root } = await seed();
    const bytes = bytesOf(64, 9);
    expect((await uploadSigned(alice, "1.0.0", root, bytes)).status).toBe(201);
    const body = { sig: await signatureFor(root, bytes) };
    expect((await withToken(await token(alice, PKG, "read"))("PUT", SIGNATURE, body)).status).toBe(403);
    expect((await withToken(await token(alice, PKG, "write"))("PUT", SIGNATURE, body)).status).toBe(200);
  });
});
