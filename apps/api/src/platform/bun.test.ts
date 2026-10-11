import { describe, expect, test } from "bun:test";
import { createBunPlatform } from "./bun";

describe("bun platform: kv", () => {
  test("namespaces are isolated; TTL, size and evictOldest behave", async () => {
    const { kv } = createBunPlatform();
    const a = kv.namespace("a");
    const b = kv.namespace("b");
    await a.set("1", { count: 1, resetAt: 10 });
    await a.set("2", { count: 2, resetAt: 5 }, 30);
    await b.set("1", { count: 9, resetAt: 1 });
    expect(await a.get<{ count: number; resetAt: number }>("1")).toEqual({ count: 1, resetAt: 10 });
    expect(await a.size()).toBe(2);
    expect(await kv.namespace("a").size()).toBe(2);
    await new Promise(r => setTimeout(r, 40));
    expect(await a.get("2")).toBeUndefined();
    expect(await a.size()).toBe(1);
    expect(await a.evictOldest("resetAt")).toBe(true);
    expect(await a.size()).toBe(0);
    expect(await b.size()).toBe(1);
    await a.delete("missing");
    await b.clear();
    expect(await b.size()).toBe(0);
    expect(await b.evictOldest("resetAt")).toBe(false);
  });
});

describe("bun platform: scheduler", () => {
  test("runs after the delay, never overlaps, and stop drains the in-flight run", async () => {
    const { scheduler } = createBunPlatform();
    let runs = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const h = scheduler.every("t", { delayMs: 5, intervalMs: 5 }, async () => {
      runs++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 25));
      concurrent--;
    });
    await new Promise(r => setTimeout(r, 60));
    await h.stop();
    const after = runs;
    await new Promise(r => setTimeout(r, 30));
    expect(runs).toBe(after);
    expect(maxConcurrent).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  test("stop before the first run cancels it", async () => {
    const { scheduler } = createBunPlatform();
    let runs = 0;
    const h = scheduler.every("t", { delayMs: 50, intervalMs: 50 }, async () => {
      runs++;
    });
    await h.stop();
    await new Promise(r => setTimeout(r, 70));
    expect(runs).toBe(0);
  });
});

describe("bun platform: env + capabilities", () => {
  test("reads Bun.env and reports the Bun capability set", () => {
    const p = createBunPlatform();
    expect(p.name).toBe("bun");
    expect(p.env.get("PATH")).toBe(Bun.env.PATH);
    expect(p.capabilities).toEqual({
      encryptionAtRest: true,
      argon2: true,
      pbkdf2MaxIterations: Number.POSITIVE_INFINITY,
      subprocess: true,
      filesystem: true,
      residentTimers: true,
    });
  });
});
