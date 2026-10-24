import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { eq } from "drizzle-orm";
import { SINGLE_USER_OAUTH_SUB } from "@/modules/account/auth/auth.service";
import { hashPassword } from "@/modules/account/auth/password";
import { sessions } from "@/modules/account/auth/schema";
import { users } from "@/modules/account/users/schema";
import { userColumns } from "@/modules/account/users/users.service";
import { getBootstrapAdmin } from "@/shared/lib/app-config";
import { AppError, isUniqueViolation } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

/** Prefix of `oauth_sub` for accounts that have no identity at the IdP (yet). */
export const LOCAL_SUB_PREFIX = "local:";

export interface LocalUserInput {
  readonly username: string;
  readonly name: string;
  readonly email: string;
  readonly role: "admin" | "user";
  readonly password: string;
}

/**
 * Create an account that signs in with a password. Usernames are matched
 * case-insensitively, so they are stored lower-cased, as the IdP path does.
 * If the person later signs in through the IdP with a verified email that
 * matches, the account is linked to that identity (see `upsertUser`) and
 * keeps its password.
 */
export async function createLocalUser(db: AppDatabase, input: LocalUserInput) {
  const id = nanoid();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(input.password);
  try {
    await db.insert(users).values({
      id,
      oauthSub: `${LOCAL_SUB_PREFIX}${id}`,
      username: input.username.toLowerCase(),
      name: input.name,
      email: input.email.toLowerCase(),
      role: input.role,
      status: "active",
      passwordHash,
      createdAt: now,
      updatedAt: now,
    }).run();
  }
  catch (err) {
    if (isUniqueViolation(err))
      throw new AppError("A user with this username or email already exists", 409, "CONFLICT");
    throw err;
  }
  return (await db.select(userColumns).from(users).where(eq(users.id, id)).get())!;
}

/**
 * Set (or reset) a user's password, and end their sessions so a changed
 * credential takes effect everywhere at once. Works on an IdP-only account
 * too, which makes it a local account as well.
 */
export async function setUserPassword(db: AppDatabase, userId: string, password: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  return await db.transaction(async (tx) => {
    const result = await tx.update(users)
      .set({
        passwordHash,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, userId))
      .run();
    if (result.rowsAffected === 0)
      return false;
    await tx.delete(sessions).where(eq(sessions.userId, userId)).run();
    return true;
  });
}

/**
 * Create or refresh the admin named by SINGLE_USER_* under LOCAL_LOGIN. The
 * environment is authoritative, as DEFAULT_ADMIN is: at every boot the
 * account is an active admin with the configured password, so a lost
 * password is recovered by changing the variable.
 *
 * Only an account that has no identity at the IdP is adopted. A username or
 * email is often self-chosen there, so an IdP account that happens to match
 * must not be promoted to admin by it — it would keep its IdP sign-in and
 * come out an admin. In that case nothing is seeded and the clash is logged;
 * pick another username, or grant that person admin with DEFAULT_ADMIN.
 */
export async function seedBootstrapAdmin(db: AppDatabase, config: Config, logger: Logger): Promise<void> {
  const admin = getBootstrapAdmin(config);
  if (admin === undefined)
    return;
  const now = new Date().toISOString();
  const existing = await db.select().from(users).where(eq(users.username, admin.username)).get();
  if (existing) {
    if (!existing.oauthSub.startsWith(LOCAL_SUB_PREFIX) && existing.oauthSub !== SINGLE_USER_OAUTH_SUB) {
      logger.error(
        { username: existing.username },
        "bootstrap admin not seeded: that username belongs to an account that signs in through the IdP; choose another SINGLE_USER_USERNAME",
      );
      return;
    }
    await db.update(users)
      .set({
        passwordHash: admin.passwordHash,
        role: "admin",
        status: "active",
        updatedAt: now,
      })
      .where(eq(users.id, existing.id))
      .run();
    logger.info({ username: existing.username }, "bootstrap admin refreshed from the environment");
    return;
  }
  const id = nanoid();
  try {
    await db.insert(users).values({
      id,
      oauthSub: `${LOCAL_SUB_PREFIX}${id}`,
      username: admin.username,
      name: admin.name,
      email: admin.email,
      role: "admin",
      status: "active",
      passwordHash: admin.passwordHash,
      createdAt: now,
      updatedAt: now,
    }).run();
  }
  catch (err) {
    if (!isUniqueViolation(err))
      throw err;
    logger.error({ username: admin.username }, "bootstrap admin not seeded: its email belongs to another account; set SINGLE_USER_EMAIL");
    return;
  }
  logger.info({ username: admin.username }, "bootstrap admin created from the environment");
}
