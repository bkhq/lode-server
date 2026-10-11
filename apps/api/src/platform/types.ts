import type { AppDatabase } from "@/db/types";

/**
 * Runtime seam. Everything the API needs from the host that differs between
 * Bun (long-lived process, local filesystem, libsql) and Cloudflare Workers
 * (per-request env, no filesystem, D1/R2/KV, Cron Triggers) goes through
 * these interfaces. Module code imports `getPlatform()` — never `Bun.*`,
 * `node:fs`, or a database driver directly.
 *
 * Contracts are deliberately narrow: they describe what the app uses today,
 * not what a host could offer.
 */

/** Process/host environment variables as a plain string map. */
export interface PlatformEnv {
  readonly get: (name: string) => string | undefined;
  /** Snapshot of every variable (config parsing wants the whole object). */
  readonly all: () => Record<string, string | undefined>;
}

/**
 * One logical table of a TTL key/value store. Bun keeps each namespace as
 * an in-process map; Workers back it with a KV binding and a key prefix.
 * Values must be JSON-serialisable.
 */
export interface KvNamespace {
  readonly get: <T = unknown>(key: string) => Promise<T | undefined>;
  readonly set: (key: string, value: unknown, ttlMs?: number) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
  /** Drop every key — test resets. */
  readonly clear: () => Promise<void>;
  /** Number of live keys; drives bounded-size eviction. */
  readonly size: () => Promise<number>;
  /**
   * Evict the entry whose numeric field `orderBy` is smallest. Bun
   * implements it exactly; a KV host may rely on TTL alone and return false.
   */
  readonly evictOldest: (orderBy: string) => Promise<boolean>;
}

export interface PlatformKv {
  readonly namespace: (name: string) => KvNamespace;
}

export interface ScheduledHandle {
  readonly stop: () => Promise<void>;
}

/**
 * Recurring / deferred background work. Bun uses timers inside the
 * process; Workers register the task and run it from a Cron Trigger's
 * `scheduled()` event, so `every` there means "on each trigger".
 */
export interface PlatformScheduler {
  /** Run `fn` after `delayMs`, then every `intervalMs`. Never overlaps runs. */
  readonly every: (name: string, opts: { delayMs: number; intervalMs: number }, fn: () => Promise<void>) => ScheduledHandle;
  /** Stop every task started through this scheduler; awaits in-flight runs. */
  readonly stopAll: () => Promise<void>;
}

/** What the host can do. Modules refuse configuration they cannot honour. */
export interface PlatformCapabilities {
  /** libsql page-level encryption at rest (`DB_ENCRYPTION=true`). */
  readonly encryptionAtRest: boolean;
  /** argon2 / bcrypt password verification (`Bun.password`). */
  readonly argon2: boolean;
  /**
   * Largest PBKDF2 iteration count the runtime will compute.
   *
   * Hosts cap this to bound the CPU a single request can burn. A hash
   * generated above the cap cannot be verified at all — not slowly, but
   * with an exception — so the boot guard rejects one rather than letting
   * every login answer "invalid credentials".
   */
  readonly pbkdf2MaxIterations: number;
  /** Spawning processes (the cron `shell` action). */
  readonly subprocess: boolean;
  /** A local filesystem for the `local` storage driver and file logs. */
  readonly filesystem: boolean;
  /**
   * A resident event loop, so code that arms its own `setTimeout` /
   * `setInterval` keeps firing between requests.
   *
   * This is *not* about the `scheduler` seam, which works everywhere. It is
   * about timers the app does not own — the cron module delegates scheduling
   * to cronbake, which holds a timer per job. A host that evicts the app
   * when idle (a Durable Object) would drop those jobs without a trace.
   */
  readonly residentTimers: boolean;
}

export interface Platform {
  readonly name: "bun" | "workers";
  readonly env: PlatformEnv;
  readonly kv: PlatformKv;
  readonly scheduler: PlatformScheduler;
  readonly capabilities: PlatformCapabilities;
  /**
   * Engine override for `createDb()`. Absent on Bun, which opens the local
   * libsql file; Workers supplies a Durable Object SQLite handle here.
   */
  readonly openDatabase?: (path: string, encryptionKey?: string) => Promise<AppDatabase>;
}
