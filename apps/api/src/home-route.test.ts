import type { Handler } from "hono";
import type { Config } from "@/config";
import type { AppEnv } from "@/shared/lib/types";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { buildOuterApp } from "./app";

function config(basePath: string, homePage: "off" | "base" | "root"): Config {
  return {
    NODE_ENV: "test",
    TRUST_PROXY: false,
    BASE_PATH: basePath,
    HOME_PAGE: homePage,
    APP_URL: "https://app.example.test",
  } as unknown as Config;
}

// Stands in for the static handler so the test needs no built SPA: what
// matters is which paths reach it.
const spa: Handler = c => c.html("<!doctype html><title>spa</title>");

function build(basePath: string, homePage: "off" | "base" | "root") {
  const api = new Hono<AppEnv>();
  api.get("/ping", c => c.json({ ok: true }));
  return buildOuterApp(api, config(basePath, homePage), undefined, spa);
}

async function isSpa(res: Response): Promise<boolean> {
  return res.status === 200 && (await res.text()).includes("<title>spa</title>");
}

describe("the / route and BASE_PATH", () => {
  test("with a BASE_PATH, / still sends the visitor to the app unless the home page is at the root", async () => {
    for (const mode of ["off", "base"] as const) {
      const res = await build("/app", mode).request("/");
      expect(await res.text()).toContain("url=/app/");
    }
  });

  test("with a BASE_PATH and HOME_PAGE=root, / is the SPA, outside the prefix", async () => {
    expect(await isSpa(await build("/app", "root").request("/"))).toBe(true);
  });

  test("the SPA stays under the prefix in every mode, and nothing else leaves it", async () => {
    for (const mode of ["off", "base", "root"] as const) {
      const app = build("/app", mode);
      expect(await isSpa(await app.request("/app/"))).toBe(true);
      expect(await isSpa(await app.request("/app/overview"))).toBe(true);
      expect((await app.request("/overview")).status).toBe(404);
    }
  });

  test("without a BASE_PATH, / is the SPA", async () => {
    for (const mode of ["off", "base", "root"] as const)
      expect(await isSpa(await build("", mode).request("/"))).toBe(true);
  });

  test("/home is not a route", async () => {
    expect((await build("/app", "root").request("/home")).status).toBe(404);
  });
});
