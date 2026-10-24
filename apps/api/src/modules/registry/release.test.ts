import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { configSchema } from "@/config/schema";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { users } from "@/modules/account/users/schema";
import { auditEvents } from "@/modules/audit/schema";
import { policyMiddleware } from "@/modules/policy";
import { __resetPlatformForTests } from "@/platform";
import { errorHandler } from "@/shared/middleware/error-handler";
import { getUsage, registryRoutes } from ".";
import { __resetBlobStoresForTests } from "./blob";
import { bytesOf, sha256Hex } from "./blob/testing";
import { SINGLE_REQUEST_MAX_BYTES } from "./release.service";
import { registryAssets, registryChannels, registryKeys, registryNamespaces, registryPackages, registryQuotas, registryVersions } from "./schema";
import fixture from "./testdata/vectors.json";
import "@/modules/account";

const { signer, other, vectors } = fixture;
type Vector = (typeof vectors)[number];

const noop = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  flush() {},
} as unknown as Logger;

let dir: string;
let blobRoot: string;
let db: AppDatabase;
let config: Config;

beforeEach(async () => {
  __resetBlobStoresForTests();
  dir = mkdtempSync(resolve(tmpdir(), "registry-release-"));
  blobRoot = join(dir, "blobs");
  db = await createDb(resolve(dir, "app.db"));
  config = configSchema.parse({ NODE_ENV: "test", REGISTRY_BLOB_LOCAL_ROOT: blobRoot });
});

afterEach(() => {
  __resetBlobStoresForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Shaped like the real `/api` sub-app: request context, the global policy
// middleware, then the module's routes.
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

interface UploadOptions {
  /** Query parameters; `sha256` defaults to the digest of the bytes. */
  readonly query?: Record<string, string>;
  /** Declared `Content-Length`; null sends none. Defaults to the body's length. */
  readonly length?: number | null;
}

interface Client {
  readonly id: string;
  readonly call: (method: string, path: string, body?: unknown) => Promise<Response>;
  /** `PUT` a raw body the way a publisher does. */
  readonly put: (path: string, body: Uint8Array | ReadableStream<Uint8Array>, opts?: UploadOptions) => Promise<Response>;
}

function client(id: string, auth: Record<string, string>): Client {
  return {
    id,
    call: async (method, path, body) => await app().request(`/api/registry${path}`, {
      method,
      headers: { ...auth, "Content-Type": "application/json" },
      ...(body !== undefined && {
        body: JSON.stringify(body),
      }),
    }),
    put: async (path, body, opts = {}) => {
      const query = new URLSearchParams({
        ...(body instanceof Uint8Array && {
          sha256: sha256Hex(body),
        }),
        ...opts.query,
      });
      const length = opts.length === undefined
        ? (body instanceof Uint8Array
            ? body.length
            : null)
        : opts.length;
      return await app().request(`/api/registry${path}?${query}`, {
        method: "PUT",
        headers: {
          ...auth,
          ...(length !== null && {
            "Content-Length": String(length),
          }),
        },
        body,
        duplex: "half",
      } as RequestInit);
    },
  };
}

async function seedUser(id: string, role: "user" | "admin" = "user"): Promise<Client> {
  const now = new Date().toISOString();
  await db.insert(users).values({
    id,
    oauthSub: `sub-${id}`,
    username: id,
    name: id,
    email: `${id}@t.io`,
    role,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();
  const session = await createSession(db, id, "access", undefined, 3600);
  return client(id, { Cookie: `session_id=${session}` });
}

/** A user whose namespace slug is their id, owning `packages` (by slug). */
async function seedPublisher(id: string, packages: readonly string[] = [], role: "user" | "admin" = "user"): Promise<Client> {
  const publisher = await seedUser(id, role);
  await db.insert(registryNamespaces).values({ id: `ns-${id}`, slug: id, ownerUserId: id }).run();
  for (const slug of packages)
    expect((await publisher.call("POST", "/packages", { slug, name: slug })).status).toBe(201);
  return publisher;
}

async function mint(owner: Client, grants: unknown): Promise<Client & { tokenId: string }> {
  const res = await owner.call("POST", "/tokens", { name: "ci", grants });
  expect(res.status).toBe(201);
  const created = await data<{ id: string; token: string }>(res);
  return {
    ...client(owner.id, { Authorization: `Bearer ${created.token}` }),
    tokenId: created.id,
  };
}

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function expectError(res: Response, status: number, code: string): Promise<void> {
  expect({ status: res.status, code: await errorCode(res) }).toEqual({ status, code });
}

async function draft(who: Client, pkg: string, version = "1.0.0"): Promise<string> {
  const res = await who.call("POST", `/packages/${pkg}/versions`, { version });
  expect(res.status).toBe(201);
  return (await data<{ id: string }>(res)).id;
}

/** A draft with one asset, published to `stable`. */
async function release(who: Client, pkg: string, version = "1.0.0"): Promise<string> {
  const id = await draft(who, pkg, version);
  expect((await who.put(`/packages/${pkg}/versions/${version}/assets/tool`, bytesOf(64))).status).toBe(201);
  expect((await who.call("POST", `/packages/${pkg}/versions/${version}/publish`, { channel: "stable" })).status).toBe(200);
  return id;
}

async function packageId(slug: string): Promise<string> {
  return (await db.select().from(registryPackages).where(eq(registryPackages.slug, slug)).get())!.id;
}

async function blobPath(pkg: string, versionId: string, asset: string): Promise<string> {
  return join(blobRoot, "objects", "pkg", await packageId(pkg), versionId, asset);
}

async function assetRows() {
  return await db.select().from(registryAssets).all();
}

async function statusOf(versionId: string): Promise<string> {
  return (await db.select().from(registryVersions).where(eq(registryVersions.id, versionId)).get())!.status;
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

async function registerSigner(who: Client, pkg: string, key = signer.publicKey): Promise<string> {
  const res = await who.call("POST", `/packages/${pkg}/keys`, { public_key: key, name: "ci" });
  expect(res.status).toBe(201);
  return (await data<{ id: string }>(res)).id;
}

function signedQuery(vector: Vector, changes: Record<string, string> = {}): Record<string, string> {
  return {
    sha256: vector.sha256,
    sig: vector.sig,
    ...(vector.run !== null && { run: vector.run }),
    ...(vector.exec !== null && { exec: vector.exec }),
    ...changes,
  };
}

async function putVector(who: Client, pkg: string, vector: Vector, changes: Record<string, string> = {}): Promise<Response> {
  return await who.put(
    `/packages/${pkg}/versions/${vector.version}/assets/${vector.name}`,
    new TextEncoder().encode(vector.content),
    {
      query: signedQuery(vector, changes),
    },
  );
}

function vectorOf(id: string): Vector {
  return vectors.find(v => v.id === id)!;
}

describe("draft versions", () => {
  test("upload, publish and read back", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const created = await alice.call("POST", "/packages/alice/tool/versions", { version: "1.0.0", notes: "First" });
    expect(created.status).toBe(201);
    expect(await data(created)).toMatchObject({
      version: "1.0.0",
      status: "draft",
      notes: "First",
      published_at: null,
      assets: [],
    });

    const bytes = bytesOf(5000);
    const uploaded = await alice.put("/packages/alice/tool/versions/1.0.0/assets/tool-linux-x64.tar.gz", bytes, {
      query: { run: "./tool serve" },
    });
    expect(uploaded.status).toBe(201);
    const asset = {
      name: "tool-linux-x64.tar.gz",
      size: 5000,
      sha256: sha256Hex(bytes),
      sig: null,
      key_id: null,
      alg: null,
      run: "./tool serve",
      exec: null,
    };
    expect(await data(uploaded)).toMatchObject(asset);

    const published = await alice.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" });
    expect(published.status).toBe(200);
    const view = await data<{ status: string; published_at: string }>(published);
    expect(view.status).toBe("published");
    expect(Date.parse(view.published_at)).not.toBeNaN();

    const list = await data<{ versions: unknown[]; channels: unknown[] }>(await alice.call("GET", "/packages/alice/tool/versions"));
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0]).toMatchObject({
      version: "1.0.0",
      status: "published",
      notes: "First",
      assets: [asset],
    });
    expect(list.channels).toMatchObject([
      { name: "stable", version: "1.0.0" },
    ]);

    const one = await data<{ version: unknown; channels: unknown[] }>(await alice.call("GET", "/packages/alice/tool/versions/1.0.0"));
    expect(one.version).toMatchObject({
      version: "1.0.0",
      status: "published",
      assets: [asset],
    });
    expect(one.channels).toMatchObject([
      { name: "stable", version: "1.0.0" },
    ]);

    expect((await alice.call("GET", "/packages/alice/tool/versions/9.9.9")).status).toBe(404);
  });

  test("a version id follows the lode rule and is unique in its package", async () => {
    const alice = await seedPublisher("alice", ["tool", "other"]);
    for (const version of [
      "",
      ".hidden",
      "-1",
      "1.0/x",
      "1 0",
      "v".repeat(129),
    ])
      expect((await alice.call("POST", "/packages/alice/tool/versions", { version })).status).toBe(422);
    await draft(alice, "alice/tool", "2.0.0-rc.1_build-7");
    await expectError(await alice.call("POST", "/packages/alice/tool/versions", { version: "2.0.0-rc.1_build-7" }), 409, "VERSION_EXISTS");
    await draft(alice, "alice/other", "2.0.0-rc.1_build-7");
  });

  test("publishing needs a draft with at least one asset", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const id = await draft(alice, "alice/tool");
    await expectError(await alice.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" }), 409, "VERSION_EMPTY");
    expect(await statusOf(id)).toBe("draft");
    expect((await alice.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "-bad" })).status).toBe(422);
    expect((await alice.call("POST", "/packages/alice/tool/versions/1.0.0/publish", {})).status).toBe(422);

    await alice.put("/packages/alice/tool/versions/1.0.0/assets/tool", bytesOf(10));
    expect((await alice.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" })).status).toBe(200);
    await expectError(await alice.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" }), 409, "VERSION_NOT_DRAFT");
  });

  test("publish is atomic: a pointer that cannot move leaves the version a draft", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const id = await draft(alice, "alice/tool");
    await alice.put("/packages/alice/tool/versions/1.0.0/assets/tool", bytesOf(10));
    await db.run(sql`ALTER TABLE registry_channels RENAME TO registry_channels_gone`);

    expect((await alice.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" })).status).toBe(500);
    const row = (await db.select().from(registryVersions).where(eq(registryVersions.id, id)).get())!;
    expect(row).toMatchObject({ status: "draft", publishedAt: null });
  });
});

describe("single-request upload", () => {
  test("a body far larger than any buffer is streamed to disk intact", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const versionId = await draft(alice, "alice/tool");
    const chunk = bytesOf(64 * 1024, 7);
    const chunks = 320; // 20 MiB
    const size = chunk.length * chunks;
    const hash = createHash("sha256");
    for (let i = 0; i < chunks; i++)
      hash.update(chunk);
    const sha256 = hash.digest("hex");

    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === chunks)
          return controller.close();
        sent++;
        controller.enqueue(chunk);
      },
    });
    const res = await alice.put("/packages/alice/tool/versions/1.0.0/assets/big.bin", body, {
      length: size,
      query: { sha256 },
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ name: "big.bin", size, sha256 });

    const path = await blobPath("tool", versionId, "big.bin");
    expect(statSync(path).size).toBe(size);
    const onDisk = createHash("sha256");
    for await (const piece of createReadStream(path))
      onDisk.update(piece as Uint8Array);
    expect(onDisk.digest("hex")).toBe(sha256);
    expect((await getUsage(db, "alice")).storageBytes).toBe(size);
  }, 30_000);

  test("Content-Length is required", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const { body, seen } = refusedBody();
    const res = await alice.put("/packages/alice/tool/versions/1.0.0/assets/tool", body, {
      length: null,
      query: {
        sha256: "0".repeat(64),
      },
    });
    await expectError(res, 411, "LENGTH_REQUIRED");
    expect(seen).toEqual({ drained: true, cancelled: false });
  });

  test("more than 95 MiB is refused and pointed at the multipart routes", async () => {
    expect(SINGLE_REQUEST_MAX_BYTES).toBe(99614720);
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const { body, seen } = refusedBody();
    const res = await alice.put("/packages/alice/tool/versions/1.0.0/assets/tool", body, {
      length: 99614721,
      query: {
        sha256: "0".repeat(64),
      },
    });
    expect(res.status).toBe(413);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("SINGLE_REQUEST_TOO_LARGE");
    expect(error.message).toContain("/versions/1.0.0/uploads");
    expect(seen).toEqual({ drained: true, cancelled: false });
  });

  test("an asset over the per-asset limit is refused and its body discarded", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    await db.insert(registryQuotas).values({ userId: "alice", maxAssetBytes: 1000 }).run();
    const { body, seen } = refusedBody();
    const res = await alice.put("/packages/alice/tool/versions/1.0.0/assets/tool", body, {
      length: 1001,
      query: {
        sha256: "0".repeat(64),
      },
    });
    await expectError(res, 413, "ASSET_TOO_LARGE");
    expect(seen).toEqual({ drained: true, cancelled: false });
    expect(await assetRows()).toHaveLength(0);
  });

  test("an upload over the storage quota is refused and its body discarded", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    await db.insert(registryQuotas).values({ userId: "alice", maxStorageBytes: 1500 }).run();
    expect((await alice.put("/packages/alice/tool/versions/1.0.0/assets/first", bytesOf(1000))).status).toBe(201);

    const { body, seen } = refusedBody();
    const res = await alice.put("/packages/alice/tool/versions/1.0.0/assets/second", body, {
      length: 501,
      query: {
        sha256: "0".repeat(64),
      },
    });
    await expectError(res, 409, "STORAGE_QUOTA_EXCEEDED");
    expect(seen).toEqual({ drained: true, cancelled: false });
    expect((await assetRows()).map(a => a.name)).toEqual(["first"]);
    expect((await alice.put("/packages/alice/tool/versions/1.0.0/assets/second", bytesOf(500))).status).toBe(201);
  });

  test("the quota charged is the package owner's, also when an admin uploads", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const root = await seedPublisher("root", [], "admin");
    await draft(alice, "alice/tool");
    await db.insert(registryQuotas).values({ userId: "alice", maxStorageBytes: 100 }).run();
    await expectError(await root.put("/packages/alice/tool/versions/1.0.0/assets/tool", bytesOf(101)), 409, "STORAGE_QUOTA_EXCEEDED");
    expect((await root.put("/packages/alice/tool/versions/1.0.0/assets/tool", bytesOf(100))).status).toBe(201);
    expect((await getUsage(db, "alice")).storageBytes).toBe(100);
    expect((await getUsage(db, "root")).storageBytes).toBe(0);
  });

  test("a request refused by validation, auth or state has its body discarded", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await release(alice, "alice/tool");
    const cases: Array<[Client, string, Record<string, string>, number]> = [
      [
        alice,
        "/packages/alice/tool/versions/1.0.0/assets/tool",
        {
          sha256: "0".repeat(64),
        },
        409,
      ],
      [
        alice,
        "/packages/alice/tool/versions/9.9.9/assets/tool",
        {
          sha256: "0".repeat(64),
        },
        404,
      ],
      [
        alice,
        "/packages/alice/tool/versions/1.0.0/assets/tool",
        { sha256: "nope" },
        422,
      ],
      [
        client("nobody", {}),
        "/packages/alice/tool/versions/1.0.0/assets/tool",
        {
          sha256: "0".repeat(64),
        },
        401,
      ],
    ];
    for (const [who, path, query, status] of cases) {
      const { body, seen } = refusedBody();
      expect((await who.put(path, body, { length: 10, query })).status).toBe(status);
      expect(seen).toEqual({ drained: true, cancelled: false });
    }
  });

  test("the parameters are validated as lode validates them", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const bytes = bytesOf(10);
    const base = "/packages/alice/tool/versions/1.0.0/assets";
    const bad: Array<[string, Record<string, string>]> = [
      [".hidden", {}],
      ["-flag", {}],
      ["a b", {}],
      [
        "tool",
        {
          sha256: sha256Hex(bytes).toUpperCase(),
        },
      ],
      [
        "tool",
        { sha256: "abc" },
      ],
      [
        "tool",
        { run: "   " },
      ],
      [
        "tool",
        { run: "./tool\n./evil" },
      ],
      [
        "tool",
        { exec: "\t" },
      ],
      [
        "tool",
        { exec: "a\u0000b" },
      ],
    ];
    for (const [name, query] of bad)
      await expectError(await alice.put(`${base}/${encodeURIComponent(name)}`, bytes, { query }), 422, "VALIDATION_ERROR");
    await expectError(await client("nobody", {}).put(`${base}/tool`, bytes), 401, "UNAUTHORIZED");
    expect((await alice.put(`${base}/tool`, bytes, {
      query: { sha256: "" },
    })).status).toBe(422);
    await expectError(await alice.put(`${base}/tool`, new Uint8Array(0)), 422, "VALIDATION_ERROR");
    expect(await assetRows()).toHaveLength(0);

    // Empty `sig`, `run` and `exec` are the same as leaving them out.
    const res = await alice.put(`${base}/tool`, bytes, {
      query: { sig: "", run: "", exec: "" },
    });
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({
      sig: null,
      key_id: null,
      alg: null,
      run: null,
      exec: null,
    });
  });

  test("bytes that do not match the declared digest or length store nothing", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const versionId = await draft(alice, "alice/tool");
    const bytes = bytesOf(100);
    const path = "/packages/alice/tool/versions/1.0.0/assets/tool";
    await expectError(await alice.put(path, bytes, {
      query: {
        sha256: sha256Hex(bytesOf(100, 2)),
      },
    }), 422, "DIGEST_MISMATCH");
    await expectError(await alice.put(path, bytes, { length: 99 }), 422, "DIGEST_MISMATCH");
    expect(await assetRows()).toHaveLength(0);
    expect(existsSync(await blobPath("tool", versionId, "tool"))).toBe(false);
    expect((await getUsage(db, "alice")).storageBytes).toBe(0);
  });

  test("uploading an asset name again replaces it; a failed replacement keeps the old one", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const versionId = await draft(alice, "alice/tool");
    const path = "/packages/alice/tool/versions/1.0.0/assets/tool";
    const first = bytesOf(300, 1);
    const second = bytesOf(120, 2);
    expect((await alice.put(path, first)).status).toBe(201);

    await expectError(await alice.put(path, second, {
      query: {
        sha256: sha256Hex(first),
      },
    }), 422, "DIGEST_MISMATCH");
    expect(await assetRows()).toMatchObject([
      {
        size: 300,
        sha256: sha256Hex(first),
      },
    ]);
    expect(statSync(await blobPath("tool", versionId, "tool")).size).toBe(300);

    const replaced = await alice.put(path, second, {
      query: { exec: "./tool" },
    });
    expect(replaced.status).toBe(200);
    expect(await data(replaced)).toMatchObject({
      size: 120,
      sha256: sha256Hex(second),
      exec: "./tool",
    });
    expect(await assetRows()).toMatchObject([
      {
        name: "tool",
        size: 120,
        sha256: sha256Hex(second),
      },
    ]);
    expect(statSync(await blobPath("tool", versionId, "tool")).size).toBe(120);
    expect((await getUsage(db, "alice")).storageBytes).toBe(120);
  });

  test("a version cannot be published or deleted while an upload into it is in flight", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const base = "/packages/alice/tool/versions/1.0.0";
    await alice.put(`${base}/assets/first`, bytesOf(10));

    const bytes = bytesOf(2000);
    let finish = () => {};
    const gate = new Promise<void>((done) => {
      finish = done;
    });
    let started = () => {};
    const reading = new Promise<void>((done) => {
      started = done;
    });
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent)
          return controller.close();
        sent = true;
        controller.enqueue(bytes.subarray(0, 1000));
        started();
        await gate;
        controller.enqueue(bytes.subarray(1000));
      },
    }, { highWaterMark: 0 });
    const uploading = alice.put(`${base}/assets/slow`, body, {
      length: bytes.length,
      query: {
        sha256: sha256Hex(bytes),
      },
    });
    await reading;

    await expectError(await alice.call("POST", `${base}/publish`, { channel: "stable" }), 409, "VERSION_BUSY");
    await expectError(await alice.call("DELETE", base), 409, "VERSION_BUSY");
    await expectError(await alice.put(`${base}/assets/slow`, bytesOf(10)), 409, "VERSION_BUSY");
    await expectError(await alice.call("DELETE", `${base}/assets/slow`), 409, "VERSION_BUSY");
    // Other assets of the version are not held up.
    expect((await alice.put(`${base}/assets/second`, bytesOf(10))).status).toBe(201);

    finish();
    expect((await uploading).status).toBe(201);
    expect((await alice.call("POST", `${base}/publish`, { channel: "stable" })).status).toBe(200);
    expect((await assetRows()).map(a => a.name).sort()).toEqual(["first", "second", "slow"]);
  });

  test("an asset can be deleted from a draft, and nothing changes once published", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const versionId = await draft(alice, "alice/tool");
    const path = "/packages/alice/tool/versions/1.0.0/assets";
    await alice.put(`${path}/a`, bytesOf(10));
    await alice.put(`${path}/b`, bytesOf(20));

    expect((await alice.call("DELETE", `${path}/a`)).status).toBe(200);
    expect((await alice.call("DELETE", `${path}/a`)).status).toBe(404);
    expect(existsSync(await blobPath("tool", versionId, "a"))).toBe(false);
    expect((await getUsage(db, "alice")).storageBytes).toBe(20);

    expect((await alice.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" })).status).toBe(200);
    await expectError(await alice.put(`${path}/b`, bytesOf(20, 9)), 409, "VERSION_NOT_DRAFT");
    await expectError(await alice.put(`${path}/c`, bytesOf(5)), 409, "VERSION_NOT_DRAFT");
    await expectError(await alice.call("DELETE", `${path}/b`), 409, "VERSION_NOT_DRAFT");
    await db.delete(registryChannels).run();
    expect((await alice.call("POST", "/packages/alice/tool/versions/1.0.0/yank")).status).toBe(200);
    await expectError(await alice.put(`${path}/c`, bytesOf(5)), 409, "VERSION_NOT_DRAFT");
    expect((await assetRows()).map(a => a.name)).toEqual(["b"]);
    expect(statSync(await blobPath("tool", versionId, "b")).size).toBe(20);
  });
});

describe("signatures", () => {
  test("every vector signed by the real lode-cli verifies on upload", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await registerSigner(alice, "alice/tool");
    const drafted = new Set<string>();
    for (const vector of vectors) {
      if (!drafted.has(vector.version))
        await draft(alice, "alice/tool", vector.version);
      drafted.add(vector.version);
      const res = await putVector(alice, "alice/tool", vector);
      expect(res.status).toBe(201);
      expect(await data(res)).toMatchObject({
        name: vector.name,
        sha256: vector.sha256,
        sig: vector.sig,
        key_id: signer.keyId,
        alg: "ed25519",
        run: vector.run,
        exec: vector.exec,
      });
    }
    expect(await assetRows()).toHaveLength(vectors.length);
  });

  test("a tampered sha256, sig or run is rejected and leaves no row and no blob", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await registerSigner(alice, "alice/tool");
    const vector = vectorOf("run");
    const versionId = await draft(alice, "alice/tool", vector.version);
    const flipped = `${vector.sig.startsWith("A")
      ? "B"
      : "A"}${vector.sig.slice(1)}`;
    const tampered: Array<Record<string, string>> = [
      {
        sha256: sha256Hex(bytesOf(10)),
      },
      { sig: flipped },
      { sig: "not-a-signature" },
      { run: `${vector.run} --insecure` },
      { exec: "./demo" },
    ];
    for (const changes of tampered) {
      await expectError(await putVector(alice, "alice/tool", vector, changes), 400, "INVALID_SIGNATURE");
      expect(await assetRows()).toHaveLength(0);
      expect(existsSync(await blobPath("tool", versionId, vector.name))).toBe(false);
    }
    // The same signature under another asset name or version does not verify either.
    const bytes = new TextEncoder().encode(vector.content);
    await expectError(await alice.put(`/packages/alice/tool/versions/${vector.version}/assets/renamed.tar.gz`, bytes, {
      query: signedQuery(vector),
    }), 400, "INVALID_SIGNATURE");
    await draft(alice, "alice/tool", "9.9.9");
    await expectError(await alice.put(`/packages/alice/tool/versions/9.9.9/assets/${vector.name}`, bytes, {
      query: signedQuery(vector),
    }), 400, "INVALID_SIGNATURE");
    expect(await assetRows()).toHaveLength(0);

    expect((await putVector(alice, "alice/tool", vector)).status).toBe(201);
  });

  test("a bad signature is refused before the body is read", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await registerSigner(alice, "alice/tool");
    const vector = vectorOf("plain");
    await draft(alice, "alice/tool", vector.version);
    const { body, seen } = refusedBody();
    const res = await alice.put(`/packages/alice/tool/versions/${vector.version}/assets/${vector.name}`, body, {
      length: vector.content.length,
      query: signedQuery(vector, { exec: "./other" }),
    });
    await expectError(res, 400, "INVALID_SIGNATURE");
    expect(seen).toEqual({ drained: true, cancelled: false });
  });

  test("only an active key of the package counts", async () => {
    const alice = await seedPublisher("alice", ["tool", "lib"]);
    const bob = await seedPublisher("bob", ["tool"]);
    const root = await seedPublisher("root", [], "admin");
    const vector = vectorOf("plain");
    await draft(alice, "alice/tool", vector.version);

    // No key at all, the key on another package of the owner, on another user's package, a different key on this one.
    await expectError(await putVector(alice, "alice/tool", vector), 400, "INVALID_SIGNATURE");
    await registerSigner(alice, "alice/lib");
    await registerSigner(bob, "bob/tool");
    await expectError(await putVector(alice, "alice/tool", vector), 400, "INVALID_SIGNATURE");
    await expectError(await putVector(root, "alice/tool", vector), 400, "INVALID_SIGNATURE");
    await registerSigner(alice, "alice/tool", other.publicKey);
    await expectError(await putVector(alice, "alice/tool", vector), 400, "INVALID_SIGNATURE");

    const keyId = await registerSigner(alice, "alice/tool");
    expect((await alice.call("DELETE", `/packages/alice/tool/keys/${keyId}`)).status).toBe(200);
    await expectError(await putVector(alice, "alice/tool", vector), 400, "INVALID_SIGNATURE");
    expect(await assetRows()).toHaveLength(0);

    await db.update(registryKeys).set({ revokedAt: null }).where(eq(registryKeys.id, keyId)).run();
    const res = await putVector(root, "alice/tool", vector);
    expect(res.status).toBe(201);
    expect(await data(res)).toMatchObject({ key_id: signer.keyId });
  });

  test("an asset signed for one package is refused in another that trusts the same key", async () => {
    const alice = await seedPublisher("alice", ["tool", "lib"]);
    const vector = vectorOf("plain");
    await registerSigner(alice, "alice/tool");
    await registerSigner(alice, "alice/lib");
    await draft(alice, "alice/tool", vector.version);
    await draft(alice, "alice/lib", vector.version);

    await expectError(await putVector(alice, "alice/lib", vector), 400, "INVALID_SIGNATURE");
    expect((await putVector(alice, "alice/tool", vector)).status).toBe(201);
  });

  test("a package that requires signatures refuses an unsigned upload", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await registerSigner(alice, "alice/tool");
    expect((await alice.call("PATCH", "/packages/alice/tool", { require_signature: true })).status).toBe(200);
    const vector = vectorOf("plain");
    await draft(alice, "alice/tool", vector.version);

    const { body, seen } = refusedBody();
    const path = `/packages/alice/tool/versions/${vector.version}/assets/${vector.name}`;
    await expectError(await alice.put(path, body, {
      length: 10,
      query: { sha256: vector.sha256 },
    }), 400, "SIGNATURE_REQUIRED");
    expect(seen).toEqual({ drained: true, cancelled: false });
    await expectError(await alice.put(path, new TextEncoder().encode(vector.content), {
      query: { sig: "" },
    }), 400, "SIGNATURE_REQUIRED");
    expect(await assetRows()).toHaveLength(0);
    expect((await putVector(alice, "alice/tool", vector)).status).toBe(201);
  });
});

describe("channels, yank and restore", () => {
  test("a pointer moves only to a published version", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await release(alice, "alice/tool", "1.0.0");
    await release(alice, "alice/tool", "1.1.0");
    await draft(alice, "alice/tool", "2.0.0");
    const channels = async () => (await data<{ channels: Array<{ name: string; version: string }> }>(await alice.call("GET", "/packages/alice/tool/versions"))).channels.map(c => `${c.name}=${c.version}`);
    expect(await channels()).toEqual(["stable=1.1.0"]);

    // Roll back, then open a second channel.
    expect((await alice.call("PUT", "/packages/alice/tool/channels/stable", { version: "1.0.0" })).status).toBe(200);
    const beta = await alice.call("PUT", "/packages/alice/tool/channels/beta", { version: "1.1.0" });
    expect(await data(beta)).toMatchObject({ name: "beta", version: "1.1.0" });
    expect(await channels()).toEqual(["beta=1.1.0", "stable=1.0.0"]);

    await expectError(await alice.call("PUT", "/packages/alice/tool/channels/stable", { version: "2.0.0" }), 409, "VERSION_NOT_PUBLISHED");
    await expectError(await alice.call("PUT", "/packages/alice/tool/channels/stable", { version: "3.0.0" }), 404, "NOT_FOUND");
    expect((await alice.call("PUT", "/packages/alice/tool/channels/.bad", { version: "1.0.0" })).status).toBe(422);
    expect(await channels()).toEqual(["beta=1.1.0", "stable=1.0.0"]);
  });

  test("yank is refused while a channel points at the version", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const first = await release(alice, "alice/tool", "1.0.0");
    await expectError(await alice.call("POST", "/packages/alice/tool/versions/1.0.0/yank"), 409, "VERSION_IN_CHANNEL");
    expect(await statusOf(first)).toBe("published");

    await release(alice, "alice/tool", "1.1.0");
    const yanked = await alice.call("POST", "/packages/alice/tool/versions/1.0.0/yank");
    expect(yanked.status).toBe(200);
    expect(await data(yanked)).toMatchObject({ version: "1.0.0", status: "yanked" });

    // A yanked version takes no pointer and cannot be yanked twice.
    await expectError(await alice.call("PUT", "/packages/alice/tool/channels/stable", { version: "1.0.0" }), 409, "VERSION_NOT_PUBLISHED");
    await expectError(await alice.call("POST", "/packages/alice/tool/versions/1.0.0/yank"), 409, "VERSION_NOT_PUBLISHED");

    const restored = await alice.call("POST", "/packages/alice/tool/versions/1.0.0/restore");
    expect(await data(restored)).toMatchObject({ status: "published" });
    await expectError(await alice.call("POST", "/packages/alice/tool/versions/1.0.0/restore"), 409, "VERSION_NOT_YANKED");
    expect((await alice.call("PUT", "/packages/alice/tool/channels/stable", { version: "1.0.0" })).status).toBe(200);

    await draft(alice, "alice/tool", "2.0.0");
    await expectError(await alice.call("POST", "/packages/alice/tool/versions/2.0.0/yank"), 409, "VERSION_NOT_PUBLISHED");
  });
});

describe("deleting", () => {
  test("a draft goes with its rows and blobs", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const versionId = await draft(alice, "alice/tool");
    await alice.put("/packages/alice/tool/versions/1.0.0/assets/tool", bytesOf(50));
    const path = await blobPath("tool", versionId, "tool");
    expect(existsSync(path)).toBe(true);

    expect((await alice.call("DELETE", "/packages/alice/tool/versions/1.0.0")).status).toBe(200);
    expect(await assetRows()).toHaveLength(0);
    expect(await db.select().from(registryVersions).all()).toHaveLength(0);
    expect(existsSync(path)).toBe(false);
    expect((await alice.call("DELETE", "/packages/alice/tool/versions/1.0.0")).status).toBe(404);
  });

  test("a published version only while no channel points at it", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const first = await release(alice, "alice/tool", "1.0.0");
    await expectError(await alice.call("DELETE", "/packages/alice/tool/versions/1.0.0"), 409, "VERSION_IN_CHANNEL");
    const second = await release(alice, "alice/tool", "1.1.0");

    const path = await blobPath("tool", first, "tool");
    expect((await alice.call("DELETE", "/packages/alice/tool/versions/1.0.0")).status).toBe(200);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(await blobPath("tool", second, "tool"))).toBe(true);
    expect((await db.select().from(registryVersions).all()).map(v => v.version)).toEqual(["1.1.0"]);
  });

  test("the id of a deleted published version is retired; a deleted draft's is not", async () => {
    const alice = await seedPublisher("alice", ["tool", "other"]);
    await release(alice, "alice/tool", "1.0.0");
    await release(alice, "alice/tool", "1.1.0");
    expect((await alice.call("DELETE", "/packages/alice/tool/versions/1.0.0")).status).toBe(200);
    await expectError(await alice.call("POST", "/packages/alice/tool/versions", { version: "1.0.0" }), 409, "VERSION_RETIRED");
    // Another package is not affected.
    expect((await alice.call("POST", "/packages/alice/other/versions", { version: "1.0.0" })).status).toBe(201);

    await draft(alice, "alice/tool", "2.0.0");
    expect((await alice.call("DELETE", "/packages/alice/tool/versions/2.0.0")).status).toBe(200);
    expect((await alice.call("POST", "/packages/alice/tool/versions", { version: "2.0.0" })).status).toBe(201);
  });

  test("a package created again keeps the ids its published versions had retired", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await release(alice, "alice/tool", "1.0.0");
    await draft(alice, "alice/tool", "1.1.0");
    expect((await alice.call("DELETE", "/packages/alice/tool")).status).toBe(200);
    expect((await alice.call("POST", "/packages", { slug: "tool", name: "Tool" })).status).toBe(201);

    await expectError(await alice.call("POST", "/packages/alice/tool/versions", { version: "1.0.0" }), 409, "VERSION_RETIRED");
    expect((await alice.call("POST", "/packages/alice/tool/versions", { version: "1.1.0" })).status).toBe(201);
  });

  test("deleting a package removes its blobs and leaves other packages alone", async () => {
    const alice = await seedPublisher("alice", ["tool", "keep"]);
    const gone = await release(alice, "alice/tool");
    const kept = await release(alice, "alice/keep");
    const gonePath = await blobPath("tool", gone, "tool");
    const keptPath = await blobPath("keep", kept, "tool");

    expect((await alice.call("DELETE", "/packages/alice/tool")).status).toBe(200);
    expect(existsSync(gonePath)).toBe(false);
    expect(existsSync(keptPath)).toBe(true);
    expect((await getUsage(db, "alice")).storageBytes).toBe(64);
  });
});

describe("authorization", () => {
  test("a read grant reads and cannot create a draft, upload or publish", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    const reader = await mint(alice, [
      { package: "alice/tool", access: "read" },
    ]);

    expect((await reader.call("GET", "/packages/alice/tool/versions")).status).toBe(200);
    expect((await reader.call("GET", "/packages/alice/tool/versions/1.0.0")).status).toBe(200);
    expect((await reader.call("POST", "/packages/alice/tool/versions", { version: "2.0.0" })).status).toBe(403);
    const { body, seen } = refusedBody();
    expect((await reader.put("/packages/alice/tool/versions/1.0.0/assets/tool", body, {
      length: 10,
      query: {
        sha256: "0".repeat(64),
      },
    })).status).toBe(403);
    expect(seen).toEqual({ drained: true, cancelled: false });
    expect((await reader.call("DELETE", "/packages/alice/tool/versions/1.0.0/assets/tool")).status).toBe(403);
    expect((await reader.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" })).status).toBe(403);
    expect((await reader.call("PUT", "/packages/alice/tool/channels/stable", { version: "1.0.0" })).status).toBe(403);
    expect((await reader.call("DELETE", "/packages/alice/tool/versions/1.0.0")).status).toBe(403);
    expect(await db.select().from(registryVersions).all()).toHaveLength(1);
  });

  test("a write grant releases and cannot yank or restore", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const writer = await mint(alice, [
      { package: "alice/tool", access: "write" },
    ]);

    await draft(writer, "alice/tool", "1.0.0");
    expect((await writer.put("/packages/alice/tool/versions/1.0.0/assets/tool", bytesOf(10))).status).toBe(201);
    expect((await writer.put("/packages/alice/tool/versions/1.0.0/assets/extra", bytesOf(10))).status).toBe(201);
    expect((await writer.call("DELETE", "/packages/alice/tool/versions/1.0.0/assets/extra")).status).toBe(200);
    expect((await writer.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" })).status).toBe(200);
    await release(writer, "alice/tool", "1.1.0");
    expect((await writer.call("PUT", "/packages/alice/tool/channels/beta", { version: "1.0.0" })).status).toBe(200);
    await db.delete(registryChannels).where(eq(registryChannels.name, "beta")).run();

    expect((await writer.call("POST", "/packages/alice/tool/versions/1.0.0/yank")).status).toBe(403);
    await db.update(registryVersions).set({ status: "yanked" }).where(eq(registryVersions.version, "1.0.0")).run();
    expect((await writer.call("POST", "/packages/alice/tool/versions/1.0.0/restore")).status).toBe(403);

    // A draft may be deleted with a write grant.
    await draft(writer, "alice/tool", "2.0.0");
    expect((await writer.call("DELETE", "/packages/alice/tool/versions/2.0.0")).status).toBe(200);
  });

  test("an admin grant yanks and restores", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await release(alice, "alice/tool", "1.0.0");
    await release(alice, "alice/tool", "1.1.0");
    const manager = await mint(alice, [
      { package: "alice/tool", access: "admin" },
    ]);
    expect((await manager.call("POST", "/packages/alice/tool/versions/1.0.0/yank")).status).toBe(200);
    expect((await manager.call("POST", "/packages/alice/tool/versions/1.0.0/restore")).status).toBe(200);
  });

  test("no token deletes a published or yanked version, whatever its grant", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const root = await seedPublisher("root", [], "admin");
    const first = await release(alice, "alice/tool", "1.0.0");
    await release(alice, "alice/tool", "1.1.0");
    const tokens = [
      await mint(alice, [
        { package: "alice/tool", access: "write" },
      ]),
      await mint(alice, [
        { package: "alice/tool", access: "admin" },
      ]),
      await mint(alice, { all: "admin" }),
      await mint(root, [
        { package: "alice/tool", access: "admin" },
      ]),
    ];
    for (const status of ["published", "yanked"] as const) {
      await db.update(registryVersions).set({ status }).where(eq(registryVersions.id, first)).run();
      for (const token of tokens)
        await expectError(await token.call("DELETE", "/packages/alice/tool/versions/1.0.0"), 403, "FORBIDDEN");
    }
    expect(await statusOf(first)).toBe("yanked");
    expect((await alice.call("DELETE", "/packages/alice/tool/versions/1.0.0")).status).toBe(200);
  });

  test("a token reaches only the packages it has a grant on", async () => {
    const alice = await seedPublisher("alice", ["tool", "other"]);
    await draft(alice, "alice/other");
    const writer = await mint(alice, [
      { package: "alice/tool", access: "write" },
    ]);
    expect((await writer.call("GET", "/packages/alice/other/versions")).status).toBe(403);
    expect((await writer.call("POST", "/packages/alice/other/versions", { version: "2.0.0" })).status).toBe(403);
    expect((await writer.put("/packages/alice/other/versions/1.0.0/assets/tool", bytesOf(10))).status).toBe(403);
    expect(await assetRows()).toHaveLength(0);
  });

  test("user A cannot touch user B's versions; a platform admin can", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const bob = await seedPublisher("bob");
    const root = await seedPublisher("root", [], "admin");
    await release(alice, "alice/tool", "1.0.0");
    await draft(alice, "alice/tool", "2.0.0");

    // The package is public, so bob may read it and nothing else.
    expect((await bob.call("GET", "/packages/alice/tool/versions")).status).toBe(200);
    expect((await bob.call("POST", "/packages/alice/tool/versions", { version: "3.0.0" })).status).toBe(403);
    expect((await bob.put("/packages/alice/tool/versions/2.0.0/assets/tool", bytesOf(10))).status).toBe(403);
    expect((await bob.call("DELETE", "/packages/alice/tool/versions/2.0.0/assets/tool")).status).toBe(403);
    expect((await bob.call("POST", "/packages/alice/tool/versions/2.0.0/publish", { channel: "stable" })).status).toBe(403);
    expect((await bob.call("PUT", "/packages/alice/tool/channels/stable", { version: "1.0.0" })).status).toBe(403);
    expect((await bob.call("POST", "/packages/alice/tool/versions/1.0.0/yank")).status).toBe(403);
    expect((await bob.call("POST", "/packages/alice/tool/versions/1.0.0/restore")).status).toBe(403);
    expect((await bob.call("DELETE", "/packages/alice/tool/versions/2.0.0")).status).toBe(403);
    expect((await bob.call("DELETE", "/packages/alice/tool/versions/1.0.0")).status).toBe(403);

    // A private package does not even admit to existing.
    expect((await alice.call("PATCH", "/packages/alice/tool", { visibility: "private" })).status).toBe(200);
    expect((await bob.call("GET", "/packages/alice/tool/versions")).status).toBe(404);
    expect((await bob.call("GET", "/packages/alice/tool/versions/1.0.0")).status).toBe(404);
    expect((await bob.put("/packages/alice/tool/versions/2.0.0/assets/tool", bytesOf(10))).status).toBe(404);

    expect((await root.call("GET", "/packages/alice/tool/versions/2.0.0")).status).toBe(200);
    expect((await root.put("/packages/alice/tool/versions/2.0.0/assets/tool", bytesOf(10))).status).toBe(201);
    expect((await root.call("POST", "/packages/alice/tool/versions/2.0.0/publish", { channel: "stable" })).status).toBe(200);
    expect((await root.call("POST", "/packages/alice/tool/versions/1.0.0/yank")).status).toBe(200);
    expect((await root.call("POST", "/packages/alice/tool/versions/1.0.0/restore")).status).toBe(200);
    expect((await root.call("DELETE", "/packages/alice/tool/versions/1.0.0")).status).toBe(200);
  });

  test("a suspended namespace takes no release", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    await draft(alice, "alice/tool");
    await db.update(registryNamespaces).set({ status: "suspended" }).where(eq(registryNamespaces.slug, "alice")).run();
    const { body, seen } = refusedBody();
    await expectError(await alice.put("/packages/alice/tool/versions/1.0.0/assets/tool", body, {
      length: 10,
      query: {
        sha256: "0".repeat(64),
      },
    }), 403, "NAMESPACE_SUSPENDED");
    expect(seen).toEqual({ drained: true, cancelled: false });
    await expectError(await alice.call("POST", "/packages/alice/tool/versions", { version: "2.0.0" }), 403, "NAMESPACE_SUSPENDED");
    expect((await alice.call("GET", "/packages/alice/tool/versions")).status).toBe(200);
  });
});

describe("audit", () => {
  test("every mutation is recorded, with the token id for a token request", async () => {
    const alice = await seedPublisher("alice", ["tool"]);
    const manager = await mint(alice, [
      { package: "alice/tool", access: "admin" },
    ]);
    await db.delete(auditEvents).run();

    await draft(manager, "alice/tool", "1.0.0");
    await manager.put("/packages/alice/tool/versions/1.0.0/assets/tool", bytesOf(10));
    await manager.put("/packages/alice/tool/versions/1.0.0/assets/extra", bytesOf(10));
    await manager.call("DELETE", "/packages/alice/tool/versions/1.0.0/assets/extra");
    await manager.call("POST", "/packages/alice/tool/versions/1.0.0/publish", { channel: "stable" });
    await release(manager, "alice/tool", "1.1.0");
    await manager.call("PUT", "/packages/alice/tool/channels/beta", { version: "1.1.0" });
    await manager.call("POST", "/packages/alice/tool/versions/1.0.0/yank");
    await manager.call("POST", "/packages/alice/tool/versions/1.0.0/restore");
    await draft(manager, "alice/tool", "2.0.0");
    await manager.call("DELETE", "/packages/alice/tool/versions/2.0.0");

    const events = await db.select().from(auditEvents).all();
    expect(events.map(e => e.action)).toEqual([
      "registry.version.created",
      "registry.asset.uploaded",
      "registry.asset.uploaded",
      "registry.asset.deleted",
      "registry.version.published",
      "registry.version.created",
      "registry.asset.uploaded",
      "registry.version.published",
      "registry.channel.updated",
      "registry.version.yanked",
      "registry.version.restored",
      "registry.version.created",
      "registry.version.deleted",
    ]);
    for (const event of events) {
      expect(event.actorId).toBe("alice");
      expect(event.resourceName).toStartWith("alice/tool");
      expect(JSON.parse(event.detail!)).toMatchObject({ owner_user_id: "alice", token_id: manager.tokenId });
    }

    // A session request carries no token id; a refused one leaves no entry.
    await db.delete(auditEvents).run();
    await draft(alice, "alice/tool", "3.0.0");
    await alice.call("POST", "/packages/alice/tool/versions", { version: "3.0.0" });
    const [event, ...rest] = await db.select().from(auditEvents).all();
    expect(rest).toHaveLength(0);
    expect(JSON.parse(event!.detail!)).not.toHaveProperty("token_id");
  });
});

describe("blob store at boot", () => {
  afterEach(() => {
    delete process.env.REGISTRY_BLOB_DRIVER;
    __resetPlatformForTests();
  });

  test("a configured store that is not registered fails when the routes are built", () => {
    __resetPlatformForTests();
    process.env.REGISTRY_BLOB_DRIVER = "r2";
    expect(() => registryRoutes()).toThrow("REGISTRY_BLOB_DRIVER=r2 needs the PACKAGES R2 bucket binding");
    process.env.REGISTRY_BLOB_DRIVER = "local";
    expect(() => registryRoutes()).not.toThrow();
  });
});
