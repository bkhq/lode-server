import type { KvNamespace } from "@/platform";
import type { AppEnv } from "@/shared/lib/types";
import { createMiddleware } from "hono/factory";
import { getPlatform } from "@/platform";
import { getClientIp } from "@/shared/lib/client-ip";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Max requests per IP per window. */
  readonly max: number;
  /** Logical bucket id; share between routes that should drain the same budget. */
  readonly bucket: string;
}

export interface RateLimitCheck {
  /** Logical bucket id; see {@link RateLimitOptions.bucket}. */
  readonly bucket: string;
  /** Identity being limited — an IP, a user id, whatever the caller keys on. */
  readonly key: string;
  /** Window length in milliseconds. */
  readonly windowMs: number;
  /** Max units per key per window. */
  readonly max: number;
}

/**
 * Hard cap on entries per bucket; on overflow the entry with the smallest
 *  `resetAt` is evicted so legitimate active sessions are preserved.
 */
const MAX_ENTRIES_PER_BUCKET = 10_000;

const KV_PREFIX = "rate-limit:";

/** Every bucket namespace handed out so far — reset must clear them all. */
const buckets = new Map<string, KvNamespace>();

function getBucket(name: string): KvNamespace {
  let ns = buckets.get(name);
  if (!ns) {
    ns = getPlatform().kv.namespace(`${KV_PREFIX}${name}`);
    buckets.set(name, ns);
  }
  return ns;
}

/**
 * Consume one unit from a fixed window. Returns `0` when the caller is
 * within budget, otherwise the seconds remaining until the window resets.
 *
 * This is the single implementation of the in-memory fixed-window counter.
 * Route handlers that need to gate part of their work (the auth flow, the
 * encryption unlock flow) call it directly; `rateLimit()` below wraps it as
 * middleware. Having one implementation means one eviction policy and one
 * behaviour on every runtime.
 *
 * A caller already at the cap is not counted again, so a burst cannot push
 * the window further out.
 */
export async function consumeRateLimit(opts: RateLimitCheck): Promise<number> {
  const { bucket, key, windowMs, max } = opts;
  const store = getBucket(bucket);
  const now = Date.now();
  const entry = await store.get<Bucket>(key);

  if (entry && now < entry.resetAt) {
    if (entry.count >= max)
      return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    entry.count++;
    await store.set(key, entry, entry.resetAt - now);
    return 0;
  }

  if (await store.size() >= MAX_ENTRIES_PER_BUCKET) {
    // Evict the entry closest to expiry, so an address under active abuse
    // (its reset pushed furthest out) survives and the gate keeps working.
    await store.evictOldest("resetAt");
  }
  await store.set(key, { count: 1, resetAt: now + windowMs }, windowMs);
  return 0;
}

/**
 * Per-IP rate limiter. Uses the resolved client IP (peer IP by default, or
 * sanitised proxy headers when `config.TRUST_PROXY` is true); unresolved
 * peers share a single `anon` bucket to prevent header churn from evading
 * the gate.
 *
 * State lives in the platform kv seam: on Bun that is an in-process map
 * whose expired entries are swept by one `unref()`'d timer; on a KV-backed
 * host the TTL passed to `set` does the pruning.
 *
 * For a window that must outlive the process — a per-user creation quota,
 * say — use `creation-rate-limit.ts`, which counts in the database instead.
 */
export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, bucket } = opts;

  return createMiddleware<AppEnv>(async (c, next) => {
    const key = getClientIp(c, c.var.config) ?? "anon";
    const retryAfter = await consumeRateLimit({ bucket, key, windowMs, max });
    if (retryAfter > 0) {
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { success: false, error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
        429,
      );
    }
    return next();
  });
}

/**
 * Test-only: drop all bucket state. Call from `beforeEach` in tests
 * that exercise rate-limited routes so leftover hits from the previous case
 * do not bleed into the next one (the `getClientIp("anon")` fallback shares
 * a bucket across all synthetic Requests).
 */
export async function __resetRateLimitForTests(): Promise<void> {
  await Promise.all([...buckets.values()].map(ns => ns.clear()));
}
