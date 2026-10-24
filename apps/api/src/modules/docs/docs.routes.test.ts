import type { Config } from "@/config";
import type { AppEnv } from "@/shared/lib/types";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { auditRoutes } from "@/modules/audit";
import { systemRoutes } from "@/modules/system";
import { rawRoutes } from "@/routes/raw";
import { SECURITY } from "@/shared/lib/openapi";
import { DOCS_VIEWER, mountDocs } from "./docs.routes";

const cfg = { BASE_PATH: "", APP_NAME: "app" } as unknown as Config;

function buildApp(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.use("*", (c, next) => {
    c.set("config", cfg);
    return next();
  });
  // Mounted before the route modules — mirrors app.ts so the docs routes
  // stay outside each module's `use("*")` auth guards.
  mountDocs(api, cfg);
  api.route("/", systemRoutes());
  api.route("/", auditRoutes());
  return api;
}

describe("docs module", () => {
  it("serves an OpenAPI 3.1 spec at /openapi.json", async () => {
    const res = await buildApp().request("/openapi.json");
    expect(res.status).toBe(200);

    const spec = await res.json() as {
      openapi: string;
      info: { title: string };
      paths: Record<string, Record<string, { tags?: string[]; parameters?: { name: string }[] }>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };

    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("app API");
    expect(Object.keys(spec.paths)).toContain("/health");
    expect(Object.keys(spec.paths)).toContain("/audit");
    // Every scheme a route can declare (the SECURITY presets) is defined,
    // and nothing is defined that no preset uses.
    const used = new Set(Object.values(SECURITY).flatMap(reqs => reqs.flatMap(r => Object.keys(r))));
    expect(Object.keys(spec.components?.securitySchemes ?? {}).toSorted()).toEqual([...used].toSorted());
  });

  it("defines every security scheme a documented route requires", async () => {
    const spec = await (await buildApp().request("/openapi.json")).json() as {
      paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    const defined = new Set(Object.keys(spec.components?.securitySchemes ?? {}));
    const required = Object.values(spec.paths)
      .flatMap(ops => Object.values(ops))
      .flatMap(op => (op.security ?? []).flatMap(r => Object.keys(r)));
    expect(required.length).toBeGreaterThan(0);
    expect(required.filter(name => !defined.has(name))).toEqual([]);
  });

  it("documents validated request params in the spec", async () => {
    const spec = await (await buildApp().request("/openapi.json")).json() as {
      paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
    };
    // `GET /audit` validates its query with `validator("query", ...)`, so the
    // query fields must surface as OpenAPI parameters.
    const params = (spec.paths["/audit"]?.get?.parameters ?? []).map(p => p.name);
    expect(params).toContain("page");
    expect(params).toContain("limit");
  });

  it("documents every route it walks (no untagged operations)", async () => {
    const spec = await (await buildApp().request("/openapi.json")).json() as {
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    const untagged: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!op.tags || op.tags.length === 0) {
          untagged.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(untagged).toEqual([]);
  });

  it("sends /docs to the external viewer with the spec's absolute URL", async () => {
    const res = await buildApp().request("http://localhost:3000/docs");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${DOCS_VIEWER}${encodeURIComponent("http://localhost:3000/api/openapi.json")}`);
  });

  it("builds the spec URL from APP_URL and BASE_PATH when set", async () => {
    const config = { BASE_PATH: "/u", APP_NAME: "app", APP_URL: "https://app.example.eu/" } as unknown as Config;
    const api = new Hono<AppEnv>();
    mountDocs(api, config);
    const res = await api.request("http://10.0.0.5:3000/docs");
    expect(res.headers.get("location")).toBe(`${DOCS_VIEWER}${encodeURIComponent("https://app.example.eu/u/api/openapi.json")}`);
  });

  it("lets any origin read the spec, since the viewer fetches it cross-origin", async () => {
    const res = await buildApp().request("/openapi.json", {
      headers: { Origin: "https://client.scalar.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("is not gated by module auth (public docs)", async () => {
    // `/audit` requires auth; the docs routes, mounted first, must not.
    const app = buildApp();
    expect((await app.request("/openapi.json")).status).toBe(200);
    expect((await app.request("/docs")).status).toBe(302);
  });
});

describe("docs module — the raw API", () => {
  function buildWithRaw(): Hono<AppEnv> {
    const api = new Hono<AppEnv>();
    api.use("*", (c, next) => {
      c.set("config", cfg);
      return next();
    });
    // The raw API is mounted on the outer app, not on `api`, so the spec
    // only sees it when handed the raw routes.
    mountDocs(api, cfg, {
      raw: rawRoutes(),
    });
    api.route("/", systemRoutes());
    return api;
  }

  it("includes raw API routes, under /raw", async () => {
    const spec = await (await buildWithRaw().request("/openapi.json")).json() as {
      paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>>;
    };
    const op = spec.paths["/raw/health"]?.get;
    expect(op).toBeDefined();
    expect(op?.tags).toEqual(["Raw"]);
    // Still documents the rest of /api alongside it.
    expect(Object.keys(spec.paths)).toContain("/health");
  });

  it("does not describe raw routes as session-authenticated", async () => {
    const spec = await (await buildWithRaw().request("/openapi.json")).json() as {
      paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>>;
    };
    const security = spec.paths["/raw/health"]?.get?.security ?? [];
    expect(security.some(s => "sessionCookie" in s)).toBe(false);
  });

  it("sees routes mounted after the docs, as it does for /api", async () => {
    // The spec is built on first request, so routes registered after
    // mountDocs are included — the same contract `api` already relies on.
    const api = new Hono<AppEnv>();
    const raw = new Hono<AppEnv>();
    mountDocs(api, cfg, { raw });
    raw.get("/late", describeRoute({
      tags: ["Raw"],
      summary: "Late",
      responses: {
        200: { description: "ok" },
      },
    }), c => c.text("ok"));
    const spec = await (await api.request("/openapi.json")).json() as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toContain("/raw/late");
  });
});
