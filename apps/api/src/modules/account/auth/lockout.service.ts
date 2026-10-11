import type { AppDatabase } from "@/db";
import { eq } from "drizzle-orm";
import { authLockouts } from "./schema";

/**
 * Persistent counter + lockout window. Backs the per-username brute-force
 * defence for single-user login and the per-user TOTP step-up. Stored in
 * SQLite (encrypted at rest when `DB_ENCRYPTION=true`) so:
 *
 *   - a deliberate restart does not reset the counter;
 *   - replicas sharing one DB see the same state;
 *   - operators can audit / clear lockouts with a regular SQL session.
 *
 * The key namespace is caller-defined ("single-user:<username-lower>",
 * "totp:<user-id>", …). Callers pass thresholds + windows so this
 * module stays policy-free.
 */

export interface LockoutPolicy {
  /** Failures required before the bucket transitions to `locked`. */
  threshold: number;
  /** Lockout duration in milliseconds once threshold is reached. */
  windowMs: number;
}

export interface LockoutState {
  locked: boolean;
  retryAfterSeconds: number;
}

const UNLOCKED: LockoutState = { locked: false, retryAfterSeconds: 0 };

/** Returns the current lock state without mutating the row. */
export async function isLocked(db: AppDatabase, key: string): Promise<LockoutState> {
  const row = await db.select().from(authLockouts).where(eq(authLockouts.key, key)).get();
  if (!row || row.lockedUntil === null)
    return UNLOCKED;
  const remaining = row.lockedUntil - Date.now();
  if (remaining <= 0) {
    // TTL elapsed — clear the row lazily so the next read is a fast hit.
    await db.delete(authLockouts).where(eq(authLockouts.key, key));
    return UNLOCKED;
  }
  return { locked: true, retryAfterSeconds: Math.ceil(remaining / 1000) };
}

/**
 * Record a failed attempt. If the counter would cross the threshold the
 * bucket is moved to the locked state. Returns the post-increment state
 * so callers can branch on "this attempt tripped the lock" without a
 * second read.
 */
export async function recordFailure(
  db: AppDatabase,
  key: string,
  policy: LockoutPolicy,
): Promise<LockoutState> {
  const row = await db.select().from(authLockouts).where(eq(authLockouts.key, key)).get();
  const failures = (row?.failures ?? 0) + 1;
  const lockedUntil = failures >= policy.threshold ? Date.now() + policy.windowMs : null;
  if (row) {
    await db.update(authLockouts)
      .set({ failures, lockedUntil, updatedAt: new Date().toISOString() })
      .where(eq(authLockouts.key, key));
  }
  else {
    await db.insert(authLockouts).values({ key, failures, lockedUntil });
  }
  if (lockedUntil !== null)
    return { locked: true, retryAfterSeconds: Math.ceil(policy.windowMs / 1000) };
  return UNLOCKED;
}

/** Drop the row on successful authentication. */
export async function clearFailures(db: AppDatabase, key: string): Promise<void> {
  await db.delete(authLockouts).where(eq(authLockouts.key, key));
}

/** Admin / test helper: drop every lockout row. */
export async function clearAllLockouts(db: AppDatabase): Promise<void> {
  await db.delete(authLockouts);
}
