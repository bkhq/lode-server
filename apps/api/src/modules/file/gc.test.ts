import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { afterEach, describe, expect, test } from "bun:test";
import { startFileGcSweep, stopFileGcSweep } from "./gc";

const noop = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

// A db that records any attempt to query it. The sweep must never touch it
// after stopFileGcSweep() has been awaited.
function recordingDb(): { db: AppDatabase; touches: () => number } {
  let n = 0;
  const trap = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then")
        return undefined;
      n++;
      return () => trap;
    },
  });
  return { db: trap as unknown as AppDatabase, touches: () => n };
}

afterEach(async () => {
  await stopFileGcSweep();
});

describe("file GC sweep shutdown", () => {
  test("stopFileGcSweep resolves, cancels the pending first run, and is idempotent", async () => {
    const { db, touches } = recordingDb();
    startFileGcSweep(db, { FILE_GC_INTERVAL_SECONDS: 1, FILE_GC_MODE: "async" } as unknown as Config, noop);

    // Stop before the deferred first sweep fires: nothing may run afterwards.
    await expect(stopFileGcSweep()).resolves.toBeUndefined();
    await new Promise(r => setTimeout(r, 20));
    expect(touches()).toBe(0);

    await expect(stopFileGcSweep()).resolves.toBeUndefined();
  });

  test("a sync-mode or disabled configuration never schedules a sweep", async () => {
    const { db, touches } = recordingDb();
    startFileGcSweep(db, { FILE_GC_INTERVAL_SECONDS: 0, FILE_GC_MODE: "async" } as unknown as Config, noop);
    startFileGcSweep(db, { FILE_GC_INTERVAL_SECONDS: 1, FILE_GC_MODE: "sync" } as unknown as Config, noop);
    await stopFileGcSweep();
    expect(touches()).toBe(0);
  });
});
