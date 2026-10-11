import type { AppDatabase } from "@/db";
import { inArray, sql } from "drizzle-orm";
import { rateLimits } from "@/shared/schema";

/**
 * Counters for the creation quota: authoritative in memory, persisted
 * sparingly.
 *
 * The obvious implementation bumps the row on every request, which has two
 * problems. It writes to SQLite on a path that is otherwise free, and —
 * worse — it writes on *rejected* requests too, so the limiter turns into a
 * write amplifier under exactly the flood it exists to stop: ten thousand
 * refusals a minute become twenty thousand row writes a minute.
 *
 * So the count lives in memory and the row is written only when the stored
 * value would change a decision:
 *
 *  - while the counter is below the cap, at most once per `MAX_DRIFT`
 *    increments, so a normal burst costs a fraction of the writes;
 *  - once, on the request that crosses the cap, which is what makes the
 *    refusal durable;
 *  - never again for that window, because a stored count already past the
 *    cap rejects on its own after a restart.
 *
 * A flood therefore costs a handful of writes in total rather than two per
 * request.
 *
 * The cost is that a restart — or, on Cloudflare Workers, an eviction —
 * loses up to `MAX_DRIFT` increments for the keys in flight. That is
 * deliberate and bounded: a caller who engineers an eviction to recover a
 * few units has to go idle long enough for the object to be evicted, which
 * is a worse deal than simply waiting out the one-minute window and getting
 * the whole budget back.
 *
 * Memory being authoritative assumes one writer, which is what this app is
 * everywhere it runs: one Bun process, or one Durable Object. The same
 * assumption already underpins the in-memory rate limiter, the per-process
 * PKCE key and the request-scoped policy cache.
 */

/** Increments tolerated between writes while a counter is under its cap. */
const MAX_DRIFT = 8;

/** Backstop against a flood of distinct keys pinning memory. */
const MAX_CACHE_ENTRIES = 10_000;

interface Entry {
  count: number;
  resetAt: number;
  /** What the row currently holds, so drift can be measured. */
  persisted: number;
}

export interface QuotaRequest {
  readonly key: string;
  readonly windowMs: number;
  readonly max: number;
}

export interface QuotaResult {
  readonly key: string;
  readonly count: number;
  readonly resetAt: number;
}

const cache = new Map<string, Entry>();

function live(key: string, now: number): Entry | undefined {
  const entry = cache.get(key);
  if (!entry)
    return undefined;
  if (entry.resetAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

/** Drop expired entries, then the ones closest to expiry, to stay bounded. */
function evict(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.resetAt <= now)
      cache.delete(key);
  }
  if (cache.size <= MAX_CACHE_ENTRIES)
    return;
  const victims = [...cache.entries()]
    .sort((a, b) => a[1].resetAt - b[1].resetAt)
    .slice(0, cache.size - MAX_CACHE_ENTRIES);
  for (const [key] of victims)
    cache.delete(key);
}

/**
 * Count one request against each window and report the resulting totals.
 * Rows are read once per key per window (on the first request that touches
 * it) and written per the policy described above.
 */
export async function consumeCreationQuota(
  db: AppDatabase,
  requests: readonly QuotaRequest[],
): Promise<QuotaResult[]> {
  const now = Date.now();

  // Cold keys: adopt whatever a previous process or Durable Object
  // incarnation recorded, so a restart does not hand out a fresh budget.
  const cold = requests.filter(r => !live(r.key, now)).map(r => r.key);
  if (cold.length > 0) {
    const rows = await db.select().from(rateLimits).where(inArray(rateLimits.key, cold)).all();
    for (const row of rows) {
      if (row.resetAt > now)
        cache.set(row.key, { count: row.count, resetAt: row.resetAt, persisted: row.count });
    }
  }

  const results: QuotaResult[] = [];
  const dirty: Entry[] = [];
  const dirtyKeys: string[] = [];

  for (const request of requests) {
    let entry = live(request.key, now);
    if (!entry) {
      entry = { count: 0, resetAt: now + request.windowMs, persisted: 0 };
      cache.set(request.key, entry);
    }
    entry.count++;

    // Stop writing once the row is past the cap: it already refuses on its
    // own, so further increments cannot change any decision.
    const stillDecisive = entry.persisted <= request.max;
    const crossedCap = entry.count > request.max && entry.persisted <= request.max;
    if (stillDecisive && (crossedCap || entry.count - entry.persisted >= MAX_DRIFT)) {
      dirty.push(entry);
      dirtyKeys.push(request.key);
    }

    results.push({ key: request.key, count: entry.count, resetAt: entry.resetAt });
  }

  if (dirty.length > 0) {
    // Overwrite rather than increment: memory is the authority, the row is
    // only its checkpoint.
    const values = sql.join(
      dirtyKeys.map((key, i) => sql`(${key}, ${dirty[i]!.count}, ${dirty[i]!.resetAt})`),
      sql`, `,
    );
    await db.run(sql`
      INSERT INTO rate_limits (key, count, reset_at)
      VALUES ${values}
      ON CONFLICT(key) DO UPDATE SET count = excluded.count, reset_at = excluded.reset_at
    `);
    for (const entry of dirty)
      entry.persisted = entry.count;
  }

  evict(now);
  return results;
}

/** Test-only: forget the cached counters, as a restart would. */
export function __resetCreationQuotaForTests(): void {
  cache.clear();
}
