import type { Context } from "hono";
import type { AppDatabase } from "@/db";
import type { AuthConfig } from "@/shared/lib/app-config";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv, User } from "@/shared/lib/types";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { eq, lte, or } from "drizzle-orm";
import { openPkceVerifier, sealPkceVerifier } from "@/modules/account/auth/pkce-secret";
import { pkceChallenges, sessions } from "@/modules/account/auth/schema";
import { clearSessionCookie, readSessionId, writeSessionCookie } from "@/modules/account/auth/session-cookie";
import { users } from "@/modules/account/users/schema";
import { getAuthConfig } from "@/shared/lib/app-config";
import { AppError, isUniqueViolation } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";

// --- PKCE helpers ---

interface PkceEntry {
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly expiresAt: number;
}

const PKCE_TTL_MS = 5 * 60 * 1000;

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  // WebCrypto rather than `Bun.CryptoHasher`: the same primitive exists on
  // every runtime the app targets.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

// --- PKCE store (SQLite-backed) ---
//
// Stateless service functions that take `db` as a parameter so callers
// thread the per-request handle through `c.get("db")`. The previous
// `initPkceStore` singleton coupled the module to a process-global
// reference — DEK rotation hot-swapped the live db without flushing
// it, leaving stale handles in pending refresh promises.

async function cleanExpiredPkce(db: AppDatabase): Promise<void> {
  const now = Date.now();
  await db.delete(pkceChallenges).where(lte(pkceChallenges.expiresAt, now)).run();
}

// --- Service functions ---

export async function createPkceChallenge(db: AppDatabase, redirectUri: string) {
  await cleanExpiredPkce(db);

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const expiresAt = Date.now() + PKCE_TTL_MS;

  await db.insert(pkceChallenges).values({
    state,
    // AEAD-sealed with a per-process key; an at-rest DB dump alone
    // cannot recover the verifier even when DB_ENCRYPTION=false.
    codeVerifier: sealPkceVerifier(codeVerifier),
    redirectUri,
    expiresAt,
  }).run();

  const codeChallenge = await generateCodeChallenge(codeVerifier);
  return { state, codeVerifier, codeChallenge };
}

export async function consumePkceEntry(db: AppDatabase, state: string): Promise<PkceEntry | undefined> {
  await cleanExpiredPkce(db);

  const row = await db.select().from(pkceChallenges).where(eq(pkceChallenges.state, state)).get();
  if (!row)
    return undefined;

  await db.delete(pkceChallenges).where(eq(pkceChallenges.state, state)).run();

  // Defence in depth: cleanExpiredPkce ran first, but a row could still be
  // racing past its TTL. Reject explicitly rather than returning a stale entry.
  if (Date.now() > row.expiresAt)
    return undefined;

  // Unseal the stored verifier. A failure means either the row was
  // forged or the process restarted since the row was minted (the key
  // is in-memory only). Either way, treat as "missing" so the caller
  // sees a state-invalid redirect, not a 500.
  const codeVerifier = openPkceVerifier(row.codeVerifier);
  if (codeVerifier === undefined)
    return undefined;

  return {
    codeVerifier,
    redirectUri: row.redirectUri,
    expiresAt: row.expiresAt,
  };
}

// --- User upsert ---

interface OAuthUserInfo {
  readonly sub: string;
  readonly preferred_username?: string;
  readonly username?: string;
  readonly name?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly picture?: string;
}

export async function upsertUser(
  db: AppDatabase,
  userInfo: OAuthUserInfo,
  authConfig: AuthConfig,
  logger: Logger,
): Promise<typeof users.$inferSelect> {
  const now = new Date().toISOString();
  const defaultAdmins = authConfig.defaultAdmins;
  // IdPs that don't expose a username claim (e.g. dex's password connector
  // without a configured `username` field) would otherwise leak the opaque
  // `sub` into a human-facing field. Fall back to a short random handle
  // instead — the user can still be identified by email/name in the UI.
  const username = (userInfo.preferred_username ?? userInfo.username ?? `u_${nanoid()}`).toLowerCase();
  const email = (userInfo.email ?? "").toLowerCase();
  // An unverified email is attacker-chosen at many IdPs; only match on it
  // when the IdP asserts it verified.
  const emailTrusted = userInfo.email_verified === true && email !== "";

  // DEFAULT_ADMIN is the operator's statement of who administers the
  // deployment, so a matching login is an admin — on the first login and
  // every later one, whether or not other admins exist. It grants and never
  // revokes: an admin promoted in the UI keeps the role when they are not
  // listed. The flip side is that demoting a listed admin in the UI lasts
  // only until their next login; remove them from DEFAULT_ADMIN instead.
  //
  // An entry containing "@" is an email and matches only a verified email.
  // Anything else is a username and matches only the username. Usernames are
  // often self-chosen, so a username spelled like the admin's address must
  // not be able to claim it.
  const matchesDefaultAdmin = defaultAdmins.some(entry =>
    entry.includes("@")
      ? emailTrusted && entry === email
      : entry === username,
  );
  const roleFor = (current: "admin" | "user"): "admin" | "user" => {
    if (matchesDefaultAdmin && current !== "admin") {
      logger.info({ username }, "user granted admin role via DEFAULT_ADMIN");
      return "admin";
    }
    return current;
  };

  const existing = await db.select().from(users).where(eq(users.oauthSub, userInfo.sub)).get();

  if (existing) {
    const role = roleFor(existing.role);
    await db.update(users)
      .set({
        name: userInfo.name ?? existing.name,
        email: userInfo.email ?? existing.email,
        avatar: userInfo.picture ?? existing.avatar,
        role,
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, existing.id))
      .run();

    return {
      ...existing,
      role,
      lastLoginAt: now,
      updatedAt: now,
    };
  }

  // The transaction covers the duplicate-sub race below: two callbacks for a
  // brand-new identity must not both insert it.
  return await db.transaction(async (tx) => {
    // Double-check inside the tx: another concurrent callback could have just
    // created the same user. If so, fall through to update behaviour.
    const dupe = await tx.select().from(users).where(eq(users.oauthSub, userInfo.sub)).get();
    if (dupe) {
      const role = roleFor(dupe.role);
      await tx.update(users)
        .set({
          name: userInfo.name ?? dupe.name,
          email: userInfo.email ?? dupe.email,
          avatar: userInfo.picture ?? dupe.avatar,
          role,
          lastLoginAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, dupe.id))
        .run();
      return {
        ...dupe,
        role,
        lastLoginAt: now,
        updatedAt: now,
      };
    }

    // Take-over path: an existing row matches by username or email but not
    // by sub. Most common trigger is the operator toggling
    // SINGLE_USER_MODE — single-user mode rewrites the row's oauth_sub to
    // the `"single-user"` sentinel, so the next OAuth login can no longer
    // resolve by sub and would otherwise crash on the username/email
    // unique constraint. Rewriting oauth_sub back to the IdP value
    // re-binds the row to the OAuth identity. An existing admin role is
    // preserved, and DEFAULT_ADMIN can still grant one.
    const conflict = emailTrusted
      ? await tx.select().from(users).where(or(eq(users.username, username), eq(users.email, email))).get()
      : await tx.select().from(users).where(eq(users.username, username)).get();
    if (conflict) {
      // An account with a password is not claimed by a username: usernames
      // are often self-chosen at the IdP, so anyone able to register as
      // "admin" there would otherwise be handed the local admin. Only a
      // verified email the IdP vouches for links the two.
      if (conflict.passwordHash !== null && !(emailTrusted && conflict.email === email)) {
        throw new AppError(
          "This username belongs to an account that signs in with a password",
          409,
          "ACCOUNT_CONFLICT",
        );
      }
      logger.info(
        { id: conflict.id, prevSub: conflict.oauthSub, newSub: userInfo.sub },
        "rebinding existing user to new oauth_sub (identity migration)",
      );
      const role = roleFor(conflict.role);
      await tx.update(users)
        .set({
          oauthSub: userInfo.sub,
          username,
          name: userInfo.name ?? conflict.name,
          email: userInfo.email ?? conflict.email,
          avatar: userInfo.picture ?? conflict.avatar,
          role,
          lastLoginAt: now,
          updatedAt: now,
        })
        .where(eq(users.id, conflict.id))
        .run();
      return {
        ...conflict,
        role,
        oauthSub: userInfo.sub,
        username,
        name: userInfo.name ?? conflict.name,
        email: userInfo.email ?? conflict.email,
        avatar: userInfo.picture ?? conflict.avatar,
        lastLoginAt: now,
        updatedAt: now,
      };
    }

    const newUser = {
      id: nanoid(),
      oauthSub: userInfo.sub,
      username,
      name: userInfo.name ?? username,
      email: userInfo.email ?? "",
      avatar: userInfo.picture ?? null,
      passwordHash: null,
      role: roleFor("user"),
      status: "active" as const,
      lastLoginAt: now,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await tx.insert(users).values(newUser).run();
    }
    catch (err) {
      // The username or email is held by another account that was not
      // matched above (an unverified email, say). Say so instead of 500.
      if (isUniqueViolation(err))
        throw new AppError("This username or email belongs to another account", 409, "ACCOUNT_CONFLICT");
      throw err;
    }
    return newUser;
  });
}

// --- Single-user upsert ---

export const SINGLE_USER_OAUTH_SUB = "single-user";

/**
 * Sentinel value persisted into `sessions.access_token` for sessions
 * minted by single-user login. The column is NOT NULL in the schema, so
 * we cannot store `null`. Consumers that interpret `accessToken` as an
 * OAuth bearer (e.g. `revokeToken`) MUST check for this sentinel and
 * skip the call — pushing a fake string at an IdP both fails noisily
 * and leaks the session shape.
 */
export const SINGLE_USER_ACCESS_TOKEN = "single-user:no-oauth";

export function isSingleUserSession(token: string | null | undefined): boolean {
  return token === SINGLE_USER_ACCESS_TOKEN;
}

interface SingleUserInput {
  readonly username: string;
  readonly name: string;
  readonly email: string;
}

/**
 * Resolve (or create) the row backing single-user mode. Match order:
 *   1. existing row with `oauth_sub = "single-user"` → update in place
 *   2. existing row with the configured username or email (e.g. a previous
 *      OAuth user on the same identity) → take it over, rewriting
 *      `oauth_sub` to the sentinel so future single-user logins resolve to
 *      the same row
 *   3. fresh insert
 *
 * Step 2 handles the deployment-flip case where an operator switches an
 * existing app from OAuth to single-user mode without wiping the DB.
 */
export async function upsertSingleUser(
  db: AppDatabase,
  input: SingleUserInput,
): Promise<typeof users.$inferSelect> {
  const now = new Date().toISOString();
  const existing
    = (await db.select().from(users).where(eq(users.oauthSub, SINGLE_USER_OAUTH_SUB)).get())
      ?? (await db.select().from(users).where(or(eq(users.username, input.username), eq(users.email, input.email))).get());

  if (existing) {
    await db.update(users)
      .set({
        oauthSub: SINGLE_USER_OAUTH_SUB,
        username: input.username,
        name: input.name,
        email: input.email,
        role: "admin",
        status: "active",
        lastLoginAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, existing.id))
      .run();
    return {
      ...existing,
      oauthSub: SINGLE_USER_OAUTH_SUB,
      username: input.username,
      name: input.name,
      email: input.email,
      role: "admin",
      status: "active",
      lastLoginAt: now,
      updatedAt: now,
    };
  }

  const newUser = {
    id: nanoid(),
    oauthSub: SINGLE_USER_OAUTH_SUB,
    username: input.username,
    name: input.name,
    email: input.email,
    avatar: null,
    passwordHash: null,
    role: "admin" as const,
    status: "active" as const,
    lastLoginAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(users).values(newUser).run();
  return newUser;
}

// --- Session CRUD ---
//
// A session's lifetime is the app's own, `session.max_age`, never the IdP
// access token's: the token is used once at sign-in and once at sign-out, so
// tying the session to it (an hour at most IdPs) logged users out mid-use.
// The lifetime is an idle timeout — each use past half of it extends the
// session by a full period — and no session lives longer than
// SESSION_ABSOLUTE_LIFETIME_MS from sign-in, so changes made at the IdP
// (a disabled account, new groups) reach the app at least that often.

export const SESSION_ABSOLUTE_LIFETIME_MS = 30 * 24 * 3_600_000;

/** When a session started at `createdAt` must end, however active. */
function absoluteDeadline(createdAt: string): number {
  return Date.parse(createdAt) + SESSION_ABSOLUTE_LIFETIME_MS;
}

/**
 * `refreshToken` is kept only so sign-out can revoke it at the IdP; it never
 * extends a session.
 */
export async function createSession(
  db: AppDatabase,
  userId: string,
  accessToken: string,
  refreshToken: string | undefined,
  maxAgeSeconds: number,
): Promise<string> {
  const id = randomBytes(32).toString("hex");
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  // Nothing else deletes a session that is never used again.
  await db.delete(sessions).where(or(
    lte(sessions.expiresAt, now),
    lte(sessions.createdAt, new Date(nowMs - SESSION_ABSOLUTE_LIFETIME_MS).toISOString()),
  )).run();

  await db.insert(sessions).values({
    id,
    userId,
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresAt: new Date(nowMs + maxAgeSeconds * 1000).toISOString(),
    createdAt: now,
    updatedAt: now,
  }).run();

  return id;
}

export async function getSessionWithUser(db: AppDatabase, sessionId: string) {
  // Single JOIN — every authenticated request runs this. Drizzle's `.get()`
  // returns the first row; we then split it into the two domain shapes the
  // callers expect. Halves the per-request DB round-trip count compared to
  // the previous "fetch session → fetch user" sequence.
  const row = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .get();
  if (!row)
    return undefined;
  return row;
}

export async function deleteSession(db: AppDatabase, sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export async function deleteUserSessions(db: AppDatabase, userId: string) {
  await db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

export function isSessionExpired(session: { readonly expiresAt: string; readonly createdAt: string }): boolean {
  const now = Date.now();
  return Date.parse(session.expiresAt) <= now || absoluteDeadline(session.createdAt) <= now;
}

/**
 * Extend a session in use once more than half of its current period has
 * passed, so it is written at most twice per period. `updatedAt` marks the
 * start of the period. The new period is `session.max_age` as configured
 * now, cut short at the absolute deadline.
 */
async function renewSessionIfDue(
  db: AppDatabase,
  c: Context<AppEnv>,
  session: { readonly id: string; readonly expiresAt: string; readonly createdAt: string; readonly updatedAt: string },
): Promise<void> {
  const now = Date.now();
  const expiresAt = Date.parse(session.expiresAt);
  const deadline = absoluteDeadline(session.createdAt);
  const periodStart = Date.parse(session.updatedAt);
  if (expiresAt >= deadline || now - periodStart < (expiresAt - periodStart) / 2)
    return;

  const config = c.get("config");
  const { sessionMaxAge } = await getAuthConfig(db, config);
  const next = Math.min(now + sessionMaxAge * 1000, deadline);
  if (next <= expiresAt)
    return;
  await db.update(sessions)
    .set({
      expiresAt: new Date(next).toISOString(),
      updatedAt: new Date(now).toISOString(),
    })
    .where(eq(sessions.id, session.id))
    .run();
  writeSessionCookie(c, config.NODE_ENV, config.BASE_PATH, session.id, Math.floor((next - now) / 1000));
}

export function logDefaultAdmins(authConfig: AuthConfig, logger: Logger) {
  if (authConfig.defaultAdmins.length > 0) {
    logger.info(`Default admin configured: ${authConfig.defaultAdmins.join(", ")}`);
  }
}

// --- AuthProvider implementation (registered with the shared middleware) ---

/**
 * Resolves the request's session-cookie-bound user, extending the session
 * while it is in use. An expired session is deleted; it is never revived
 * through the IdP's refresh token.
 */
export async function oauthSessionAuthProvider(db: AppDatabase, c: Context<AppEnv>): Promise<User | undefined> {
  const config = c.get("config");
  const sessionId = readSessionId(c);

  if (!sessionId)
    return undefined;

  const result = await getSessionWithUser(db, sessionId);
  if (!result) {
    clearSessionCookie(c, config.NODE_ENV, config.BASE_PATH);
    return undefined;
  }

  const { session, user } = result;

  if (user.status === "disabled" || isSessionExpired(session)) {
    await deleteSession(db, sessionId);
    clearSessionCookie(c, config.NODE_ENV, config.BASE_PATH);
    return undefined;
  }

  await renewSessionIfDue(db, c, session);
  return user;
}
