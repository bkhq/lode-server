import type { RuntimeSpec } from "./validate";
import type { AppDeps } from "@/app";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
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
import { registryManifestSignatures, registryNamespaces, registryVersions } from "./schema";
import { artifactMessage, canonicalCatalog, encodeBase64Url, manifestCommitMessage, manifestExpiryMessage, manifestMessage, verifyEd25519 } from "./signature";
import fixture from "./testdata/vectors.json";
import "@/modules/account";

const { signer, vectors } = fixture;
type Vector = (typeof vectors)[number];

function vector(id: string): Vector {
  return vectors.find(v => v.id === id)!;
}

const noop = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  flush() {},
} as unknown as Logger;

const ORIGIN = "https://pkg.example.test";

let dir: string;
let db: AppDatabase;
let config: Config;

beforeEach(async () => {
  __resetBlobStoresForTests();
  await __resetRateLimitForTests();
  dir = mkdtempSync(resolve(tmpdir(), "registry-feed-"));
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

/**
 * The outer app as `buildFullApp` composes it, cut down to the registry: an
 * `/api` sub-app with the request context, the policy middleware and the
 * module's routes, and the read feed beside it. Every response of the `/api`
 * sub-app is marked, so a feed request that reached it shows.
 */
function app(overrides: Partial<Config> = {}) {
  const cfg = {
    ...config,
    ...overrides,
  } as Config;
  const api = new Hono<AppEnv>();
  api.use("*", async (c, next) => {
    c.header("x-api-stack", "ran");
    c.set("db", db);
    c.set("config", cfg);
    c.set("logger", noop);
    await next();
  });
  api.use("*", policyMiddleware({ basePath: `${cfg.BASE_PATH}/api` }));
  api.route("/", registryRoutes());
  api.onError(errorHandler);
  const deps: AppDeps = {
    config: cfg,
    db,
    logger: noop,
    encryption: {
      isSystemLocked: () => false,
    } as unknown as AppDeps["encryption"],
  };
  return buildOuterApp(api, cfg, undefined, undefined, buildRawApp(deps, registryFeedRoutes()));
}

interface Publisher {
  readonly id: string;
  readonly cookie: string;
  readonly call: (method: string, path: string, body?: unknown) => Promise<Response>;
  readonly put: (path: string, body: Uint8Array, query?: Record<string, string>) => Promise<Response>;
}

/** A signed-in user whose namespace slug is their id, owning `packages` (by slug). */
async function seedPublisher(id: string, packages: readonly { slug: string; visibility?: "public" | "private" }[] = []): Promise<Publisher> {
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
    id,
    cookie,
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
  for (const pkg of packages)
    expect((await publisher.call("POST", "/packages", { name: pkg.slug, ...pkg })).status).toBe(201);
  return publisher;
}

async function token(owner: Publisher, grants: unknown): Promise<string> {
  const res = await owner.call("POST", "/tokens", { name: "host", grants });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { token: string } }).data.token;
}

async function draft(who: Publisher, pkg: string, version: string, notes?: string): Promise<void> {
  expect((await who.call("POST", `/packages/${pkg}/versions`, {
    version,
    ...(notes !== undefined && { notes }),
  })).status).toBe(201);
}

async function upload(who: Publisher, pkg: string, version: string, asset: string, bytes: Uint8Array, query?: Record<string, string>): Promise<void> {
  expect((await who.put(`/packages/${pkg}/versions/${version}/assets/${asset}`, bytes, query)).status).toBe(201);
}

async function publish(who: Publisher, pkg: string, version: string, channel = "stable"): Promise<void> {
  expect((await who.call("POST", `/packages/${pkg}/versions/${version}/publish`, { channel })).status).toBe(200);
}

/** A version with one 64-byte asset `tool`, published to `channel`. */
async function release(who: Publisher, pkg: string, version: string, channel = "stable"): Promise<Uint8Array> {
  const bytes = bytesOf(64, version.length + version.charCodeAt(0) + version.charCodeAt(version.length - 1));
  await draft(who, pkg, version);
  await upload(who, pkg, version, "tool", bytes);
  await publish(who, pkg, version, channel);
  return bytes;
}

async function uploadVector(who: Publisher, pkg: string, v: Vector): Promise<void> {
  await upload(who, pkg, v.version, v.name, new TextEncoder().encode(v.content), {
    sha256: v.sha256,
    sig: v.sig,
    ...(v.run !== null && { run: v.run }),
    ...(v.exec !== null && { exec: v.exec }),
  });
}

interface ManifestAsset { name: string; url: string; sha256: string; [key: string]: unknown }
interface Manifest {
  schema: string;
  name: string;
  key_id?: string;
  sig?: string;
  expires?: number;
  expires_sig?: string;
  generation?: number;
  created?: string;
  commit_sig?: string;
  channels: Record<string, { latest: string }>;
  versions: Record<string, { notes?: string; assets: ManifestAsset[] }>;
}

function feed(path: string, headers: Record<string, string> = {}, overrides: Partial<Config> = {}): Promise<Response> | Response {
  return app(overrides).request(`/r${path}`, { headers });
}

async function manifestOf(path: string, headers: Record<string, string> = {}): Promise<Manifest> {
  const res = await feed(`/${path}/manifest.json`, headers);
  expect(res.status).toBe(200);
  return (await res.json()) as Manifest;
}

async function expectNotFound(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  // One body for every refusal: an unknown package and one the caller may
  // not see are indistinguishable.
  expect(await res.json()).toEqual({
    success: false,
    error: { code: "NOT_FOUND", message: "Not found" },
  });
}

describe("read feed: manifest", () => {
  // The fields of `lode/v1` as lode's `manifest.rs` reads them and
  // `docs/manifest.example.json` shows them; the manifest must stay inside.
  const MANIFEST_KEYS = [
    "schema",
    "name",
    "key_id",
    "alg",
    "sig",
    "channels",
    "versions",
  ];
  const VERSION_KEYS = ["notes", "assets"];
  const ASSET_KEYS = [
    "name",
    "url",
    "sha256",
    "size",
    "sig",
    "key_id",
    "alg",
    "run",
    "exec",
    "auth",
  ];

  test("is the lode/v1 document of the package's published versions", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "tool" },
    ]);
    expect((await alice.call("POST", "/packages/alice/tool/keys", { public_key: signer.publicKey, name: "ci" })).status).toBe(201);
    const both = vector("run-exec");
    const rc = vector("version");
    const plain = bytesOf(300);

    await draft(alice, "alice/tool", both.version, "First stable.");
    await uploadVector(alice, "alice/tool", both);
    await upload(alice, "alice/tool", both.version, "demo-darwin-arm64.tar.gz", plain);
    await publish(alice, "alice/tool", both.version, "stable");
    await draft(alice, "alice/tool", rc.version);
    await uploadVector(alice, "alice/tool", rc);
    await publish(alice, "alice/tool", rc.version, "beta");

    const res = await feed("/alice/tool/manifest.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const manifest = (await res.json()) as Manifest;

    // The shape of docs/manifest.example.json: a signed asset with launch
    // overrides, an unsigned one with only the required fields and a size,
    // notes where the version has them.
    expect(manifest).toEqual({
      schema: "lode/v1",
      name: "tool",
      channels: {
        beta: { latest: rc.version },
        stable: { latest: both.version },
      },
      versions: {
        [rc.version]: {
          assets: [
            {
              name: rc.name,
              url: `${ORIGIN}/r/alice/tool/${rc.version}/${rc.name}`,
              sha256: rc.sha256,
              size: rc.content.length,
              sig: rc.sig,
              key_id: signer.keyId,
              alg: "ed25519",
            },
          ],
        },
        [both.version]: {
          notes: "First stable.",
          assets: [
            {
              name: both.name,
              url: `${ORIGIN}/r/alice/tool/${both.version}/${both.name}`,
              sha256: both.sha256,
              size: both.content.length,
              sig: both.sig,
              key_id: signer.keyId,
              alg: "ed25519",
              run: both.run!,
              exec: both.exec!,
            },
            {
              name: "demo-darwin-arm64.tar.gz",
              url: `${ORIGIN}/r/alice/tool/${both.version}/demo-darwin-arm64.tar.gz`,
              sha256: sha256Hex(plain),
              size: 300,
            },
          ],
        },
      },
    });

    for (const key of Object.keys(manifest))
      expect(MANIFEST_KEYS).toContain(key);
    for (const version of Object.values(manifest.versions)) {
      for (const key of Object.keys(version))
        expect(VERSION_KEYS).toContain(key);
      for (const asset of version.assets) {
        for (const [key, value] of Object.entries(asset)) {
          expect(ASSET_KEYS).toContain(key);
          // An absent field is left out, never null.
          expect(value).not.toBeNull();
        }
      }
    }
    // Newest first.
    expect(Object.keys(manifest.versions)).toEqual([rc.version, both.version]);
  });

  test("asset urls follow APP_URL without BASE_PATH, or the request when APP_URL is unset", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    await release(alice, "alice/demo", "1.0.0");

    const based = await feed("/alice/demo/manifest.json", {}, { APP_URL: "https://pkg.example.test/", BASE_PATH: "/app" });
    expect(((await based.json()) as Manifest).versions["1.0.0"]!.assets[0]!.url).toBe("https://pkg.example.test/r/alice/demo/1.0.0/tool");

    const res = await app({ APP_URL: undefined }).request("http://registry.internal:8080/r/alice/demo/manifest.json");
    expect(((await res.json()) as Manifest).versions["1.0.0"]!.assets[0]!.url).toBe("http://registry.internal:8080/r/alice/demo/1.0.0/tool");
  });

  test("lists neither drafts nor yanked versions, and does not serve their assets", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    await release(alice, "alice/demo", "1.0.0");
    await release(alice, "alice/demo", "1.1.0");
    await draft(alice, "alice/demo", "2.0.0");
    await upload(alice, "alice/demo", "2.0.0", "tool", bytesOf(64));
    expect((await alice.call("POST", "/packages/alice/demo/versions/1.0.0/yank")).status).toBe(200);

    const manifest = await manifestOf("alice/demo");
    expect(Object.keys(manifest.versions)).toEqual(["1.1.0"]);
    expect(manifest.channels).toEqual({
      stable: { latest: "1.1.0" },
    });

    expect((await feed("/alice/demo/1.1.0/tool")).status).toBe(200);
    await expectNotFound(await feed("/alice/demo/1.0.0/tool"));
    await expectNotFound(await feed("/alice/demo/2.0.0/tool"));
  });

  test("a package with nothing published still has a manifest", async () => {
    await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    expect(await manifestOf("alice/demo")).toEqual({
      schema: "lode/v1",
      name: "demo",
      channels: {},
      versions: {},
    });
  });

  test("is capped at the newest versions, plus every channel target", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    const order = [
      "1.0.0",
      "1.1.0",
      "1.2.0",
      "1.3.0",
      "1.4.0",
    ];
    for (const [i, version] of order.entries()) {
      await release(alice, "alice/demo", version);
      await db.update(registryVersions).set({
        publishedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      }).where(eq(registryVersions.version, version)).run();
    }
    expect((await alice.call("PUT", "/packages/alice/demo/channels/lts", { version: "1.0.0" })).status).toBe(200);

    const res = await feed("/alice/demo/manifest.json", {}, { REGISTRY_MANIFEST_MAX_VERSIONS: 2 });
    const manifest = (await res.json()) as Manifest;
    expect(Object.keys(manifest.versions)).toEqual(["1.4.0", "1.3.0", "1.0.0"]);
    expect(manifest.channels).toEqual({
      lts: { latest: "1.0.0" },
      stable: { latest: "1.4.0" },
    });
    expect(manifest.versions["1.0.0"]!.assets).toHaveLength(1);

    // A version the cap dropped is still downloadable.
    expect((await feed("/alice/demo/1.1.0/tool")).status).toBe(200);
  });
});

describe("read feed: caching", () => {
  test("a public manifest carries a strong ETag and a short max-age, and honours If-None-Match", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    await release(alice, "alice/demo", "1.0.0");

    const first = await feed("/alice/demo/manifest.json");
    const body = await first.text();
    expect(first.headers.get("cache-control")).toBe("public, max-age=60");
    const etag = first.headers.get("etag")!;
    expect(etag).toBe(`"${sha256Hex(new TextEncoder().encode(body))}"`);

    for (const sent of [
      etag,
      `"other", ${etag}`,
      `W/${etag}`,
      "*",
    ]) {
      const res = await feed("/alice/demo/manifest.json", { "If-None-Match": sent });
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    }
    expect((await feed("/alice/demo/manifest.json", { "If-None-Match": "\"other\"" })).status).toBe(200);

    // A new release is a new document.
    await release(alice, "alice/demo", "1.1.0");
    const next = await feed("/alice/demo/manifest.json", { "If-None-Match": etag });
    expect(next.status).toBe(200);
    expect(next.headers.get("etag")).not.toBe(etag);
  });

  test("a public asset is immutable", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    await release(alice, "alice/demo", "1.0.0");
    const res = await feed("/alice/demo/1.0.0/tool");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});

describe("read feed: assets", () => {
  test("streams the bytes that were uploaded", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    const bytes = bytesOf(70_000, 7);
    await draft(alice, "alice/demo", "1.0.0");
    await upload(alice, "alice/demo", "1.0.0", "demo-linux-x86_64.tar.gz", bytes);
    await publish(alice, "alice/demo", "1.0.0");

    const asset = (await manifestOf("alice/demo")).versions["1.0.0"]!.assets[0]!;
    expect(asset.url.startsWith(`${ORIGIN}/r/`)).toBe(true);
    const res = await app().request(asset.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe("70000");
    const got = new Uint8Array(await res.arrayBuffer());
    expect(got.length).toBe(70_000);
    expect(sha256Hex(got)).toBe(asset.sha256);
    expect(sha256Hex(got)).toBe(sha256Hex(bytes));
  });

  test("HEAD answers the headers without a body", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    await release(alice, "alice/demo", "1.0.0");
    const res = await app().request("/r/alice/demo/1.0.0/tool", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("64");
    expect(await res.text()).toBe("");
  });

  test("unknown namespace, package, version and asset are 404", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    await release(alice, "alice/demo", "1.0.0");
    for (const path of [
      "/nobody/demo/manifest.json",
      "/alice/nothing/manifest.json",
      "/ALICE/demo/manifest.json",
      "/nobody/demo/1.0.0/tool",
      "/alice/nothing/1.0.0/tool",
      "/alice/demo/9.9.9/tool",
      "/alice/demo/1.0.0/other",
    ]) {
      await expectNotFound(await feed(path));
    }
  });
});

describe("read feed: private packages", () => {
  test("need a token with a read grant on the package; anything else is 404", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "secret", visibility: "private" },
      { slug: "other", visibility: "private" },
    ]);
    const bob = await seedPublisher("bob");
    const bytes = await release(alice, "alice/secret", "1.0.0");
    const granted = await token(alice, [
      { package: "alice/secret", access: "read" },
    ]);
    const elsewhere = await token(alice, [
      { package: "alice/other", access: "admin" },
    ]);
    const foreign = await token(bob, { all: "admin" });

    const refused: Record<string, string>[] = [
      {},
      { Authorization: `Bearer ${elsewhere}` },
      { Authorization: `Bearer ${foreign}` },
      { Authorization: "Bearer pat_unknown" },
      { Authorization: `Basic ${granted}` },
      // The feed never looks at a session, not even the owner's.
      { Cookie: alice.cookie },
    ];
    for (const headers of refused) {
      await expectNotFound(await feed("/alice/secret/manifest.json", headers));
      await expectNotFound(await feed("/alice/secret/1.0.0/tool", headers));
    }

    const auth = { Authorization: `Bearer ${granted}` };
    const manifest = await feed("/alice/secret/manifest.json", auth);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("cache-control")).toBe("private, no-store");
    expect(manifest.headers.get("etag")).toBeNull();
    expect(Object.keys(((await manifest.json()) as Manifest).versions)).toEqual(["1.0.0"]);
    // A validator must not turn a private answer into a cacheable 304.
    expect((await feed("/alice/secret/manifest.json", { ...auth, "If-None-Match": "*" })).status).toBe(200);

    const asset = await feed("/alice/secret/1.0.0/tool", auth);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("private, no-store");
    expect(sha256Hex(new Uint8Array(await asset.arrayBuffer()))).toBe(sha256Hex(bytes));
  });

  test("an 'all my packages' read grant covers them", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "secret", visibility: "private" },
    ]);
    await release(alice, "alice/secret", "1.0.0");
    const all = await token(alice, { all: "read" });
    expect((await feed("/alice/secret/manifest.json", { Authorization: `Bearer ${all}` })).status).toBe(200);
  });
});

describe("read feed: suspended namespace", () => {
  test("serves nothing, public or private", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
      { slug: "secret", visibility: "private" },
    ]);
    await release(alice, "alice/demo", "1.0.0");
    await release(alice, "alice/secret", "1.0.0");
    const auth = { Authorization: `Bearer ${await token(alice, { all: "read" })}` };
    expect((await feed("/alice/demo/manifest.json")).status).toBe(200);

    await db.update(registryNamespaces).set({ status: "suspended" }).run();
    for (const headers of [{}, auth]) {
      for (const path of [
        "/alice/demo/manifest.json",
        "/alice/demo/1.0.0/tool",
        "/alice/secret/manifest.json",
        "/alice/secret/1.0.0/tool",
      ])
        await expectNotFound(await feed(path, headers));
    }
  });
});

describe("read feed: mount", () => {
  test("needs no session or CSRF headers and sets no cookie", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    await release(alice, "alice/demo", "1.0.0");
    for (const path of ["/alice/demo/manifest.json", "/alice/demo/1.0.0/tool"]) {
      // No Origin, no X-Requested-With, no cookie.
      const res = await feed(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
      expect(res.headers.get("x-api-stack")).toBeNull();
      // Unlike the raw API, the feed keeps the browser security headers: it
      // serves uploaded bytes from the application's origin.
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).not.toBeNull();
    }
  });

  test("an unknown path under /r is answered by the feed, not by /api or the SPA", async () => {
    await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    for (const path of [
      "",
      "/",
      "/alice",
      "/alice/demo",
      "/alice/demo/1.0.0",
      "/alice/demo/1.0.0/tool/extra",
      "/api/registry/namespace",
    ]) {
      const res = await feed(path);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("x-api-stack")).toBeNull();
      await expectNotFound(res);
    }
  });

  test("only reads are served", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    await release(alice, "alice/demo", "1.0.0");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/r/alice/demo/manifest.json", "/r/alice/demo/1.0.0/tool"])
        await expectNotFound(await app().request(path, { method }));
    }
    expect((await feed("/alice/demo/1.0.0/tool")).status).toBe(200);
  });

  test("stays at the origin root when the app is under BASE_PATH", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    await release(alice, "alice/demo", "1.0.0");
    expect((await feed("/alice/demo/manifest.json", {}, { BASE_PATH: "/app" })).status).toBe(200);
    // Under the prefix there is no feed: whatever answers (the SPA fallback
    // when a build is present, else nothing) is not a manifest.
    const prefixed = await app({ BASE_PATH: "/app" }).request("/app/r/alice/demo/manifest.json");
    expect(await prefixed.text()).not.toContain("lode/v1");
  });

  test("the per-client raw rate limit applies", async () => {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    await release(alice, "alice/demo", "1.0.0");
    const limited = { RAW_API_RATE_LIMIT_PER_MINUTE: 2 };
    expect((await feed("/alice/demo/manifest.json", {}, limited)).status).toBe(200);
    expect((await feed("/alice/demo/1.0.0/tool", {}, limited)).status).toBe(200);
    const res = await feed("/alice/demo/manifest.json", {}, limited);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("read feed: publisher-signed manifest", () => {
  const SIGNATURE = "/packages/alice/demo/manifest-signature";
  const IN_30_DAYS = Math.floor(Date.now() / 1000) + 30 * 86400;

  interface Signer { keyId: string; publicKey: string; sign: (message: Uint8Array<ArrayBuffer>) => Promise<string> }
  interface State { key_id: string; expires: number | null; status: string }

  /** A fresh ed25519 key, registered for alice/demo: what `lode-cli keygen` and the Signing keys tab do. */
  async function registerSigner(alice: Publisher): Promise<Signer> {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const res = await alice.call("POST", "/packages/alice/demo/keys", { public_key: publicKey, name: "ci" });
    expect(res.status).toBe(201);
    const { key_id: keyId } = ((await res.json()) as { data: { key_id: string } }).data;
    return {
      keyId,
      publicKey,
      sign: async message => encodeBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message))),
    };
  }

  /** What `lode-cli manifest-sign` adds to a downloaded manifest. */
  async function signatureOf(signer: Signer, manifest: Manifest, expires?: number) {
    const catalog = canonicalCatalog(manifest);
    return {
      key_id: signer.keyId,
      sig: await signer.sign(manifestMessage(manifest.name, signer.keyId, catalog)),
      ...(expires !== undefined && { expires, expires_sig: await signer.sign(manifestExpiryMessage(manifest.name, signer.keyId, expires, catalog)) }),
    };
  }

  async function stateOf(who: Publisher): Promise<State | null> {
    const res = await who.call("GET", SIGNATURE);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: State | null }).data;
  }

  async function refusal(res: Response): Promise<string> {
    return `${res.status} ${((await res.json()) as { error: { code: string } }).error.code}`;
  }

  async function seed() {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    const signer = await registerSigner(alice);
    await release(alice, "alice/demo", "1.0.0");
    return { alice, signer };
  }

  test("an unsigned package has no signature and its manifest none of the fields", async () => {
    const { alice } = await seed();
    expect(await stateOf(alice)).toBeNull();
    const manifest = await manifestOf("alice/demo");
    expect(Object.keys(manifest)).toEqual([
      "schema",
      "name",
      "channels",
      "versions",
    ]);
  });

  test("a signature over the downloaded manifest is served with it, and verifies over what is served", async () => {
    const { alice, signer } = await seed();
    const body = await signatureOf(signer, await manifestOf("alice/demo"), IN_30_DAYS);
    const res = await alice.call("PUT", SIGNATURE, body);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: State }).data).toMatchObject({ key_id: signer.keyId, expires: IN_30_DAYS, status: "live" });
    expect(await stateOf(alice)).toMatchObject({ key_id: signer.keyId, expires: IN_30_DAYS, status: "live" });

    const served = await manifestOf("alice/demo");
    expect(served).toMatchObject(body);
    // As lode checks it: from the served document alone.
    const catalog = canonicalCatalog(served);
    expect(await verifyEd25519(signer.publicKey, served.sig!, manifestMessage(served.name, served.key_id!, catalog))).toBe(true);
    expect(await verifyEd25519(signer.publicKey, served.expires_sig!, manifestExpiryMessage(served.name, served.key_id!, served.expires!, catalog))).toBe(true);
  });

  test("without an expiry only key_id and sig are served", async () => {
    const { alice, signer } = await seed();
    expect((await alice.call("PUT", SIGNATURE, await signatureOf(signer, await manifestOf("alice/demo")))).status).toBe(200);
    const served = await manifestOf("alice/demo");
    expect(served.sig).toBeString();
    expect("expires" in served || "expires_sig" in served).toBe(false);
    expect(await stateOf(alice)).toMatchObject({ expires: null, status: "live" });
  });

  test("a release step makes it stale: the manifest goes out unsigned until it is signed again", async () => {
    const { alice, signer } = await seed();
    expect((await alice.call("PUT", SIGNATURE, await signatureOf(signer, await manifestOf("alice/demo"), IN_30_DAYS))).status).toBe(200);

    await release(alice, "alice/demo", "1.1.0");
    expect((await stateOf(alice))!.status).toBe("stale");
    const unsigned = await manifestOf("alice/demo");
    expect(unsigned.channels.stable).toEqual({ latest: "1.1.0" });
    expect(unsigned.sig).toBeUndefined();
    expect(unsigned.expires).toBeUndefined();

    expect((await alice.call("PUT", SIGNATURE, await signatureOf(signer, unsigned, IN_30_DAYS))).status).toBe(200);
    expect((await manifestOf("alice/demo")).sig).toBeString();

    // A channel move changes the catalog as well.
    expect((await alice.call("PUT", "/packages/alice/demo/channels/stable", { version: "1.0.0" })).status).toBe(200);
    expect((await stateOf(alice))!.status).toBe("stale");
    expect((await manifestOf("alice/demo")).sig).toBeUndefined();
  });

  test("a lapsed expiry and a revoked key take it out of the manifest", async () => {
    const { alice, signer } = await seed();
    expect((await alice.call("PUT", SIGNATURE, await signatureOf(signer, await manifestOf("alice/demo"), IN_30_DAYS))).status).toBe(200);

    await db.update(registryManifestSignatures).set({
      expires: Math.floor(Date.now() / 1000),
    }).run();
    expect((await stateOf(alice))!.status).toBe("expired");
    expect((await manifestOf("alice/demo")).sig).toBeUndefined();

    await db.update(registryManifestSignatures).set({ expires: IN_30_DAYS }).run();
    expect((await manifestOf("alice/demo")).sig).toBeString();
    const keys = ((await (await alice.call("GET", "/packages/alice/demo/keys")).json()) as { data: { id: string }[] }).data;
    expect((await alice.call("DELETE", `/packages/alice/demo/keys/${keys[0]!.id}`)).status).toBe(200);
    expect((await stateOf(alice))!.status).toBe("revoked");
    expect((await manifestOf("alice/demo")).sig).toBeUndefined();
  });

  test("nothing unverified is stored", async () => {
    const { alice, signer } = await seed();
    const manifest = await manifestOf("alice/demo");
    const good = await signatureOf(signer, manifest, IN_30_DAYS);

    expect(await refusal(await alice.call("PUT", SIGNATURE, { ...good, key_id: "0123456789abcdef" }))).toBe("400 UNKNOWN_KEY");
    const past = Math.floor(Date.now() / 1000) - 1;
    expect(await refusal(await alice.call("PUT", SIGNATURE, await signatureOf(signer, manifest, past)))).toBe("400 MANIFEST_EXPIRED");
    // The expiry signed is not the one sent.
    expect(await refusal(await alice.call("PUT", SIGNATURE, { ...good, expires: IN_30_DAYS + 1 }))).toBe("409 MANIFEST_CHANGED");
    // Signed over another catalog.
    const other = await signatureOf(signer, {
      ...manifest,
      channels: {
        stable: { latest: "9.9.9" },
      },
    });
    expect(await refusal(await alice.call("PUT", SIGNATURE, other))).toBe("409 MANIFEST_CHANGED");
    // Signed by a key that is not the package's.
    const stranger = { ...signer, sign: (await registerStranger()).sign };
    expect(await refusal(await alice.call("PUT", SIGNATURE, await signatureOf(stranger, manifest)))).toBe("409 MANIFEST_CHANGED");
    for (const body of [
      { key_id: good.key_id, sig: good.sig, expires: IN_30_DAYS },
      { key_id: good.key_id, sig: good.sig, expires_sig: good.expires_sig },
      { ...good, alg: "ed25519" },
    ])
      expect((await alice.call("PUT", SIGNATURE, body)).status).toBe(422);

    expect(await stateOf(alice)).toBeNull();
    expect((await manifestOf("alice/demo")).sig).toBeUndefined();

    async function registerStranger() {
      const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
      return {
        sign: async (message: Uint8Array<ArrayBuffer>) => encodeBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message))),
      };
    }
  });

  test("a write token signs and removes it, a read token only sees its state, another user neither", async () => {
    const { alice, signer } = await seed();
    const body = await signatureOf(signer, await manifestOf("alice/demo"), IN_30_DAYS);
    const withToken = async (bearer: string, method: string, json?: unknown) => await app().request(`/api/registry${SIGNATURE}`, {
      method,
      headers: { "Authorization": `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(json !== undefined && {
        body: JSON.stringify(json),
      }),
    });
    const reader = await token(alice, [
      { package: "alice/demo", access: "read" },
    ]);
    const writer = await token(alice, [
      { package: "alice/demo", access: "write" },
    ]);

    expect((await withToken(reader, "PUT", body)).status).toBe(403);
    expect((await withToken(writer, "PUT", body)).status).toBe(200);
    expect((await withToken(reader, "GET")).status).toBe(200);
    expect((await withToken(reader, "DELETE")).status).toBe(403);

    const bob = await seedPublisher("bob");
    expect((await bob.call("GET", SIGNATURE)).status).toBe(200);
    expect((await bob.call("PUT", SIGNATURE, body)).status).toBe(403);
    expect((await bob.call("DELETE", SIGNATURE)).status).toBe(403);

    expect(((await (await withToken(writer, "DELETE")).json()) as { data: { removed: boolean } }).data.removed).toBe(true);
    expect(((await (await withToken(writer, "DELETE")).json()) as { data: { removed: boolean } }).data.removed).toBe(false);
    expect(await stateOf(alice)).toBeNull();
    expect((await manifestOf("alice/demo")).sig).toBeUndefined();
  });
});

describe("manifest commits", () => {
  const COMMITS = "/packages/alice/demo/commits";

  interface Signer { keyId: string; sign: (message: Uint8Array<ArrayBuffer>) => Promise<string> }
  interface Commit { id: string; parent: string | null; generation: number; versions: string[]; added: string[]; dropped: string[]; channels: Record<string, string>; head: boolean }

  async function registerSigner(alice: Publisher): Promise<Signer> {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const publicKey = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const res = await alice.call("POST", "/packages/alice/demo/keys", { public_key: publicKey, name: "ci" });
    expect(res.status).toBe(201);
    const { key_id: keyId } = ((await res.json()) as { data: { key_id: string } }).data;
    return {
      keyId,
      sign: async message => encodeBase64Url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message))),
    };
  }

  /** A draft with one signed asset `tool`, optionally with a runtime: what `lode-cli publish` uploads. */
  async function signedDraft(alice: Publisher, signer: Signer, version: string, runtime?: RuntimeSpec) {
    const bytes = bytesOf(64, version.charCodeAt(0));
    const sha256 = sha256Hex(bytes);
    const sig = await signer.sign(artifactMessage({
      app: "demo",
      name: "tool",
      version,
      sha256,
      runtime,
    }));
    await draft(alice, "alice/demo", version);
    await upload(alice, "alice/demo", version, "tool", bytes, {
      sig,
      ...(runtime && {
        runtime: runtime.runtime,
        runtime_version: runtime.version!,
        runtime_download: runtime.download!,
        runtime_sha256: runtime.sha256!,
      }),
    });
    return {
      name: "tool",
      url: "",
      sha256,
      sig,
      key_id: signer.keyId,
      ...(runtime && { runtime }),
    };
  }

  /** `head` with `versions` and `channels` changed, signed as the next commit: what `lode-cli` sends. */
  async function commitOn(alice: Publisher, signer: Signer, change: { versions?: Record<string, unknown>; drop?: string; channels?: Record<string, string> }, created = "2026-10-24T00:00:00Z") {
    const head = ((await (await alice.call("GET", `${COMMITS}/head`)).json()) as { data: { commit: string | null; generation: number; manifest: Manifest } }).data;
    const versions = {
      ...head.manifest.versions,
      ...change.versions,
    } as Manifest["versions"];
    if (change.drop)
      delete versions[change.drop];
    const channels = {
      ...head.manifest.channels,
      ...Object.fromEntries(Object.entries(change.channels ?? {}).map(([c, v]) => [
        c,
        { latest: v },
      ])),
    };
    const body = {
      schema: "lode/v1",
      name: "demo",
      key_id: signer.keyId,
      generation: head.generation + 1,
      ...(head.commit !== null && { parent: head.commit }),
      created,
      channels,
      versions,
    };
    const catalog = canonicalCatalog(body);
    return {
      ...body,
      sig: await signer.sign(manifestMessage("demo", signer.keyId, catalog)),
      commit_sig: await signer.sign(manifestCommitMessage("demo", signer.keyId, body.generation, head.commit ?? "", created, catalog)),
    };
  }

  async function post(alice: Publisher, body: unknown): Promise<Response> {
    return await alice.call("POST", COMMITS, body);
  }

  async function code(res: Response): Promise<string> {
    return ((await res.json()) as { error: { code: string } }).error.code;
  }

  async function seed() {
    const alice = await seedPublisher("alice", [
      { slug: "demo" },
    ]);
    const signer = await registerSigner(alice);
    return { alice, signer };
  }

  test("a commit publishes its drafts, moves the channels and is served as signed", async () => {
    const { alice, signer } = await seed();
    const asset = await signedDraft(alice, signer, "1.0.0");
    const first = await commitOn(alice, signer, {
      versions: {
        "1.0.0": {
          notes: "first",
          assets: [asset],
        },
      },
      channels: { stable: "1.0.0" },
    });

    const res = await post(alice, first);
    expect(res.status).toBe(201);
    const commit = ((await res.json()) as { data: Commit }).data;
    expect(commit).toMatchObject({
      parent: null,
      generation: 1,
      versions: ["1.0.0"],
      added: ["1.0.0"],
      dropped: [],
      channels: { stable: "1.0.0" },
      head: true,
    });
    // The same commit again is stored once.
    const again = await post(alice, first);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { data: Commit }).data.id).toBe(commit.id);

    const served = await manifestOf("alice/demo");
    expect(served).toMatchObject({
      generation: 1,
      created: first.created,
      sig: first.sig,
      commit_sig: first.commit_sig,
      channels: {
        stable: { latest: "1.0.0" },
      },
    });
    expect(served.versions["1.0.0"]!.assets[0]).toMatchObject({
      name: "tool",
      sha256: asset.sha256,
      sig: asset.sig,
      size: 64,
      url: `${ORIGIN}/r/alice/demo/1.0.0/tool`,
    });
    expect(served.versions["1.0.0"]!.notes).toBe("first");
    expect((await feed("/alice/demo/1.0.0/tool")).status).toBe(200);

    // The commit id is the sha256 of the commit message, as lode computes it.
    const catalog = canonicalCatalog(served);
    expect(commit.id).toBe(sha256Hex(manifestCommitMessage("demo", signer.keyId, 1, "", first.created, catalog)));

    // The next commit builds on it.
    const runtime = {
      runtime: "node",
      version: "v22.",
      download: "https://x/node.tar.gz",
      sha256: "c".repeat(64),
    };
    const second = await commitOn(alice, signer, {
      versions: {
        "2.0.0": {
          assets: [await signedDraft(alice, signer, "2.0.0", runtime)],
        },
      },
      channels: { beta: "2.0.0" },
    });
    expect(second.parent).toBe(commit.id);
    expect((await post(alice, second)).status).toBe(201);
    const served2 = await manifestOf("alice/demo");
    expect(served2.versions["2.0.0"]!.assets[0]!.runtime).toEqual(runtime);
    const listed = ((await (await alice.call("GET", COMMITS)).json()) as { data: { commits: Commit[] } }).data.commits;
    expect(listed.map(c => [c.generation, c.head, c.added])).toEqual([
      [
        2,
        true,
        ["2.0.0"],
      ],
      [
        1,
        false,
        ["1.0.0"],
      ],
    ]);

    const channels = ((await (await alice.call("GET", "/packages/alice/demo/versions")).json()) as { data: { channels: { name: string; version: string }[] } }).data.channels;
    expect(channels.map(c => `${c.name}=${c.version}`)).toEqual(["beta=2.0.0", "stable=1.0.0"]);
  });

  test("only a commit on the head lands", async () => {
    const { alice, signer } = await seed();
    const asset = await signedDraft(alice, signer, "1.0.0");
    const base = {
      versions: {
        "1.0.0": {
          assets: [asset],
        },
      },
      channels: { stable: "1.0.0" },
    };
    const first = await commitOn(alice, signer, base);
    const rival = await commitOn(alice, signer, base, "2026-10-25T00:00:00Z");
    expect((await post(alice, first)).status).toBe(201);
    const res = await post(alice, rival);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("COMMIT_CONFLICT");
  });

  test("a commit must match the uploads and verify", async () => {
    const { alice, signer } = await seed();
    const asset = await signedDraft(alice, signer, "1.0.0");
    const cases: [Record<string, unknown>, number, string][] = [
      [await commitOn(alice, signer, {
        versions: {
          "1.0.0": {
            assets: [
              {
                ...asset,
                sha256: "0".repeat(64),
              },
            ],
          },
        },
        channels: { stable: "1.0.0" },
      }), 400, "INVALID_COMMIT"],
      [await commitOn(alice, signer, {
        versions: {
          "1.0.0": {
            assets: [
              { ...asset, run: "./tool" },
            ],
          },
        },
        channels: { stable: "1.0.0" },
      }), 400, "INVALID_COMMIT"],
      [await commitOn(alice, signer, {
        versions: {
          "9.0.0": {
            assets: [asset],
          },
        },
        channels: { stable: "9.0.0" },
      }), 400, "INVALID_COMMIT"],
      [
        {
          ...(await commitOn(alice, signer, {
            versions: {
              "1.0.0": {
                assets: [asset],
              },
            },
            channels: { stable: "1.0.0" },
          })),
          name: "other",
        },
        400,
        "INVALID_COMMIT",
      ],
      [
        {
          ...(await commitOn(alice, signer, {
            versions: {
              "1.0.0": {
                assets: [asset],
              },
            },
            channels: { stable: "1.0.0" },
          })),
          created: "2027-01-01T00:00:00Z",
        },
        400,
        "INVALID_SIGNATURE",
      ],
    ];
    for (const [body, status, expected] of cases) {
      const res = await post(alice, body);
      expect({ status: res.status, code: await code(res) }).toEqual({ status, code: expected });
    }
    expect((await manifestOf("alice/demo")).versions).toEqual({});
  });

  test("a re-signed asset is served with its new signature, and the next commit builds on it", async () => {
    const { alice, signer } = await seed();
    const asset = await signedDraft(alice, signer, "1.0.0");
    expect((await post(alice, await commitOn(alice, signer, {
      versions: {
        "1.0.0": {
          assets: [asset],
        },
      },
      channels: { stable: "1.0.0" },
    }))).status).toBe(201);

    const rotated = await registerSigner(alice);
    const sig = await rotated.sign(artifactMessage({
      app: "demo",
      name: "tool",
      version: "1.0.0",
      sha256: asset.sha256,
    }));
    expect((await alice.call("PUT", "/packages/alice/demo/versions/1.0.0/assets/tool/signature", { sig })).status).toBe(200);

    const resigned = { sig, key_id: rotated.keyId };
    expect((await manifestOf("alice/demo")).versions["1.0.0"]!.assets[0]).toMatchObject(resigned);
    const head = ((await (await alice.call("GET", `${COMMITS}/head`)).json()) as { data: { manifest: Manifest } }).data;
    expect(head.manifest.versions["1.0.0"]!.assets[0]).toMatchObject(resigned);
    expect((await post(alice, await commitOn(alice, signer, {
      channels: { beta: "1.0.0" },
    }))).status).toBe(201);
  });

  test("a commit package refuses the generated-manifest operations, and a yank is an emergency stop", async () => {
    const { alice, signer } = await seed();
    const asset = await signedDraft(alice, signer, "1.0.0");
    expect((await post(alice, await commitOn(alice, signer, {
      versions: {
        "1.0.0": {
          assets: [asset],
        },
      },
      channels: { stable: "1.0.0" },
    }))).status).toBe(201);
    await draft(alice, "alice/demo", "2.0.0");
    await upload(alice, "alice/demo", "2.0.0", "tool", bytesOf(64, 9));

    for (const [method, path, body] of [
      [
        "POST",
        "/packages/alice/demo/versions/2.0.0/publish",
        { channel: "stable" },
      ],
      [
        "PUT",
        "/packages/alice/demo/channels/beta",
        { version: "1.0.0" },
      ],
      [
        "PUT",
        "/packages/alice/demo/manifest-signature",
        { key_id: signer.keyId, sig: "c2ln" },
      ],
    ] as const) {
      const res = await alice.call(method, path, body);
      expect({ path, status: res.status, code: await code(res) }).toEqual({ path, status: 409, code: "PACKAGE_USES_COMMITS" });
    }
    const deleted = await alice.call("DELETE", "/packages/alice/demo/versions/1.0.0");
    expect({ status: deleted.status, code: await code(deleted) }).toEqual({ status: 409, code: "VERSION_IN_COMMIT" });

    // The channel points at 1.0.0, yet the stop goes through.
    expect((await alice.call("POST", "/packages/alice/demo/versions/1.0.0/yank")).status).toBe(200);
    expect((await feed("/alice/demo/1.0.0/tool")).status).toBe(404);
    expect(Object.keys((await manifestOf("alice/demo")).versions)).toEqual(["1.0.0"]);
    expect((await alice.call("POST", "/packages/alice/demo/versions/1.0.0/restore")).status).toBe(200);
    expect((await feed("/alice/demo/1.0.0/tool")).status).toBe(200);
  });
});
