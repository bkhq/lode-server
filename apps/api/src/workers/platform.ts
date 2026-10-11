import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { Platform, PlatformScheduler, ScheduledHandle } from "@/platform";
import { createMemoryKv } from "@/platform/memory-kv";
import { createWorkersDb } from "./db";

interface Task {
  intervalMs: number;
  fn: () => Promise<void>;
  nextAt: number;
  inFlight: Promise<void> | undefined;
}

export interface WorkersPlatform {
  readonly platform: Platform;
  /**
   * Run every task whose deadline has passed and re-arm the alarm. The
   * Durable Object's `alarm()` handler calls this; it is the Workers
   * equivalent of a timer firing.
   */
  readonly runDueTasks: () => Promise<void>;
}

/**
 * Cloudflare Workers adapter.
 *
 * The whole app lives inside one Durable Object instance, so it keeps the
 * single-writer, single-memory-space properties the Bun process has: the
 * key/value seam stays in memory, and background work is driven by the
 * object's alarm instead of `setInterval` (a Worker has no wall clock
 * between requests, and the object is evicted when idle).
 */
export function createWorkersPlatform(opts: {
  env: Record<string, unknown>;
  storage: DurableObjectStorage;
}): WorkersPlatform {
  const { env, storage } = opts;
  const tasks = new Map<string, Task>();

  const earliestDeadline = (): number | undefined => {
    let earliest: number | undefined;
    for (const t of tasks.values()) {
      if (earliest === undefined || t.nextAt < earliest)
        earliest = t.nextAt;
    }
    return earliest;
  };

  // Alarms are a single slot per object, so every task multiplexes onto the
  // nearest deadline. Only move the alarm earlier — a later one would be
  // re-armed by `runDueTasks` anyway.
  const ensureAlarm = async (): Promise<void> => {
    const earliest = earliestDeadline();
    if (earliest === undefined)
      return;
    const current = await storage.getAlarm();
    if (current === null || current > earliest)
      await storage.setAlarm(earliest);
  };

  const runDueTasks = async (): Promise<void> => {
    const now = Date.now();
    const started: Promise<void>[] = [];
    for (const task of tasks.values()) {
      if (task.nextAt > now)
        continue;
      task.nextAt = now + task.intervalMs;
      // A tick that arrives while the previous run is still going is
      // skipped, matching the Bun scheduler's non-overlap guarantee.
      if (task.inFlight)
        continue;
      const run = task.fn().catch(() => {}).finally(() => {
        task.inFlight = undefined;
      });
      task.inFlight = run;
      started.push(run);
    }
    await Promise.all(started);
    await ensureAlarm();
  };

  const scheduler: PlatformScheduler = {
    every(name, { delayMs, intervalMs }, fn) {
      const task: Task = { intervalMs, fn, nextAt: Date.now() + delayMs, inFlight: undefined };
      tasks.set(name, task);
      void ensureAlarm();
      const handle: ScheduledHandle = {
        async stop() {
          tasks.delete(name);
          await task.inFlight;
        },
      };
      return handle;
    },
    async stopAll() {
      const pending = [...tasks.values()].map(t => t.inFlight).filter((p): p is Promise<void> => p !== undefined);
      tasks.clear();
      await Promise.all(pending);
    },
  };

  const readEnv = (name: string): string | undefined => {
    const value = env[name];
    return typeof value === "string" ? value : undefined;
  };

  const platform: Platform = {
    name: "workers",
    env: {
      get: readEnv,
      all: () => {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(env)) {
          if (typeof value === "string")
            out[key] = value;
        }
        return out;
      },
    },
    kv: createMemoryKv(),
    scheduler,
    capabilities: {
      // Durable Object storage is encrypted by the host; libsql's
      // page-level encryption has no equivalent here and `DB_ENCRYPTION`
      // is rejected at boot.
      encryptionAtRest: false,
      // No `Bun.password`: argon2/bcrypt hashes cannot be verified.
      argon2: false,
      // Observed on a real deployment: PBKDF2 throws above this, while
      // `wrangler dev` happily computes any count — so a hash minted for a
      // Bun deployment authenticates locally and fails in production.
      pbkdf2MaxIterations: 100_000,
      subprocess: false,
      filesystem: false,
      // The object is evicted when idle and only an alarm wakes it, so a
      // third-party scheduler holding its own timers cannot be trusted here.
      residentTimers: false,
    },
    openDatabase: async (_path, encryptionKey) => {
      if (encryptionKey !== undefined)
        throw new Error("[platform] at-rest database encryption is not available on Cloudflare Workers");
      return createWorkersDb(storage);
    },
  };

  return { platform, runDueTasks };
}
