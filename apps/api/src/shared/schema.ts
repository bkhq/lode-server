import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Durable fixed-window rate-limit counters.
 *
 * The in-memory limiter in `shared/middleware/rate-limit.ts` is the right
 * tool for high-frequency, short-window, IP-keyed gates: it costs nothing
 * per request and a lost window after a restart is not interesting. It is
 * the wrong tool for a window measured in minutes, because the state dies
 * with the process — and on a runtime that evicts the app when idle
 * (Cloudflare Workers), an attacker can pace requests around the eviction
 * and reset the window at will.
 *
 * This table backs the limiter that does need to survive that:
 * `shared/middleware/user-rate-limit.ts`, keyed per user. Cardinality is
 * bounded by users × buckets, and a key is overwritten in place on its next
 * request, so expired rows are reused rather than accumulating — no sweep.
 *
 * Deliberately absent from every backup contribution, like `auth_lockouts`:
 * this is transient security state, not user data, and restoring a stale
 * counter into a live system would be wrong.
 */
export const rateLimits = sqliteTable("rate_limits", {
  /** `<bucket>:<subject>` — see `userRateLimit`. */
  key: text("key").primaryKey(),
  /** Requests counted in the current window, including rejected ones. */
  count: integer("count").notNull().default(0),
  /** Epoch milliseconds at which the window rolls over. */
  resetAt: integer("reset_at").notNull(),
}, t => [
  index("idx_rate_limits_reset_at").on(t.resetAt),
]);
