import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { __resetRateLimitForTests, consumeRateLimit, rateLimit } from "./rate-limit";

beforeEach(() => __resetRateLimitForTests());
afterEach(() => __resetRateLimitForTests());

function buildApp(opts: { windowMs: number; max: number; bucket: string }, trustProxy = true) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("config", { TRUST_PROXY: trustProxy } as unknown as AppEnv["Variables"]["config"]);
    await next();
  });
  app.use("*", rateLimit(opts));
  app.get("/p", c => c.json({ ok: true }));
  return app;
}

describe("rateLimit", () => {
  test("first hit creates the bucket and passes", async () => {
    const app = buildApp({ windowMs: 60_000, max: 3, bucket: "t1" });
    const res = await app.request("/p");
    expect(res.status).toBe(200);
  });

  test("returns 429 RATE_LIMITED on the (max+1)th hit within the window", async () => {
    const app = buildApp({ windowMs: 60_000, max: 2, bucket: "t2" });
    expect((await app.request("/p")).status).toBe(200);
    expect((await app.request("/p")).status).toBe(200);
    const limited = await app.request("/p");
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });

  test("expired window allows fresh requests again", async () => {
    const app = buildApp({ windowMs: 1, max: 1, bucket: "t3" });
    expect((await app.request("/p")).status).toBe(200);
    // Wait for the 1ms window to elapse.
    await Bun.sleep(10);
    expect((await app.request("/p")).status).toBe(200);
  });

  test("buckets are isolated by name", async () => {
    const a = buildApp({ windowMs: 60_000, max: 1, bucket: "iso-a" });
    const b = buildApp({ windowMs: 60_000, max: 1, bucket: "iso-b" });
    expect((await a.request("/p")).status).toBe(200);
    // a's anon bucket is exhausted; b's anon bucket is fresh.
    expect((await a.request("/p")).status).toBe(429);
    expect((await b.request("/p")).status).toBe(200);
  });

  test("uses x-real-ip header to separate callers when TRUST_PROXY=true (anon fallback shares one bucket)", async () => {
    const app = buildApp({ windowMs: 60_000, max: 1, bucket: "iso-ip" }, true);
    expect((await app.request("/p", { headers: { "x-real-ip": "1.1.1.1" } })).status).toBe(200);
    expect((await app.request("/p", { headers: { "x-real-ip": "2.2.2.2" } })).status).toBe(200);
    expect((await app.request("/p", { headers: { "x-real-ip": "1.1.1.1" } })).status).toBe(429);
  });

  test("ignores x-real-ip when TRUST_PROXY=false; all attackers share the anon bucket", async () => {
    const app = buildApp({ windowMs: 60_000, max: 1, bucket: "iso-ip-locked" }, false);
    expect((await app.request("/p", { headers: { "x-real-ip": "1.1.1.1" } })).status).toBe(200);
    // Spoofed header must NOT split buckets when proxy is untrusted.
    expect((await app.request("/p", { headers: { "x-real-ip": "2.2.2.2" } })).status).toBe(429);
  });

  test("triggers the size-based GC sweep on the 201st bucket key", async () => {
    const app = buildApp({ windowMs: 1, max: 100, bucket: "gc" });
    // Burn 200 distinct keys. The 201st write triggers the prune; we just
    // assert the middleware keeps working after.
    for (let i = 0; i < 201; i++)
      await app.request("/p", { headers: { "x-real-ip": `10.0.${Math.floor(i / 256)}.${i % 256}` } });
    const res = await app.request("/p", { headers: { "x-real-ip": "10.99.99.99" } });
    expect(res.status).toBe(200);
  });
});

describe("consumeRateLimit", () => {
  // The shared counter behind both `rateLimit()` and the auth / encryption
  // route guards, so its semantics are pinned here rather than three times.
  const opts = { bucket: "shared", key: "1.2.3.4", windowMs: 60_000, max: 2 };

  test("returns 0 while under the cap, then seconds until reset", async () => {
    expect(await consumeRateLimit(opts)).toBe(0);
    expect(await consumeRateLimit(opts)).toBe(0);
    const retryAfter = await consumeRateLimit(opts);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  test("a caller at the cap is not counted again, so the window cannot be pushed out", async () => {
    for (let i = 0; i < 2; i++)
      await consumeRateLimit(opts);
    const first = await consumeRateLimit(opts);
    await Bun.sleep(1100);
    const later = await consumeRateLimit(opts);
    expect(later).toBeLessThan(first);
  });

  test("keys and buckets are independent", async () => {
    for (let i = 0; i < 3; i++)
      await consumeRateLimit(opts);
    expect(await consumeRateLimit({ ...opts, key: "5.6.7.8" })).toBe(0);
    expect(await consumeRateLimit({ ...opts, bucket: "other" })).toBe(0);
  });

  test("an elapsed window starts a fresh count", async () => {
    const short = { ...opts, windowMs: 1, max: 1 };
    expect(await consumeRateLimit(short)).toBe(0);
    await Bun.sleep(10);
    expect(await consumeRateLimit(short)).toBe(0);
  });
});
