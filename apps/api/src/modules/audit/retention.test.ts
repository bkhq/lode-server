import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { auditEvents } from "@/modules/audit/schema";
import { pruneAuditEvents, startAuditRetentionSweep, stopAuditRetentionSweep } from "./retention";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "audit-retention-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertEventAt(id: string, createdAt: string) {
  return db.insert(auditEvents).values({
    id,
    actorId: nanoid(),
    actorName: "test",
    action: "test.action",
    resourceType: "test",
    resourceId: nanoid(),
    resourceName: "x",
    detail: null,
    ip: "127.0.0.1",
    userAgent: "test",
    result: "success",
    createdAt,
  }).run();
}

function silentLogger(): Logger & { calls: { level: string; ctx?: unknown; msg: string }[] } {
  const calls: { level: string; ctx?: unknown; msg: string }[] = [];
  const make = (level: string) => (ctxOrMsg: unknown, maybeMsg?: string) => {
    if (typeof ctxOrMsg === "string")
      calls.push({ level, msg: ctxOrMsg });
    else
      calls.push({ level, ctx: ctxOrMsg, msg: maybeMsg ?? "" });
  };
  return Object.assign({
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    fatal: make("fatal"),
    flush: () => {},
  }, { calls }) as unknown as Logger & { calls: typeof calls };
}

function makeConfig(retentionDays: number): Config {
  return { AUDIT_RETENTION_DAYS: retentionDays } as unknown as Config;
}

describe("pruneAuditEvents", () => {
  test("retentionDays = 0 keeps everything", async () => {
    const old = new Date(Date.now() - 90 * 86400_000).toISOString();
    const fresh = new Date().toISOString();
    await insertEventAt(nanoid(), old);
    await insertEventAt(nanoid(), fresh);

    const deleted = await pruneAuditEvents(db, 0);
    expect(deleted).toBe(0);

    const remaining = await db.select().from(auditEvents).all();
    expect(remaining.length).toBe(2);
  });

  test("retentionDays = 30 drops events older than 30 days", async () => {
    const veryOld = new Date(Date.now() - 90 * 86400_000).toISOString();
    const justOver = new Date(Date.now() - 31 * 86400_000).toISOString();
    const justUnder = new Date(Date.now() - 29 * 86400_000).toISOString();
    const fresh = new Date().toISOString();
    await insertEventAt(nanoid(), veryOld);
    await insertEventAt(nanoid(), justOver);
    await insertEventAt(nanoid(), justUnder);
    await insertEventAt(nanoid(), fresh);

    const deleted = await pruneAuditEvents(db, 30);
    expect(deleted).toBe(2);

    const remaining = await db.select().from(auditEvents).all();
    expect(remaining.length).toBe(2);
    for (const row of remaining) {
      expect(row.createdAt > justOver).toBe(true);
    }
  });
});

describe("startAuditRetentionSweep", () => {
  // Bun's test runner has no fake-timer suite, so monkey-patch
  // setTimeout / setInterval / clear* to capture the registered callbacks.
  // The captured callback can be invoked directly to assert sweep behaviour
  // without waiting 30s + 1 hour.
  //
  // The boot run is now scheduled via setTimeout(... 30_000) — capture only
  // that delay; pass other (smaller, internal-batch-pause) setTimeouts through
  // to the real implementation.
  let bootCaptured: { fn: () => void; ms: number } | null;
  let captured: { fn: () => void; ms: number } | null;
  let cleared: boolean;
  let originalSetTimeout: typeof setTimeout;
  let originalSetInterval: typeof setInterval;
  let originalClearTimeout: typeof clearTimeout;
  let originalClearInterval: typeof clearInterval;

  // Convenience: fire the boot setTimeout and drain microtasks so the
  // setInterval registration runs synchronously.
  async function fireBoot(): Promise<void> {
    if (!bootCaptured)
      return;
    const fn = bootCaptured.fn;
    bootCaptured = null;
    fn();
    await Bun.sleep(10);
  }

  beforeEach(() => {
    bootCaptured = null;
    captured = null;
    cleared = false;
    originalSetTimeout = globalThis.setTimeout;
    originalSetInterval = globalThis.setInterval;
    originalClearTimeout = globalThis.clearTimeout;
    originalClearInterval = globalThis.clearInterval;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number, ..._args: unknown[]) => {
      // 30_000 is the FIRST_SWEEP_DELAY_MS — capture and short-circuit.
      if (ms === 30_000) {
        const handle = { fn, ms } as { fn: () => void; ms: number; unref?: () => void };
        handle.unref = () => {};
        bootCaptured = handle;
        return handle as unknown as ReturnType<typeof setTimeout>;
      }
      // All other timeouts (e.g. inter-batch pause inside pruneAuditEvents)
      // delegate to the real implementation.
      return originalSetTimeout(fn, ms ?? 0);
    }) as typeof setTimeout;
    (globalThis as { setInterval: typeof setInterval }).setInterval = ((fn: () => void, ms: number) => {
      const handle = { fn, ms } as { fn: () => void; ms: number; unref?: () => void };
      handle.unref = () => {};
      captured = handle;
      return handle as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    (globalThis as { clearTimeout: typeof clearTimeout }).clearTimeout = ((_h?: unknown) => {
      bootCaptured = null;
    }) as typeof clearTimeout;
    (globalThis as { clearInterval: typeof clearInterval }).clearInterval = (() => {
      cleared = true;
    }) as typeof clearInterval;
  });

  afterEach(async () => {
    await stopAuditRetentionSweep();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.clearInterval = originalClearInterval;
  });

  test("AUDIT_RETENTION_DAYS = 0 → no timer, no boot run", async () => {
    await insertEventAt(nanoid(), new Date(Date.now() - 90 * 86400_000).toISOString());
    const log = silentLogger();

    startAuditRetentionSweep(db, makeConfig(0), log);
    await Bun.sleep(10);

    expect(bootCaptured).toBeNull();
    expect(captured).toBeNull();
    expect(log.calls.length).toBe(0);
    expect((await db.select().from(auditEvents).all()).length).toBe(1);
  });

  test("AUDIT_RETENTION_DAYS > 0 → defers boot run; firing it prunes and schedules the hourly sweep", async () => {
    await insertEventAt(nanoid(), new Date(Date.now() - 90 * 86400_000).toISOString());
    await insertEventAt(nanoid(), new Date().toISOString());
    const log = silentLogger();

    startAuditRetentionSweep(db, makeConfig(30), log);
    // Boot run is now deferred via setTimeout(... 30_000); not yet executed.
    await Bun.sleep(10);
    expect(bootCaptured?.ms).toBe(30_000);
    expect(captured).toBeNull();

    await fireBoot();

    expect((await db.select().from(auditEvents).all()).length).toBe(1);
    expect(captured?.ms).toBe(60 * 60 * 1000);
    expect(typeof captured?.fn).toBe("function");

    // info-level log when the sweep deleted >0 rows
    expect(log.calls.some(c => c.level === "info")).toBe(true);
  });

  test("starting twice is idempotent — only the first call schedules a timer", () => {
    const log = silentLogger();
    startAuditRetentionSweep(db, makeConfig(30), log);
    const firstBoot = bootCaptured;
    bootCaptured = null;

    startAuditRetentionSweep(db, makeConfig(30), log);
    expect(bootCaptured).toBeNull();
    expect(firstBoot).not.toBeNull();
  });

  test("stopAuditRetentionSweep clears both registered timers", async () => {
    const log = silentLogger();
    startAuditRetentionSweep(db, makeConfig(30), log);
    expect(bootCaptured).not.toBeNull();

    await fireBoot();
    expect(captured).not.toBeNull();

    await stopAuditRetentionSweep();
    expect(cleared).toBe(true);
  });

  test("invoking the scheduled callback prunes again and logs deletions", async () => {
    await insertEventAt(nanoid(), new Date(Date.now() - 90 * 86400_000).toISOString());
    const log = silentLogger();

    startAuditRetentionSweep(db, makeConfig(30), log);
    await fireBoot();
    log.calls.length = 0;

    // Insert a fresh expired event, then trigger the captured tick.
    await insertEventAt(nanoid(), new Date(Date.now() - 90 * 86400_000).toISOString());
    captured!.fn();
    await Bun.sleep(10);

    expect((await db.select().from(auditEvents).all()).length).toBe(0);
    expect(log.calls.some(c => c.level === "info")).toBe(true);
  });

  test("logs error and survives when the prune query throws", async () => {
    const log = silentLogger();
    startAuditRetentionSweep(db, makeConfig(30), log);
    await fireBoot();

    // Closing the DB makes the next prune call throw — exercises the
    // error-handling branch on the next tick.
    db.close();
    captured!.fn();
    await Bun.sleep(10);

    expect(log.calls.some(c => c.level === "error")).toBe(true);

    // Re-open for afterEach cleanup.
    db = await createDb(resolve(dir, "app.db"));
  });
});
