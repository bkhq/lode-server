import type { Config } from "@/config";
import type { AppEnv } from "@/shared/lib/types";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { csrfGuard } from "./csrf";

function buildApp(corsOrigin?: string, appUrl?: string) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("config", { CORS_ORIGIN: corsOrigin, APP_URL: appUrl } as Config);
    return next();
  });
  app.use("*", csrfGuard);
  app.all("/p", c => c.json({ ok: true }));
  return app;
}

describe("csrfGuard", () => {
  test("allows GET / HEAD / OPTIONS without X-Requested-With", async () => {
    const app = buildApp();
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = await app.request("/p", { method });
      expect(res.status).not.toBe(403);
    }
  });

  test("rejects POST when X-Requested-With is missing", async () => {
    const app = buildApp();
    const res = await app.request("/p", { method: "POST" });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("CSRF_REJECTED");
  });

  test("Bearer token bypasses the X-Requested-With requirement", async () => {
    const app = buildApp();
    const res = await app.request("/p", { method: "POST", headers: { Authorization: "Bearer x" } });
    expect(res.status).toBe(200);
  });

  test("non-Bearer Authorization (e.g. Basic) does NOT bypass — falls through to X-Requested-With", async () => {
    const app = buildApp();
    const res = await app.request("/p", { method: "POST", headers: { Authorization: "Basic xyz" } });
    expect(res.status).toBe(403);
  });

  test("with X-Requested-With and no CORS_ORIGIN / no APP_URL configured: passes (dev fallback)", async () => {
    const app = buildApp();
    const res = await app.request("/p", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" } });
    expect(res.status).toBe(200);
  });

  test("APP_URL fallback: rejects when Origin does not match APP_URL", async () => {
    const app = buildApp(undefined, "https://allowed.example.com");
    const res = await app.request("/p", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Origin": "https://attacker.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("APP_URL fallback: accepts matching Origin when CORS_ORIGIN is unset", async () => {
    const app = buildApp(undefined, "https://allowed.example.com");
    const res = await app.request("/p", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Origin": "https://allowed.example.com" },
    });
    expect(res.status).toBe(200);
  });

  test("APP_URL fallback: rejects when neither Origin nor Referer is present", async () => {
    const app = buildApp(undefined, "https://allowed.example.com");
    const res = await app.request("/p", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" } });
    expect(res.status).toBe(403);
  });

  test("CORS_ORIGIN takes precedence over APP_URL", async () => {
    const app = buildApp("https://cors.example.com", "https://access.example.com");
    const ok = await app.request("/p", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Origin": "https://cors.example.com" },
    });
    expect(ok.status).toBe(200);
    const rej = await app.request("/p", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Origin": "https://access.example.com" },
    });
    expect(rej.status).toBe(403);
  });

  test("with CORS_ORIGIN set: rejects when neither Origin nor Referer is present", async () => {
    const app = buildApp("https://allowed.example.com");
    const res = await app.request("/p", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest" } });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { message: string } }).error.message).toMatch(/Origin/);
  });

  test("with CORS_ORIGIN set: rejects mismatching Origin", async () => {
    const app = buildApp("https://allowed.example.com");
    const res = await app.request("/p", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Origin": "https://attacker.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("with CORS_ORIGIN set: accepts matching Origin", async () => {
    const app = buildApp("https://allowed.example.com");
    const res = await app.request("/p", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Origin": "https://allowed.example.com" },
    });
    expect(res.status).toBe(200);
  });

  test("with comma-separated CORS_ORIGIN: accepts any listed origin", async () => {
    const app = buildApp("https://a.example.com,https://b.example.com");
    const a = await app.request("/p", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Origin": "https://a.example.com" },
    });
    expect(a.status).toBe(200);
    const b = await app.request("/p", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Origin": "https://b.example.com" },
    });
    expect(b.status).toBe(200);
  });

  test("with comma-separated CORS_ORIGIN: rejects an unlisted origin", async () => {
    const app = buildApp("https://a.example.com,https://b.example.com");
    const res = await app.request("/p", {
      method: "POST",
      headers: { "X-Requested-With": "XMLHttpRequest", "Origin": "https://c.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("with CORS_ORIGIN set: accepts a Referer whose origin matches", async () => {
    const app = buildApp("https://allowed.example.com");
    const res = await app.request("/p", {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://allowed.example.com/some/page",
      },
    });
    expect(res.status).toBe(200);
  });
});
