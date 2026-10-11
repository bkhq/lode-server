import type { AppDeps } from "./app";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { __resetRateLimitForTests } from "@/shared/middleware/rate-limit";
import { buildOuterApp, buildRawApp } from "./app";

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

function config(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: "test",
    TRUST_PROXY: false,
    BASE_PATH: "",
    APP_URL: "https://app.example.test",
    RAW_API_RATE_LIMIT_PER_MINUTE: 100,
    ...overrides,
  } as unknown as Config;
}

function deps(cfg: Config): AppDeps {
  return {
    config: cfg,
    // No route under test touches the database.
    db: {} as AppDatabase,
    logger: noop,
    encryption: { isSystemLocked: () => false } as unknown as AppDeps["encryption"],
  };
}

/**
 * A stand-in `/api` sub-app with a guard that refuses everything, the way
 * the real one's CSRF, session and policy middleware refuse a caller that is
 * not a browser session. If it ever runs on a raw path, the raw tests fail.
 */
function guardedApi(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.use("*", async (c) => {
    c.header("x-api-stack", "ran");
    return c.json({ success: false, error: { code: "CSRF_REJECTED" } }, 403);
  });
  api.get("/ping", c => c.json({ ok: true }));
  return api;
}

function openApi(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.get("/ping", c => c.json({ ok: true }));
  return api;
}

function buildApp(cfg: Config, options: { api?: Hono<AppEnv>; routes?: Hono<AppEnv> } = {}) {
  const raw = options.routes ? buildRawApp(deps(cfg), options.routes) : buildRawApp(deps(cfg));
  return buildOuterApp(options.api ?? openApi(), cfg, raw);
}

const BROWSER_SECURITY_HEADERS = [
  "content-security-policy",
  "x-frame-options",
  "cross-origin-resource-policy",
  "cross-origin-opener-policy",
  "strict-transport-security",
  "x-content-type-options",
  "referrer-policy",
];

beforeEach(async () => {
  await __resetRateLimitForTests();
});

describe("raw API — isolation from the /api stack", () => {
  test("the /api sub-app's middleware never runs on a raw path", async () => {
    // The raw API shares the /api prefix. It is mounted first, so its
    // response ends the chain before anything the /api sub-app registered.
    const app = buildApp(config(), { api: guardedApi() });
    const res = await app.request("/api/raw/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-api-stack")).toBeNull();
  });

  test("an unknown raw path is answered by the raw API, not the /api stack", async () => {
    const app = buildApp(config(), { api: guardedApi() });
    const res = await app.request("/api/raw/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("x-api-stack")).toBeNull();
  });

  test("the /api stack still guards everything else under /api", async () => {
    const app = buildApp(config(), { api: guardedApi() });
    const res = await app.request("/api/ping");
    expect(res.status).toBe(403);
    expect(res.headers.get("x-api-stack")).toBe("ran");
  });

  test("a state-changing request needs no CSRF headers", async () => {
    const routes = new Hono<AppEnv>();
    routes.post("/echo", async c => c.json({ got: await c.req.json() }));
    // No Origin, no X-Requested-With: the /api guard would refuse this.
    const res = await buildApp(config(), { api: guardedApi(), routes }).request("/api/raw/echo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { hello: "world" } });
  });
});

describe("raw API — headers", () => {
  test("carries none of the browser security headers", async () => {
    const res = await buildApp(config()).request("/api/raw/health");
    expect(res.status).toBe(200);
    for (const header of BROWSER_SECURITY_HEADERS)
      expect(res.headers.get(header)).toBeNull();
  });

  test("the rest of /api keeps them — the exemption is scoped", async () => {
    const res = await buildApp(config()).request("/api/ping");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).not.toBeNull();
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  test("a path that only starts with the prefix is not exempt", async () => {
    const res = await buildApp(config()).request("/api/rawx");
    expect(res.headers.get("content-security-policy")).not.toBeNull();
  });

  test("the prefix follows BASE_PATH", async () => {
    const res = await buildApp(config({ BASE_PATH: "/app" })).request("/app/api/raw/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  test("without a mounted raw API the prefix gets the normal headers", async () => {
    // A locked deployment has no raw API. The prefix must not become an
    // unprotected hole into whatever answers it instead.
    const res = await buildOuterApp(openApi(), config()).request("/api/raw/health");
    expect(res.headers.get("content-security-policy")).not.toBeNull();
  });
});

describe("raw API — rate limiting", () => {
  test("refuses a client past the per-minute cap, with Retry-After", async () => {
    const app = buildApp(config({ RAW_API_RATE_LIMIT_PER_MINUTE: 2 }));
    expect((await app.request("/api/raw/health")).status).toBe(200);
    expect((await app.request("/api/raw/health")).status).toBe(200);

    const limited = await app.request("/api/raw/health");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });

  test("unknown paths spend the same budget", async () => {
    const app = buildApp(config({ RAW_API_RATE_LIMIT_PER_MINUTE: 1 }));
    expect((await app.request("/api/raw/does-not-exist")).status).toBe(404);
    expect((await app.request("/api/raw/health")).status).toBe(429);
  });

  test("a cap of 0 turns it off", async () => {
    const app = buildApp(config({ RAW_API_RATE_LIMIT_PER_MINUTE: 0 }));
    for (let i = 0; i < 5; i++)
      expect((await app.request("/api/raw/health")).status).toBe(200);
  });

  test("does not share its budget with the rest of /api", async () => {
    const app = buildApp(config({ RAW_API_RATE_LIMIT_PER_MINUTE: 1 }));
    expect((await app.request("/api/raw/health")).status).toBe(200);
    expect((await app.request("/api/raw/health")).status).toBe(429);
    expect((await app.request("/api/ping")).status).toBe(200);
  });
});

describe("raw API — plumbing", () => {
  test("an unknown path answers JSON 404", async () => {
    const res = await buildApp(config()).request("/api/raw/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  test("echoes a request id to correlate with", async () => {
    const res = await buildApp(config()).request("/api/raw/health");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("a failing route answers the JSON error shape", async () => {
    const routes = new Hono<AppEnv>();
    routes.get("/boom", () => {
      throw new Error("kaboom");
    });
    const res = await buildApp(config(), { routes }).request("/api/raw/boom");
    expect(res.status).toBe(500);
    expect((await res.json() as { success: boolean }).success).toBe(false);
  });
});
