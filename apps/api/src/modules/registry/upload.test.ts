import type { AppDeps } from "@/app";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { buildFullApp } from "@/app";
import { configSchema } from "@/config/schema";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { users } from "@/modules/account/users/schema";
import { stopAuditRetentionSweep } from "@/modules/audit";
import { auditEvents } from "@/modules/audit/schema";
import { __setLocalDriverRootForTests } from "@/modules/file/storage/local";
import { policyMiddleware } from "@/modules/policy";
import { getPlatform, setPlatform } from "@/platform";
import { errorHandler } from "@/shared/middleware/error-handler";
import { getUsage, registryRoutes, startRegistryUploadSweep, stopRegistryUploadSweep } from ".";
import { __resetBlobStoresForTests } from "./blob";
import { bytesOf, sha256Hex } from "./blob/testing";
import { registryAssets, registryNamespaces, registryPackages, registryQuotas, registryUploads } from "./schema";
import { delegationMessage, encodeBase64Url } from "./signature";
import fixture from "./testdata/vectors.json";
import { __setPartSizeForTests, MULTIPART_PART_SIZE, runUploadSweepOnce } from "./upload.service";
import "@/modules/account";

const { signer, vectors } = fixture;

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

// Small enough that a three-part upload is a few kilobytes.
const PART = 1000;

let dir: string;
let blobRoot: string;
let db: AppDatabase;
let config: Config;

beforeEach(async () => {
  __resetBlobStoresForTests();
  __setPartSizeForTests(PART);
  dir = mkdtempSync(resolve(tmpdir(), "registry-upload-"));
  blobRoot = join(dir, "blobs");
  db = await createDb(resolve(dir, "app.db"));
  config = configSchema.parse({ NODE_ENV: "test", REGISTRY_BLOB_LOCAL_ROOT: blobRoot });
});

afterEach(async () => {
  await stopRegistryUploadSweep();
  __setPartSizeForTests(undefined);
  __resetBlobStoresForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function app(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("logger", noop);
    await next();
  });
  api.use("*", policyMiddleware({ basePath: "/api" }));
  api.route("/", registryRoutes());
  api.onError(errorHandler);
  const root = new Hono<AppEnv>();
  root.route("/api", api);
  return root;
}

interface Client {
  readonly id: string;
  readonly call: (method: string, path: string, body?: unknown) => Promise<Response>;
  /** `PUT` a raw body; `length` null sends no `Content-Length`. */
  readonly put: (path: string, body: Uint8Array | ReadableStream<Uint8Array>, length?: number | null) => Promise<Response>;
}

function client(id: string, auth: Record<string, string>): Client {
  return {
    id,
    call: async (method, path, body) => await app().request(`/api/registry${path}`, {
      method,
      headers: { ...auth, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    put: async (path, body, length = body instanceof Uint8Array ? body.length : null) => await app().request(`/api/registry${path}`, {
      method: "PUT",
      headers: { ...auth, ...(length !== null && { "Content-Length": String(length) }) },
      body,
      duplex: "half",
    } as RequestInit),
  };
}

async function seedUser(id: string, role: "user" | "admin" = "user"): Promise<Client> {
  const now = new Date().toISOString();
  await db.insert(users).values({ id, oauthSub: `sub-${id}`, username: id, name: id, email: `${id}@t.io`, role, status: "active", createdAt: now, updatedAt: now }).run();
  const session = await createSession(db, id, "access", undefined, 3600);
  return client(id, { Cookie: `session_id=${session}` });
}

/** A user whose namespace slug is their id, owning `packages` (by slug). */
async function seedPublisher(id: string, packages: readonly string[] = []): Promise<Client> {
  const publisher = await seedUser(id);
  await db.insert(registryNamespaces).values({ id: `ns-${id}`, slug: id, ownerUserId: id }).run();
  for (const slug of packages)
    expect((await publisher.call("POST", "/packages", { slug, name: slug })).status).toBe(201);
  return publisher;
}

async function mint(owner: Client, grants: unknown): Promise<Client & { tokenId: string }> {
  const res = await owner.call("POST", "/tokens", { name: "ci", grants });
  expect(res.status).toBe(201);
  const created = await data<{ id: string; token: string }>(res);
  return { ...client(owner.id, { Authorization: `Bearer ${created.token}` }), tokenId: created.id };
}

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function expectError(res: Response, status: number, code: string): Promise<void> {
  const body = (await res.json()) as { error?: { code: string } };
  expect({ status: res.status, code: body.error?.code }).toEqual({ status, code });
}

async function draft(who: Client, pkg: string, version = "1.0.0"): Promise<string> {
  const res = await who.call("POST", `/packages/${pkg}/versions`, { version });
  expect(res.status).toBe(201);
  return (await data<{ id: string }>(res)).id;
}

interface Started {
  readonly uploadId: string;
  readonly partSize: number;
  readonly partCount: number;
}

/** Start an upload of `bytes` as `asset`; `changes` overrides the declared fields. */
async function start(who: Client, pkg: string, asset: string, bytes: Uint8Array, changes: Record<string, unknown> = {}, version = "1.0.0"): Promise<Response> {
  return await who.call("POST", `/packages/${pkg}/versions/${version}/uploads`, { asset, size: bytes.length, sha256: sha256Hex(bytes), ...changes });
}

async function started(res: Response): Promise<Started> {
  expect(res.status).toBe(201);
  return await data<Started>(res);
}

function partOf(bytes: Uint8Array, n: number): Uint8Array {
  return bytes.subarray((n - 1) * PART, n * PART);
}

async function putParts(who: Client, upload: Started, bytes: Uint8Array): Promise<void> {
  for (let n = 1; n <= upload.partCount; n++)
    expect((await who.put(`/uploads/${upload.uploadId}/parts/${n}`, partOf(bytes, n))).status).toBe(200);
}

async function uploadRows() {
  return await db.select().from(registryUploads).all();
}

async function assetRows() {
  return await db.select().from(registryAssets).all();
}

async function packageId(slug: string): Promise<string> {
  return (await db.select().from(registryPackages).where(eq(registryPackages.slug, slug)).get())!.id;
}

async function blobPath(pkg: string, versionId: string, asset: string): Promise<string> {
  return join(blobRoot, "objects", "pkg", await packageId(pkg), versionId, asset);
}

/** The multipart uploads the local store still holds parts for. */
function storedUploads(): string[] {
  const root = join(blobRoot, "multipart");
  return existsSync(root) ? readdirSync(root) : [];
}

async function auditActions(): Promise<string[]> {
  return (await db.select().from(auditEvents).all()).map(e => e.action).filter(a => a.startsWith("registry.upload") || a.startsWith("registry.asset"));
}

/**
 * A request body that records what became of it. An upload refused before
 * the blob store took its body has that body read to the end and discarded
 * (see `discardUnreadBody`), never cancelled.
 */
function refusedBody() {
  const seen = { drained: false, cancelled: false };
  let left = 3;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left-- > 0) {
        controller.enqueue(new Uint8Array(1024));
        return;
      }
      seen.drained = true;
      controller.close();
    },
    cancel() {
      seen.cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { body, seen };
}

describe("multipart upload", () => {
  test("three parts become one verified asset", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const versionId = await draft(alice, "alice/tool");
    const bytes = bytesOf(2500);

    const upload = await started(await start(alice, "alice/tool", "big.bin", bytes, { run: "./tool serve", exec: "" }));
    expect(upload).toEqual({ uploadId: upload.uploadId, partSize: PART, partCount: 3 });
    // Reserved from the start, before a byte arrived.
    expect((await getUsage(db, "alice")).storageBytes).toBe(2500);
    expect(await assetRows()).toHaveLength(0);

    // Any order; a part sent again replaces the earlier one.
    expect((await alice.put(`/uploads/${upload.uploadId}/parts/3`, partOf(bytes, 3))).status).toBe(200);
    expect((await alice.put(`/uploads/${upload.uploadId}/parts/2`, bytesOf(PART, 99))).status).toBe(200);
    const first = await alice.put(`/uploads/${upload.uploadId}/parts/1`, partOf(bytes, 1));
    expect(await data<unknown>(first)).toEqual({ part_number: 1, size: PART });
    expect((await alice.put(`/uploads/${upload.uploadId}/parts/2`, partOf(bytes, 2))).status).toBe(200);

    const completed = await alice.call("POST", `/uploads/${upload.uploadId}/complete`);
    expect(completed.status).toBe(201);
    expect(await data(completed)).toMatchObject({ name: "big.bin", size: 2500, sha256: sha256Hex(bytes), sig: null, key_id: null, alg: null, run: "./tool serve", exec: null });

    expect(sha256Hex(readFileSync(await blobPath("tool", versionId, "big.bin")))).toBe(sha256Hex(bytes));
    expect(await uploadRows()).toHaveLength(0);
    expect(storedUploads()).toHaveLength(0);
    // Moved from in flight to stored, counted once.
    expect((await getUsage(db, "alice")).storageBytes).toBe(2500);
    expect(await auditActions()).toEqual(["registry.upload.started", "registry.asset.uploaded"]);

    expect((await alice.call("POST", `/uploads/${upload.uploadId}/complete`)).status).toBe(404);
    expect((await alice.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" })).status).toBe(200);
  });

  test("the part size is 64 MiB and not the caller's to choose", async () => {
    __setPartSizeForTests(undefined);
    expect(MULTIPART_PART_SIZE).toBe(67108864);
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const res = await alice.call("POST", "/packages/alice/tool/versions/1.0.0/uploads", { asset: "big.bin", size: 200 * 1024 * 1024, sha256: "0".repeat(64), partSize: 5 });
    expect(await started(res)).toMatchObject({ partSize: 67108864, partCount: 4 });
  });

  test("content that does not hash to the declared sha256 is refused at complete", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const versionId = await draft(alice, "alice/tool");
    const bytes = bytesOf(2500);
    const upload = await started(await start(alice, "alice/tool", "big.bin", bytes, { sha256: sha256Hex(bytesOf(2500, 2)) }));
    await putParts(alice, upload, bytes);

    await expectError(await alice.call("POST", `/uploads/${upload.uploadId}/complete`), 422, "DIGEST_MISMATCH");
    expect(await assetRows()).toHaveLength(0);
    expect(existsSync(await blobPath("tool", versionId, "big.bin"))).toBe(false);
    expect(await uploadRows()).toHaveLength(0);
    expect(storedUploads()).toHaveLength(0);
    expect((await getUsage(db, "alice")).storageBytes).toBe(0);
  });

  test("a part must be in range and exactly its expected size", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const bytes = bytesOf(2500);
    const upload = await started(await start(alice, "alice/tool", "big.bin", bytes));
    const parts = `/uploads/${upload.uploadId}/parts`;

    await expectError(await alice.put(`${parts}/1`, bytesOf(999)), 422, "INVALID_PART_SIZE");
    await expectError(await alice.put(`${parts}/1`, bytesOf(1001)), 422, "INVALID_PART_SIZE");
    // The last part is the remainder, not a full one.
    await expectError(await alice.put(`${parts}/3`, bytesOf(PART)), 422, "INVALID_PART_SIZE");
    for (const n of ["0", "4", "-1", "1.5", "x"])
      expect((await alice.put(`${parts}/${n}`, bytesOf(PART))).status).toBe(422);

    const { body, seen } = refusedBody();
    await expectError(await alice.put(`${parts}/1`, body, null), 411, "LENGTH_REQUIRED");
    expect(seen).toEqual({ drained: true, cancelled: false });
    const refused = refusedBody();
    await expectError(await alice.put(`${parts}/1`, refused.body, 999), 422, "INVALID_PART_SIZE");
    expect(refused.seen).toEqual({ drained: true, cancelled: false });

    // A body shorter than its Content-Length stores nothing.
    await expectError(await alice.put(`${parts}/1`, bytesOf(10), PART), 422, "PART_REJECTED");

    expect((await alice.put(`${parts}/1`, partOf(bytes, 1))).status).toBe(200);
    expect((await alice.put(`${parts}/3`, partOf(bytes, 3))).status).toBe(200);
    await expectError(await alice.call("POST", `/uploads/${upload.uploadId}/complete`), 409, "UPLOAD_INCOMPLETE");
    expect(await assetRows()).toHaveLength(0);

    // Still usable after every refusal above.
    expect((await alice.put(`${parts}/2`, partOf(bytes, 2))).status).toBe(200);
    expect((await alice.call("POST", `/uploads/${upload.uploadId}/complete`)).status).toBe(201);
  });

  test("the start request is validated like the single-request upload", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const bytes = bytesOf(2500);
    for (const changes of [{ asset: "../x" }, { asset: "" }, { sha256: sha256Hex(bytes).toUpperCase() }, { sha256: "abc" }, { size: 0 }, { size: 1.5 }, { size: "10" }, { run: "a\nb" }])
      expect((await start(alice, "alice/tool", "big.bin", bytes, changes)).status).toBe(422);
    expect((await start(alice, "alice/tool", "big.bin", bytes, {}, "9.9.9")).status).toBe(404);
    expect(await uploadRows()).toHaveLength(0);
  });

  test("over the asset limit or the storage quota is refused at start", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    await db.insert(registryQuotas).values({ userId: "alice", maxAssetBytes: 3000, maxStorageBytes: 5000 }).run();

    await expectError(await start(alice, "alice/tool", "huge.bin", bytesOf(3001)), 413, "ASSET_TOO_LARGE");
    const first = await started(await start(alice, "alice/tool", "a.bin", bytesOf(3000)));
    // The first upload's declared size is already held against the quota.
    await expectError(await start(alice, "alice/tool", "b.bin", bytesOf(2001)), 409, "STORAGE_QUOTA_EXCEEDED");
    expect(await uploadRows()).toHaveLength(1);
    expect(storedUploads()).toHaveLength(1);

    await db.delete(registryQuotas).run();
    // Nothing above the 500 MiB ceiling, whatever the configuration says.
    await expectError(await alice.call("POST", "/packages/alice/tool/versions/1.0.0/uploads", { asset: "huge.bin", size: 500 * 1024 * 1024 + 1, sha256: "0".repeat(64) }), 413, "ASSET_TOO_LARGE");

    expect((await alice.call("DELETE", `/uploads/${first.uploadId}`)).status).toBe(200);
    expect((await getUsage(db, "alice")).storageBytes).toBe(0);
  });

  test("starting an asset again replaces the upload in flight", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    await db.insert(registryQuotas).values({ userId: "alice", maxStorageBytes: 3000 }).run();
    const bytes = bytesOf(2500);
    const first = await started(await start(alice, "alice/tool", "big.bin", bytesOf(2500, 5)));
    await alice.put(`/uploads/${first.uploadId}/parts/1`, bytesOf(PART, 5));

    // Fits only because the first reservation is given up.
    const second = await started(await start(alice, "alice/tool", "big.bin", bytes));
    expect(second.uploadId).not.toBe(first.uploadId);
    expect((await uploadRows()).map(u => u.id)).toEqual([second.uploadId]);
    expect(storedUploads()).toHaveLength(1);
    expect((await alice.put(`/uploads/${first.uploadId}/parts/2`, bytesOf(PART))).status).toBe(404);

    await putParts(alice, second, bytes);
    expect((await alice.call("POST", `/uploads/${second.uploadId}/complete`)).status).toBe(201);
  });

  test("abort removes the upload and its parts", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const bytes = bytesOf(2500);
    const upload = await started(await start(alice, "alice/tool", "big.bin", bytes));
    await alice.put(`/uploads/${upload.uploadId}/parts/1`, partOf(bytes, 1));

    const aborted = await alice.call("DELETE", `/uploads/${upload.uploadId}`);
    expect(aborted.status).toBe(200);
    expect(await data<unknown>(aborted)).toEqual({ id: upload.uploadId });
    expect(await uploadRows()).toHaveLength(0);
    expect(storedUploads()).toHaveLength(0);
    expect((await getUsage(db, "alice")).storageBytes).toBe(0);
    expect((await alice.call("DELETE", `/uploads/${upload.uploadId}`)).status).toBe(404);
    expect(await auditActions()).toEqual(["registry.upload.started", "registry.upload.aborted"]);
  });

  test("completing replaces an asset of the same name", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const versionId = await draft(alice, "alice/tool");
    const old = bytesOf(64);
    expect((await alice.put(`/packages/alice/tool/versions/1.0.0/assets/big.bin?sha256=${sha256Hex(old)}`, old)).status).toBe(201);

    const bytes = bytesOf(2500);
    const upload = await started(await start(alice, "alice/tool", "big.bin", bytes));
    await putParts(alice, upload, bytes);
    expect((await alice.call("POST", `/uploads/${upload.uploadId}/complete`)).status).toBe(200);
    expect(await assetRows()).toMatchObject([{ name: "big.bin", size: 2500, sha256: sha256Hex(bytes) }]);
    expect(sha256Hex(readFileSync(await blobPath("tool", versionId, "big.bin")))).toBe(sha256Hex(bytes));
  });
});

describe("multipart upload: signatures", () => {
  const vector = vectors.find(v => v.id === "run")!;
  const content = new TextEncoder().encode(vector.content);
  const declared = { asset: vector.name, size: content.length, sha256: vector.sha256, sig: vector.sig, run: vector.run };

  test("a signature is verified at start and stored with its key", async () => {
    __setPartSizeForTests(20);
    const alice = await seedPublisher("alice", ["tool"]);
    await alice.call("POST", "/packages/alice/tool/keys", { public_key: signer.publicKey, name: "ci" });
    await draft(alice, "alice/tool", vector.version);
    const uploads = `/packages/alice/tool/versions/${vector.version}/uploads`;

    await expectError(await alice.call("POST", uploads, { ...declared, run: "./other" }), 400, "INVALID_SIGNATURE");
    await expectError(await alice.call("POST", uploads, { ...declared, asset: "renamed.tar.gz" }), 400, "INVALID_SIGNATURE");
    expect(await uploadRows()).toHaveLength(0);

    const upload = await started(await alice.call("POST", uploads, declared));
    expect(upload.partCount).toBe(2);
    await alice.put(`/uploads/${upload.uploadId}/parts/1`, content.subarray(0, 20));
    await alice.put(`/uploads/${upload.uploadId}/parts/2`, content.subarray(20));
    const completed = await alice.call("POST", `/uploads/${upload.uploadId}/complete`);
    expect(completed.status).toBe(201);
    expect(await data(completed)).toMatchObject({ name: vector.name, sig: vector.sig, key_id: signer.keyId, alg: "ed25519", run: vector.run });
  });

  test("an upload whose key was revoked since the start is refused at complete", async () => {
    __setPartSizeForTests(20);
    const alice = await seedPublisher("alice", ["tool"]);
    const key = await data<{ id: string }>(await alice.call("POST", "/packages/alice/tool/keys", { public_key: signer.publicKey, name: "ci" }));
    await draft(alice, "alice/tool", vector.version);
    const upload = await started(await alice.call("POST", `/packages/alice/tool/versions/${vector.version}/uploads`, declared));
    await alice.put(`/uploads/${upload.uploadId}/parts/1`, content.subarray(0, 20));
    await alice.put(`/uploads/${upload.uploadId}/parts/2`, content.subarray(20));

    expect((await alice.call("DELETE", `/packages/alice/tool/keys/${key.id}`)).status).toBe(200);
    await expectError(await alice.call("POST", `/uploads/${upload.uploadId}/complete`), 400, "INVALID_SIGNATURE");
    expect(await uploadRows()).toHaveLength(0);
    expect(await assetRows()).toHaveLength(0);
    expect(storedUploads()).toHaveLength(0);
  });

  test("an upload signed by a delegated sub-key is refused at complete once the delegation is gone", async () => {
    __setPartSizeForTests(20);
    const alice = await seedPublisher("alice", ["tool"]);
    // A registered root delegates to the vectors' signer.
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const root = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    await data(await alice.call("POST", "/packages/alice/tool/keys", { public_key: root, name: "root" }));
    const [notBefore, notAfter] = [Math.floor(Date.now() / 1000) - 60, Math.floor(Date.now() / 1000) + 3600];
    const sig = encodeBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, delegationMessage("tool", signer.publicKey, notBefore, notAfter))));
    await data(await alice.call("PUT", "/packages/alice/tool/delegation", { key: signer.publicKey, name: "tool", not_before: notBefore, not_after: notAfter, sig }));

    await draft(alice, "alice/tool", vector.version);
    const upload = await started(await alice.call("POST", `/packages/alice/tool/versions/${vector.version}/uploads`, declared));
    await alice.put(`/uploads/${upload.uploadId}/parts/1`, content.subarray(0, 20));
    await alice.put(`/uploads/${upload.uploadId}/parts/2`, content.subarray(20));

    await data(await alice.call("DELETE", "/packages/alice/tool/delegation"));
    await expectError(await alice.call("POST", `/uploads/${upload.uploadId}/complete`), 400, "INVALID_SIGNATURE");
    expect(await assetRows()).toHaveLength(0);
  });

  test("a package that requires signatures takes no unsigned upload", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await alice.call("PATCH", "/packages/alice/tool", { require_signature: true });
    await draft(alice, "alice/tool", vector.version);
    const uploads = `/packages/alice/tool/versions/${vector.version}/uploads`;
    await expectError(await alice.call("POST", uploads, { ...declared, sig: undefined }), 400, "SIGNATURE_REQUIRED");
    await expectError(await alice.call("POST", uploads, { ...declared, sig: " " }), 400, "SIGNATURE_REQUIRED");
    // No key registered: nothing it could verify under.
    await expectError(await alice.call("POST", uploads, declared), 400, "INVALID_SIGNATURE");
  });
});

describe("multipart upload: access", () => {
  test("only a caller with write access to the package reaches an upload", async () => {
    const alice = await seedPublisher("alice", ["tool", "other", "hidden"]);
    const bob = await seedPublisher("bob");
    const admin = await seedUser("root", "admin");
    await alice.call("PATCH", "/packages/alice/hidden", { visibility: "private" });
    await draft(alice, "alice/tool");
    await draft(alice, "alice/hidden");
    const bytes = bytesOf(2500);
    const upload = await started(await start(alice, "alice/tool", "big.bin", bytes));
    const hidden = await started(await start(alice, "alice/hidden", "big.bin", bytes));

    const elsewhere = await mint(alice, [{ package: "alice/other", access: "admin" }]);
    const reader = await mint(alice, [{ package: "alice/tool", access: "read" }]);
    const bobToken = await mint(bob, { all: "admin" });

    // The package is public, the upload is not: a stranger learns nothing.
    await expectError(await start(bob, "alice/tool", "x.bin", bytes), 403, "FORBIDDEN");
    expect((await start(bob, "alice/hidden", "x.bin", bytes)).status).toBe(404);
    for (const who of [bob, bobToken, elsewhere]) {
      for (const id of [upload.uploadId, hidden.uploadId, "nope"]) {
        const { body, seen } = refusedBody();
        expect((await who.put(`/uploads/${id}/parts/1`, body, PART)).status).toBe(404);
        expect(seen).toEqual({ drained: true, cancelled: false });
        expect((await who.call("POST", `/uploads/${id}/complete`)).status).toBe(404);
        expect((await who.call("DELETE", `/uploads/${id}`)).status).toBe(404);
      }
    }

    // A read grant sees the package but may not release to it.
    await expectError(await start(reader, "alice/tool", "x.bin", bytes), 403, "FORBIDDEN");
    await expectError(await reader.put(`/uploads/${upload.uploadId}/parts/1`, partOf(bytes, 1)), 403, "FORBIDDEN");
    await expectError(await reader.call("POST", `/uploads/${upload.uploadId}/complete`), 403, "FORBIDDEN");
    await expectError(await reader.call("DELETE", `/uploads/${upload.uploadId}`), 403, "FORBIDDEN");
    // Without a write grant the token has no `packages:write` scope, so the
    // routes are closed to it whatever the id: nothing to probe.
    for (const id of [hidden.uploadId, "nope"])
      await expectError(await reader.call("DELETE", `/uploads/${id}`), 403, "FORBIDDEN");

    expect((await app().request(`/api/registry/uploads/${upload.uploadId}`, { method: "DELETE" })).status).toBe(401);
    expect(await uploadRows()).toHaveLength(2);

    // An administrator acts on any package.
    expect((await admin.call("DELETE", `/uploads/${hidden.uploadId}`)).status).toBe(200);
    await putParts(alice, upload, bytes);
    expect((await alice.call("POST", `/uploads/${upload.uploadId}/complete`)).status).toBe(201);
  });

  test("a write-granted token runs the whole upload and is named in the audit trail", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const ci = await mint(alice, [{ package: "alice/tool", access: "write" }]);
    const bytes = bytesOf(2500);
    const upload = await started(await start(ci, "alice/tool", "big.bin", bytes));
    await putParts(ci, upload, bytes);
    expect((await ci.call("POST", `/uploads/${upload.uploadId}/complete`)).status).toBe(201);

    const events = (await db.select().from(auditEvents).all()).filter(e => e.action === "registry.upload.started" || e.action === "registry.asset.uploaded");
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.resourceName).toBe("alice/tool@1.0.0/big.bin");
      expect(JSON.parse(event.detail!)).toMatchObject({ owner_user_id: "alice", token_id: ci.tokenId, upload_id: upload.uploadId, size: 2500 });
    }
  });

  test("a suspended namespace takes no upload", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const bytes = bytesOf(2500);
    const upload = await started(await start(alice, "alice/tool", "big.bin", bytes));
    await db.update(registryNamespaces).set({ status: "suspended" }).where(eq(registryNamespaces.slug, "alice")).run();

    await expectError(await start(alice, "alice/tool", "x.bin", bytes), 403, "NAMESPACE_SUSPENDED");
    await expectError(await alice.put(`/uploads/${upload.uploadId}/parts/1`, partOf(bytes, 1)), 403, "NAMESPACE_SUSPENDED");
    await expectError(await alice.call("POST", `/uploads/${upload.uploadId}/complete`), 403, "NAMESPACE_SUSPENDED");
    await expectError(await alice.call("DELETE", `/uploads/${upload.uploadId}`), 403, "NAMESPACE_SUSPENDED");
  });
});

describe("multipart upload: version lifecycle", () => {
  test("only a draft takes an upload, and one published meanwhile refuses the rest", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const versionId = await draft(alice, "alice/tool");
    const small = bytesOf(64);
    expect((await alice.put(`/packages/alice/tool/versions/1.0.0/assets/tool?sha256=${sha256Hex(small)}`, small)).status).toBe(201);
    // Replacing the published asset is what must not happen.
    const bytes = bytesOf(2500);
    const upload = await started(await start(alice, "alice/tool", "tool", bytes));
    await putParts(alice, upload, bytes);
    const late = await started(await start(alice, "alice/tool", "late.bin", bytes));
    expect((await alice.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" })).status).toBe(200);

    await expectError(await start(alice, "alice/tool", "more.bin", bytes), 409, "VERSION_NOT_DRAFT");
    await expectError(await alice.put(`/uploads/${late.uploadId}/parts/1`, partOf(bytes, 1)), 409, "VERSION_NOT_DRAFT");
    await expectError(await alice.call("POST", `/uploads/${upload.uploadId}/complete`), 409, "VERSION_NOT_DRAFT");

    expect((await uploadRows()).map(u => u.id)).toEqual([late.uploadId]);
    expect(storedUploads()).toHaveLength(1);
    expect(await assetRows()).toMatchObject([{ name: "tool", size: 64, sha256: sha256Hex(small) }]);
    expect(sha256Hex(readFileSync(await blobPath("tool", versionId, "tool")))).toBe(sha256Hex(small));
  });

  test("deleting a draft aborts its uploads in the store", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    await draft(alice, "alice/tool", "2.0.0");
    const bytes = bytesOf(2500);
    const gone = await started(await start(alice, "alice/tool", "big.bin", bytes));
    await alice.put(`/uploads/${gone.uploadId}/parts/1`, partOf(bytes, 1));
    await started(await start(alice, "alice/tool", "other.bin", bytes));
    const kept = await started(await start(alice, "alice/tool", "big.bin", bytes, {}, "2.0.0"));
    expect(storedUploads()).toHaveLength(3);

    expect((await alice.call("DELETE", "/packages/alice/tool/versions/1.0.0")).status).toBe(200);
    expect((await uploadRows()).map(u => u.id)).toEqual([kept.uploadId]);
    expect(storedUploads()).toHaveLength(1);
    expect((await getUsage(db, "alice")).storageBytes).toBe(2500);
    expect((await alice.call("POST", `/uploads/${gone.uploadId}/complete`)).status).toBe(404);
  });

  test("deleting a package aborts its uploads in the store", async () => {
    const alice = await seedPublisher("alice", ["tool", "other"]);
    await draft(alice, "alice/tool");
    await draft(alice, "alice/other");
    const bytes = bytesOf(2500);
    const gone = await started(await start(alice, "alice/tool", "big.bin", bytes));
    await alice.put(`/uploads/${gone.uploadId}/parts/1`, partOf(bytes, 1));
    const kept = await started(await start(alice, "alice/other", "big.bin", bytes));

    expect((await alice.call("DELETE", "/packages/alice/tool")).status).toBe(200);
    expect((await uploadRows()).map(u => u.id)).toEqual([kept.uploadId]);
    expect(storedUploads()).toHaveLength(1);
  });
});

describe("expired-upload sweep", () => {
  test("an expired upload is aborted and its reservation freed", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const bytes = bytesOf(2500);
    const before = Date.now();
    const stale = await started(await start(alice, "alice/tool", "stale.bin", bytes));
    await alice.put(`/uploads/${stale.uploadId}/parts/1`, partOf(bytes, 1));
    const fresh = await started(await start(alice, "alice/tool", "fresh.bin", bytes));

    const row = (await uploadRows()).find(u => u.id === stale.uploadId)!;
    const ttl = Date.parse(row.expiresAt) - before;
    expect(ttl).toBeGreaterThanOrEqual(config.REGISTRY_UPLOAD_TTL_SECONDS * 1000);
    expect(ttl).toBeLessThan(config.REGISTRY_UPLOAD_TTL_SECONDS * 1000 + 60_000);

    expect(await runUploadSweepOnce(db, config)).toBe(0);
    expect((await getUsage(db, "alice")).storageBytes).toBe(5000);

    await db.update(registryUploads).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(registryUploads.id, stale.uploadId)).run();
    expect(await runUploadSweepOnce(db, config)).toBe(1);
    expect((await uploadRows()).map(u => u.id)).toEqual([fresh.uploadId]);
    expect(storedUploads()).toHaveLength(1);
    expect((await getUsage(db, "alice")).storageBytes).toBe(2500);
    expect((await alice.put(`/uploads/${stale.uploadId}/parts/2`, partOf(bytes, 2))).status).toBe(404);

    // The clock is a parameter, so a later run needs no waiting.
    expect(await runUploadSweepOnce(db, config, new Date(Date.now() + (config.REGISTRY_UPLOAD_TTL_SECONDS + 1) * 1000))).toBe(1);
    expect(await uploadRows()).toHaveLength(0);
    expect(storedUploads()).toHaveLength(0);
  });

  test("the scheduled task runs the sweep, and an interval of 0 disables it", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    await started(await start(alice, "alice/tool", "stale.bin", bytesOf(2500)));
    await db.update(registryUploads).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).run();

    startRegistryUploadSweep(db, { ...config, REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS: 0 }, noop, 5);
    await Bun.sleep(60);
    await stopRegistryUploadSweep();
    expect(await uploadRows()).toHaveLength(1);

    startRegistryUploadSweep(db, { ...config, REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS: 1 }, noop, 5);
    // A second start is a no-op.
    startRegistryUploadSweep(db, { ...config, REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS: 1 }, noop, 5);
    for (let i = 0; i < 100 && (await uploadRows()).length > 0; i++)
      await Bun.sleep(10);
    expect(await uploadRows()).toHaveLength(0);
    await stopRegistryUploadSweep();
    await stopRegistryUploadSweep();
  });

  test("buildFullApp starts the sweep, unless its interval is 0", async () => {
    // Records what the app schedules at boot without letting any of it run.
    const real = getPlatform();
    const scheduled: string[] = [];
    setPlatform({
      ...real,
      scheduler: {
        ...real.scheduler,
        every: (name) => {
          scheduled.push(name);
          return { stop: async () => {} };
        },
      },
    });
    // The file module's driver registry is process-wide and its own tests
    // clear it; the boot below needs the local driver back.
    __setLocalDriverRootForTests(join(dir, "files"));
    const boot = async (interval: number): Promise<string[]> => {
      scheduled.length = 0;
      const deps: AppDeps = {
        config: configSchema.parse({
          NODE_ENV: "test",
          FILE_STORAGE_LOCAL_ROOT: join(dir, "files"),
          FILE_GC_INTERVAL_SECONDS: "0",
          REGISTRY_BLOB_LOCAL_ROOT: blobRoot,
          REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS: String(interval),
        }),
        db,
        logger: noop,
        encryption: { isSystemLocked: () => false } as unknown as AppDeps["encryption"],
      };
      await buildFullApp(deps);
      return [...scheduled];
    };
    try {
      expect(await boot(0)).not.toContain("registry-upload-sweep");
      expect(await boot(60)).toContain("registry-upload-sweep");
    }
    finally {
      await stopRegistryUploadSweep();
      await stopAuditRetentionSweep();
      setPlatform(real);
    }
  });
});

describe("expired upload", () => {
  async function expire(uploadId: string): Promise<void> {
    await db.update(registryUploads).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(registryUploads.id, uploadId)).run();
  }

  test("a part sent after expiry is refused, and the upload is gone", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const bytes = bytesOf(2500);
    const upload = await started(await start(alice, "alice/tool", "tool.bin", bytes));
    await alice.put(`/uploads/${upload.uploadId}/parts/1`, partOf(bytes, 1));
    expect(storedUploads()).toHaveLength(1);
    await expire(upload.uploadId);

    const { body, seen } = refusedBody();
    await expectError(await alice.put(`/uploads/${upload.uploadId}/parts/2`, body, PART), 409, "UPLOAD_EXPIRED");
    expect(seen).toEqual({ drained: true, cancelled: false });
    expect(await uploadRows()).toHaveLength(0);
    expect(storedUploads()).toHaveLength(0);
    expect((await getUsage(db, "alice")).storageBytes).toBe(0);
    expect((await alice.put(`/uploads/${upload.uploadId}/parts/2`, partOf(bytes, 2))).status).toBe(404);
  });

  test("completing after expiry is refused, and the upload is gone", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const bytes = bytesOf(2500);
    const upload = await started(await start(alice, "alice/tool", "tool.bin", bytes));
    await putParts(alice, upload, bytes);
    await expire(upload.uploadId);

    await expectError(await alice.call("POST", `/uploads/${upload.uploadId}/complete`), 409, "UPLOAD_EXPIRED");
    expect(await uploadRows()).toHaveLength(0);
    expect(storedUploads()).toHaveLength(0);
    expect(await assetRows()).toHaveLength(0);
    expect((await alice.call("POST", `/uploads/${upload.uploadId}/complete`)).status).toBe(404);
  });
});
