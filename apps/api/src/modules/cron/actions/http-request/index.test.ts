import type { ActionContext } from "../types";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import httpRequestAction from ".";
import { __resetActionRegistryForTests, registerAction, validateActionConfig } from "../registry";

beforeAll(() => {
  __resetActionRegistryForTests();
  registerAction(httpRequestAction);
});

const fakeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
  reopen: () => {},
} as unknown as ActionContext["logger"];

// Tests use loopback URLs (`http://127.0.0.1:<port>/...`); the SSRF gate
// would reject them by default. Opt in for the test ctx.
const fakeConfig = {
  HTTP_ACTION_ALLOW_PRIVATE: true,
  HTTP_ACTION_TIMEOUT_SECONDS: 30,
  SHELL_ACTION_TIMEOUT_SECONDS: 300,
} as unknown as ActionContext["config"];

const ctx: ActionContext = {
  db: null as unknown as ActionContext["db"],
  logger: fakeLogger,
  config: fakeConfig,
};

const run = (cfg: Record<string, unknown>) => httpRequestAction.execute(ctx, cfg);
function validate(cfg: Record<string, unknown>) {
  return validateActionConfig("http-request", { ...cfg, action: "http-request" });
}

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/ok":
          return new Response("alive", { status: 200 });
        case "/notfound":
          return new Response("nope", { status: 404 });
        case "/teapot":
          return new Response("brew", { status: 418 });
        case "/echo":
          return new Response(`method=${req.method}`, { status: 200 });
        case "/slow":
          return new Promise((resolve) => {
            setTimeout(() => resolve(new Response("eventually", { status: 200 })), 500);
          });
        case "/redirect-private":
          return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/latest/meta-data/" } });
        case "/big":
          return new Response("x".repeat(4 * 1024 * 1024), { status: 200 });
        case "/big-404":
          return new Response("y".repeat(4 * 1024 * 1024), { status: 404 });
        default:
          return new Response("?", { status: 200 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("http-request validate (via inputs[] + custom hook)", () => {
  test("rejects missing url (required input)", async () => {
    expect(await validate({})).toMatch(/config\.url is required/);
  });

  test("rejects non-http schemes (custom validate)", async () => {
    expect(await validate({ url: "file:///etc/passwd" })).toMatch(/must use http or https/);
    expect(await validate({ url: "ftp://example.com" })).toMatch(/must use http or https/);
  });

  test("rejects malformed url (custom validate)", async () => {
    expect(await validate({ url: "not a url" })).toMatch(/not a valid URL/);
  });

  test("rejects unknown method (select enum)", async () => {
    expect(await validate({ url: "https://x", method: "FOO" })).toMatch(/method must be one of/);
  });

  test("rejects timeout out of range (number bounds)", async () => {
    expect(await validate({ url: "https://x", timeoutMs: 0 })).toMatch(/timeoutMs must be >= 100/);
    expect(await validate({ url: "https://x", timeoutMs: 999_999 })).toMatch(/timeoutMs must be <= 60000/);
  });

  test("rejects expectStatus outside 100..599", async () => {
    expect(await validate({ url: "https://x", expectStatus: 42 })).toMatch(/expectStatus must be >= 100/);
    expect(await validate({ url: "https://x", expectStatus: 1000 })).toMatch(/expectStatus must be <= 599/);
  });

  test("rejects non-object headers", async () => {
    expect(await validate({ url: "https://x", headers: "no" })).toMatch(/headers must be a JSON object/);
    expect(await validate({ url: "https://x", headers: ["a"] })).toMatch(/headers must be a JSON object/);
  });

  test("accepts well-formed config", async () => {
    expect(await validate({
      url: "https://example.com/health",
      method: "POST",
      headers: { Authorization: "Bearer xyz" },
      body: "{}",
      timeoutMs: 5000,
      expectStatus: 204,
    })).toBeNull();
  });
});

describe("runHttpRequest", () => {
  test("default expects 2xx — 200 → success", async () => {
    const result = await run({ url: `${base}/ok` });
    expect(result).toMatch(/GET .*\/ok → 200/);
  });

  test("default expects 2xx — 404 → throws", async () => {
    expect(run({ url: `${base}/notfound` })).rejects.toThrow(/→ 404/);
  });

  test("explicit expectStatus matches a non-2xx response", async () => {
    const result = await run({ url: `${base}/teapot`, expectStatus: 418 });
    expect(result).toMatch(/→ 418/);
  });

  test("explicit expectStatus mismatch throws even on 2xx", async () => {
    expect(run({ url: `${base}/ok`, expectStatus: 204 })).rejects.toThrow(/expected 204/);
  });

  test("uppercases lowercase method input", async () => {
    const result = await run({ url: `${base}/echo`, method: "post" });
    expect(result).toMatch(/POST .*\/echo → 200/);
  });

  test("timeout aborts the request and throws", async () => {
    expect(run({ url: `${base}/slow`, timeoutMs: 100 })).rejects.toThrow(/failed/);
  });

  test("unreachable host produces a thrown error, not an unhandled rejection", async () => {
    expect(run({ url: "http://127.0.0.1:1/" })).rejects.toThrow(/failed/);
  });

  test("a redirect is reported, never followed — the DNS pin would not cover the second hop", async () => {
    expect(run({ url: `${base}/redirect-private` })).rejects.toThrow(/302 redirect to http:\/\/10\.0\.0\.1.*not followed/);
  });

  test("a large body is read only up to the cap", async () => {
    const result = await run({ url: `${base}/big` });
    expect(result).toMatch(/→ 200/);
  });

  test("a large error body is truncated in the thrown message", async () => {
    let msg = "";
    try {
      await run({ url: `${base}/big-404` });
    }
    catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/→ 404/);
    expect(msg).toContain("…(truncated)");
    expect(msg.length).toBeLessThan(4096);
  });
});

describe("runHttpRequest — SSRF gate", () => {
  const restrictedConfig = {
    HTTP_ACTION_ALLOW_PRIVATE: false,
    HTTP_ACTION_TIMEOUT_SECONDS: 30,
    SHELL_ACTION_TIMEOUT_SECONDS: 300,
  } as unknown as ActionContext["config"];
  const restrictedCtx: ActionContext = {
    db: null as unknown as ActionContext["db"],
    logger: fakeLogger,
    config: restrictedConfig,
  };
  const restrictedRun = (cfg: Record<string, unknown>) => httpRequestAction.execute(restrictedCtx, cfg);

  test.each([
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://localhost/",
    "http://[::1]/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
  ])("rejects private destination %s", async (url) => {
    expect(restrictedRun({ url })).rejects.toThrow(/refused private destination/);
  });

  test("rejects non-http/https protocols", async () => {
    expect(restrictedRun({ url: "file:///etc/passwd" })).rejects.toThrow(/unsupported protocol/);
  });

  test("rejects invalid URL", async () => {
    expect(restrictedRun({ url: "not a url" })).rejects.toThrow(/invalid URL/);
  });

  test("isPrivateDestination is the gate's surface — public hostnames not flagged", async () => {
    const { isPrivateDestination } = await import("./executor");
    expect(isPrivateDestination("example.com")).toBe(false);
    expect(isPrivateDestination("8.8.8.8")).toBe(false);
    expect(isPrivateDestination("198.51.100.1")).toBe(false);
    expect(isPrivateDestination("127.0.0.1")).toBe(true);
    expect(isPrivateDestination("10.255.255.255")).toBe(true);
    expect(isPrivateDestination("172.16.0.1")).toBe(true);
    expect(isPrivateDestination("172.31.255.255")).toBe(true);
    expect(isPrivateDestination("172.32.0.1")).toBe(false);
    // 0.0.0.0/8 — 0.x.x.x routes to loopback on Linux
    expect(isPrivateDestination("0.0.0.0")).toBe(true);
    expect(isPrivateDestination("0.1.2.3")).toBe(true);
    // 100.64.0.0/10 — RFC 6598 CGNAT (cloud internal / metadata adjacency)
    expect(isPrivateDestination("100.64.0.1")).toBe(true);
    expect(isPrivateDestination("100.127.255.255")).toBe(true);
    expect(isPrivateDestination("100.63.255.255")).toBe(false);
    expect(isPrivateDestination("100.128.0.1")).toBe(false);
    expect(isPrivateDestination("[::1]")).toBe(true);
    expect(isPrivateDestination("[::]")).toBe(true);
    expect(isPrivateDestination("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateDestination("[::ffff:7f00:1]")).toBe(true);
    expect(isPrivateDestination("::ffff:0808:0808")).toBe(false);
    expect(isPrivateDestination("fc00::1")).toBe(true);
    expect(isPrivateDestination("fd00::1")).toBe(true);
    expect(isPrivateDestination("fe80::1")).toBe(true);
    expect(isPrivateDestination("febf::1")).toBe(true);
    expect(isPrivateDestination("2001:db8::1")).toBe(false);
  });

  test("HTTP_ACTION_ALLOW_PRIVATE=true bypass works (the ctx used above)", async () => {
    const result = await run({ url: `${base}/ok` });
    expect(result).toMatch(/→ 200/);
  });
});
