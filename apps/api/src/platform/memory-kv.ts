import type { KvNamespace, PlatformKv } from "./types";

/**
 * In-process TTL key/value store: one `Map` per namespace, expiry enforced
 * on read and reclaimed by a single `unref()`'d sweep timer.
 *
 * Shared by both adapters. It is correct on Bun (one process) and on
 * Cloudflare Workers, where the app runs inside a single Durable Object
 * instance — the same "one writer, one memory space" property the Bun
 * process has. A multi-isolate deployment would need a real KV binding
 * here instead.
 */
interface Entry {
  value: unknown;
  expiresAt: number | undefined;
}

/** Lower bound for the expiry sweep so a 1 ms TTL cannot spin the loop. */
const MIN_SWEEP_MS = 1000;

export function createMemoryKv(): PlatformKv {
  const spaces = new Map<string, Map<string, Entry>>();
  let sweepMs = Number.POSITIVE_INFINITY;
  let sweeper: ReturnType<typeof setInterval> | undefined;

  const sweep = () => {
    const now = Date.now();
    for (const store of spaces.values()) {
      for (const [k, e] of store) {
        if (e.expiresAt !== undefined && e.expiresAt <= now)
          store.delete(k);
      }
    }
  };

  // One unref'd timer for every namespace, period bounded by the smallest
  // TTL seen so an expired entry never outlives its TTL by more than one
  // period. Reads enforce TTL themselves; the sweep only frees memory.
  const ensureSweeper = (ttlMs: number) => {
    const want = Math.max(MIN_SWEEP_MS, ttlMs);
    if (sweeper && want >= sweepMs)
      return;
    sweepMs = Math.min(sweepMs, want);
    if (sweeper)
      clearInterval(sweeper);
    sweeper = setInterval(sweep, sweepMs);
    (sweeper as { unref?: () => void }).unref?.();
  };

  const namespace = (name: string): KvNamespace => {
    let store = spaces.get(name);
    if (!store) {
      store = new Map();
      spaces.set(name, store);
    }
    const map = store;
    const live = (key: string): Entry | undefined => {
      const e = map.get(key);
      if (!e)
        return undefined;
      if (e.expiresAt !== undefined && e.expiresAt <= Date.now()) {
        map.delete(key);
        return undefined;
      }
      return e;
    };
    return {
      async get<T>(key: string) {
        return live(key)?.value as T | undefined;
      },
      async set(key, value, ttlMs) {
        if (ttlMs !== undefined)
          ensureSweeper(ttlMs);
        map.set(key, { value, expiresAt: ttlMs === undefined ? undefined : Date.now() + ttlMs });
      },
      async delete(key) {
        map.delete(key);
      },
      async clear() {
        map.clear();
      },
      async size() {
        return map.size;
      },
      async evictOldest(orderBy) {
        let oldestKey: string | undefined;
        let oldest = Number.POSITIVE_INFINITY;
        for (const [k, e] of map) {
          const v = (e.value as Record<string, unknown> | null)?.[orderBy];
          if (typeof v === "number" && v < oldest) {
            oldest = v;
            oldestKey = k;
          }
        }
        if (oldestKey === undefined)
          return false;
        map.delete(oldestKey);
        return true;
      },
    };
  };

  return { namespace };
}
