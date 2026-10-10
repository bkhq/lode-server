import type { Handler } from "hono";
import type { Config } from "@/config";
import type { AppEnv } from "@/shared/lib/types";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { buildOuterApp } from "./app";

function config(basePath: string): Config {
  return { NODE_ENV: "test", TRUST_PROXY: false, BASE_PATH: basePath, APP_URL: "https://app.example.test" } as unknown as Config;
}

// Stands in for the static handler so the test needs no built SPA: what
// matters is which paths reach it.
const spa: Handler = c => c.html("<!doctype html><title>spa</title>");

function build(basePath: string) {
  const api = new Hono<AppEnv>();
  api.get("/ping", c => c.json({ ok: true }));
  return buildOuterApp(api, config(basePath), undefined, spa);
}

describe("SPA home page, independent of BASE_PATH", () => {
  test("is served at /home when BASE_PATH is set", async () => {
    const app = build("/app");
    for (const path of ["/home", "/home/"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>spa</title>");
    }
  });

  test("is served at /home when BASE_PATH is empty", async () => {
    expect((await build("").request("/home")).status).toBe(200);
  });

  test("the SPA is still served under BASE_PATH", async () => {
    expect((await build("/app").request("/app/overview")).status).toBe(200);
  });

  test("only /home itself is outside BASE_PATH", async () => {
    const app = build("/app");
    expect((await app.request("/home/anything")).status).toBe(404);
    expect((await app.request("/overview")).status).toBe(404);
  });

  test("carries the browser security headers", async () => {
    const res = await build("/app").request("/home");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});
