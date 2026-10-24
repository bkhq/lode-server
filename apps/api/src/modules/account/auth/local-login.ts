import type { LockoutPolicy } from "./lockout.service";
import type { AppDatabase } from "@/db";
import { eq } from "drizzle-orm";
import { users } from "@/modules/account/users/schema";
import { AppError } from "@/shared/lib/errors";
import { clearFailures, isLocked, recordFailure } from "./lockout.service";
import { hashPassword, verifyPassword } from "./password";

// Mirrors the single-user policy: the IP limiter alone cannot stop an
// attacker who rotates addresses against one account.
const POLICY: LockoutPolicy = { threshold: 10, windowMs: 15 * 60 * 1000 };

const lockKey = (username: string): string => `local:${username.toLowerCase()}`;

// Verified against when the username is unknown, so a missing account costs
// the same time as a wrong password.
let decoyHash: Promise<string> | undefined;

export type LocalLoginResult
  = | { readonly status: "ok"; readonly user: typeof users.$inferSelect }
    | { readonly status: "locked"; readonly retryAfterSeconds: number }
    | { readonly status: "invalid" };

/**
 * Check a username and password against the accounts that have one. A
 * disabled account is `invalid` like any other bad credential, so the answer
 * does not say which accounts exist. Failures count against the submitted
 * username, existing or not.
 */
export async function loginLocalUser(db: AppDatabase, usernameRaw: string, password: string): Promise<LocalLoginResult> {
  const username = usernameRaw.toLowerCase();
  const lock = await isLocked(db, lockKey(username));
  if (lock.locked)
    return { status: "locked", retryAfterSeconds: lock.retryAfterSeconds };

  const user = await db.select().from(users).where(eq(users.username, username)).get();
  const hash = user?.passwordHash ?? await (decoyHash ??= hashPassword("decoy-password-never-matches"));
  let matches: boolean;
  try {
    matches = await verifyPassword(password, hash);
  }
  catch (err) {
    // The hash cannot be checked here (a primitive or cost this runtime
    // refuses): a server fault, not a bad credential, so it neither says
    // "invalid" nor counts toward the lockout.
    throw new AppError(
      `Password verification is unavailable on this runtime: ${err instanceof Error
        ? err.message
        : String(err)}`,
      500,
      "PASSWORD_VERIFY_UNAVAILABLE",
    );
  }

  if (user === undefined || user.passwordHash === null || user.status !== "active" || !matches) {
    const after = await recordFailure(db, lockKey(username), POLICY);
    return after.locked
      ? { status: "locked", retryAfterSeconds: after.retryAfterSeconds }
      : { status: "invalid" };
  }

  await clearFailures(db, lockKey(username));
  const now = new Date().toISOString();
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id)).run();
  return {
    status: "ok",
    user: { ...user, lastLoginAt: now },
  };
}
