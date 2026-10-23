import type { AppDeps } from "@/app";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
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
import { pruneObservations } from "./observe.service";
import { registryInstanceEvents, registryInstances, registryNamespaces } from "./schema";
import "@/modules/account";

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

let dir: string;
let db: AppDatabase;
let config: Config;

beforeEach(async () => {
  __resetBlobStoresForTests();
  await __resetRateLimitForTests();
  dir = mkdtempSync(resolve(tmpdir(), "registry-observe-"));
  db = await createDb(resolve(dir, "app.db"));
  config = configSchema.parse({ NODE_ENV: "test", APP_URL: "https://pkg.example.test", REGISTRY_BLOB_LOCAL_ROOT: join(dir, "blobs") });
});

afterEach(() => {
  __resetBlobStoresForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function app(overrides: Partial<Config> = {}) {
  const cfg = { ...config, ...overrides } as Config;
  const api = new Hono<AppEnv>();
  api.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", cfg);
    c.set("logger", noop);
    await next();
  });
  api.use("*", policyMiddleware({ basePath: `${cfg.BASE_PATH}/api` }));
  api.route("/", registryRoutes());
  api.onError(errorHandler);
  const deps: AppDeps = { config: cfg, db, logger: noop, encryption: { isSystemLocked: () => false } as unknown as AppDeps["encryption"] };
  return buildOuterApp(api, cfg, undefined, undefined, buildRawApp(deps, registryFeedRoutes()));
}

interface Owner {
  readonly call: (method: string, path: string, body?: unknown) => Promise<Response>;
}

/** A signed-in user whose namespace slug is their id, owning `packages`. */
async function seedOwner(id: string, packages: readonly { slug: string; visibility?: "public" | "private" }[]): Promise<Owner> {
  const now = new Date().toISOString();
  await db.insert(users).values({ id, oauthSub: `sub-${id}`, username: id, name: id, email: `${id}@t.io`, role: "user", status: "active", createdAt: now, updatedAt: now }).run();
  await db.insert(registryNamespaces).values({ id: `ns-${id}`, slug: id, ownerUserId: id }).run();
  const cookie = `session_id=${await createSession(db, id, "access", undefined, 3600)}`;
  const owner: Owner = {
    call: async (method, path, body) => await app().request(`/api/registry${path}`, {
      method,
      headers: { "Cookie": cookie, "Content-Type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  };
  for (const pkg of packages)
    expect((await owner.call("POST", "/packages", { name: pkg.slug, ...pkg })).status).toBe(201);
  return owner;
}

async function token(owner: Owner, grants: unknown): Promise<string> {
  const res = await owner.call("POST", "/tokens", { name: "host", grants });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { token: string } }).data.token;
}

function kv(attrs: Record<string, string | number>) {
  return Object.entries(attrs).map(([key, v]) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v } }));
}

const HOST = { "service.name": "tool", "service.version": "1.5.0", "service.instance.id": "web-01", "host.name": "web-01", "os.type": "linux", "host.arch": "amd64", "lode.version": "0.2.0", "lode.report.interval": 300 };

function metricsBody(resource: Record<string, string | number>, status = "running") {
  return {
    resourceMetrics: [{
      resource: { attributes: kv(resource) },
      scopeMetrics: [{
        scope: { name: "lode" },
        metrics: [
          { name: "lode.app.up", gauge: { dataPoints: [{ asInt: "1" }] } },
          { name: "lode.app.status", gauge: { dataPoints: [{ asInt: "1", attributes: kv({ status }) }] } },
        ],
      }],
    }],
  };
}

function logsBody(resource: Record<string, string | number>, names: readonly string[]) {
  return {
    resourceLogs: [{
      resource: { attributes: kv(resource) },
      scopeLogs: [{ logRecords: names.map((name, i) => ({ eventName: name, timeUnixNano: String(BigInt(Date.UTC(2026, 9, 22, 12, 0, i)) * 1_000_000n), body: { stringValue: name } })) }],
    }],
  };
}

async function report(kind: "metrics" | "logs", body: unknown, headers: Record<string, string> = {}, overrides: Partial<Config> = {}): Promise<Response> {
  return await app(overrides).request(`/r/otlp/v1/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

interface Instance { instance_id: string; version: string; status: string; host_name: string; online: boolean; lode_version: string; interval_seconds: number }

describe("OTLP ingest", () => {
  test("a metrics export creates, then refreshes, the instance the package lists", async () => {
    const alice = await seedOwner("alice", [{ slug: "tool" }]);
    const pat = await token(alice, { all: "read" });

    const first = await report("metrics", metricsBody(HOST), bearer(pat));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({});
    expect((await report("metrics", metricsBody({ ...HOST, "service.version": "1.6.0" }, "updating"), bearer(pat))).status).toBe(200);

    const res = await alice.call("GET", "/packages/alice/tool/instances");
    expect(res.status).toBe(200);
    const [instance, ...rest] = ((await res.json()) as { data: Instance[] }).data;
    expect(rest).toEqual([]);
    expect(instance).toMatchObject({ instance_id: "web-01", version: "1.6.0", status: "updating", host_name: "web-01", online: true, lode_version: "0.2.0", interval_seconds: 300 });

    // A host that reported itself stopped is offline at once.
    await report("metrics", metricsBody(HOST, "stopped"), bearer(pat));
    const stopped = ((await (await alice.call("GET", "/packages/alice/tool/instances")).json()) as { data: Instance[] }).data[0];
    expect(stopped).toMatchObject({ status: "stopped", online: false });
  });

  test("service.namespace picks the namespace; a package the token has no grant on is rejected", async () => {
    await seedOwner("alice", [{ slug: "tool" }]);
    const bob = await seedOwner("bob", [{ slug: "tool" }]);
    const pat = await token(bob, { all: "read" });

    const res = await report("metrics", metricsBody({ ...HOST, "service.namespace": "alice" }), bearer(pat));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ partialSuccess: { rejectedDataPoints: "2" } });
    expect(await db.select().from(registryInstances).all()).toEqual([]);

    expect(await (await report("metrics", metricsBody({ ...HOST, "service.namespace": "bob" }), bearer(pat))).json()).toEqual({});
  });

  test("unknown packages and resources without an instance id are rejected, the rest stored", async () => {
    const alice = await seedOwner("alice", [{ slug: "tool" }]);
    const pat = await token(alice, { all: "read" });
    const body = metricsBody(HOST);
    body.resourceMetrics.push(...metricsBody({ ...HOST, "service.name": "nope" }).resourceMetrics);
    const { "service.instance.id": _id, "host.name": _host, ...anonymous } = HOST;
    body.resourceMetrics.push(...metricsBody(anonymous).resourceMetrics);

    const res = await report("metrics", body, bearer(pat));
    expect(await res.json()).toMatchObject({ partialSuccess: { rejectedDataPoints: "4" } });
    expect((await db.select().from(registryInstances).all()).map(r => r.instanceId)).toEqual(["web-01"]);
  });

  test("a public package still needs a token", async () => {
    await seedOwner("alice", [{ slug: "tool", visibility: "public" }]);
    expect((await report("metrics", metricsBody(HOST))).status).toBe(401);
    expect((await report("metrics", metricsBody(HOST), bearer("pat_unknown"))).status).toBe(401);
  });

  test("past REGISTRY_OBSERVE_MAX_INSTANCES new instances are rejected; known ones still refresh", async () => {
    const alice = await seedOwner("alice", [{ slug: "tool" }]);
    const pat = await token(alice, { all: "read" });
    const cap = { REGISTRY_OBSERVE_MAX_INSTANCES: 1 };
    expect(await (await report("metrics", metricsBody(HOST), bearer(pat), cap)).json()).toEqual({});
    expect(await (await report("metrics", metricsBody({ ...HOST, "service.instance.id": "web-02" }), bearer(pat), cap)).json())
      .toMatchObject({ partialSuccess: { rejectedDataPoints: "2" } });
    expect(await (await report("metrics", metricsBody(HOST), bearer(pat), cap)).json()).toEqual({});
  });

  test("logs become events, newest first, at most 100 per resource", async () => {
    const alice = await seedOwner("alice", [{ slug: "tool" }]);
    const pat = await token(alice, { all: "read" });

    expect(await (await report("logs", logsBody(HOST, ["lode.started", "lode.updated"]), bearer(pat))).json()).toEqual({});
    const res = await alice.call("GET", "/packages/alice/tool/events");
    const events = ((await res.json()) as { data: { name: string; instance_id: string; version: string; at: string }[] }).data;
    expect(events.map(e => e.name)).toEqual(["lode.updated", "lode.started"]);
    expect(events[0]).toMatchObject({ instance_id: "web-01", version: "1.5.0", at: "2026-10-22T12:00:01.000Z" });

    const many = Array.from({ length: 105 }, (_, i) => `e${i}`);
    expect(await (await report("logs", logsBody(HOST, many), bearer(pat))).json()).toMatchObject({ partialSuccess: { rejectedLogRecords: "5" } });
    expect(await db.select().from(registryInstanceEvents).all()).toHaveLength(102);

    const page = await alice.call("GET", `/packages/alice/tool/events?before=${encodeURIComponent("2026-10-22T12:00:01.000Z")}`);
    expect(((await page.json()) as { data: { name: string }[] }).data.map(e => e.name).sort()).toEqual(["e0", "lode.started"]);
  });

  test("gzip bodies are read; protobuf, unknown encodings and oversize bodies are refused", async () => {
    const alice = await seedOwner("alice", [{ slug: "tool" }]);
    const pat = await token(alice, { all: "read" });
    const zipped = await app().request("/r/otlp/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", ...bearer(pat) },
      body: gzipSync(JSON.stringify(metricsBody(HOST))),
    });
    expect(zipped.status).toBe(200);
    expect(await db.select().from(registryInstances).all()).toHaveLength(1);

    expect((await report("metrics", metricsBody(HOST), { "Content-Type": "application/x-protobuf", ...bearer(pat) })).status).toBe(415);
    expect((await report("metrics", metricsBody(HOST), { "Content-Encoding": "br", ...bearer(pat) })).status).toBe(415);
    const big = { resourceMetrics: [], pad: "x".repeat(1024 * 1024) };
    expect((await report("metrics", big, bearer(pat))).status).toBe(413);
    const bad = await app().request("/r/otlp/v1/metrics", { method: "POST", headers: { "Content-Type": "application/json", ...bearer(pat) }, body: "{" });
    expect(bad.status).toBe(400);
  });

  test("another user cannot read a private package's instances", async () => {
    await seedOwner("alice", [{ slug: "tool", visibility: "private" }]);
    const bob = await seedOwner("bob", []);
    expect((await bob.call("GET", "/packages/alice/tool/instances")).status).toBe(404);
  });
});

describe("pruneObservations", () => {
  test("drops events and silent instances past the retention, keeps the rest", async () => {
    const alice = await seedOwner("alice", [{ slug: "tool" }]);
    const pat = await token(alice, { all: "read" });
    await report("metrics", metricsBody(HOST), bearer(pat));
    await report("logs", logsBody(HOST, ["lode.started"]), bearer(pat));

    expect(await pruneObservations(db, 0)).toBe(0);
    expect(await pruneObservations(db, 30, Date.UTC(2026, 9, 25))).toBe(0);
    // The event is from 2026-10-22; the instance was seen now.
    const later = Date.now() + 40 * 24 * 60 * 60 * 1000;
    expect(await pruneObservations(db, 30, later)).toBe(2);
    expect(await db.select().from(registryInstances).all()).toEqual([]);
  });
});
