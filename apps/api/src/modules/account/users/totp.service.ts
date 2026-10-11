import type { AppDatabase } from "@/db";
import type { LockoutPolicy, LockoutState } from "@/modules/account/auth/lockout.service";
import { randomBytes } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { Secret, TOTP } from "otpauth";
import * as QRCode from "qrcode";
import { clearAllLockouts, clearFailures, isLocked, recordFailure } from "@/modules/account/auth/lockout.service";
import { totpChallenges, userTotpDevices } from "@/modules/account/users/schema";
import { getPlatform } from "@/platform";
import { nanoid } from "@/shared/lib/id";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Issuer string baked into the TOTP otpauth:// URI — what authenticator
// apps display next to the code. Defaults to "App" so unit tests that
// don't thread config through still get a sensible label; the
// `createTotpDevice` route caller always passes the live
// `config.APP_DISPLAY_NAME`.
function createTotpInstance(secret: string, username: string, issuer = "App"): TOTP {
  return new TOTP({
    issuer,
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

// ── Device management ──

export async function listTotpDevices(db: AppDatabase, userId: string) {
  return await db
    .select({
      id: userTotpDevices.id,
      name: userTotpDevices.name,
      verified: userTotpDevices.verified,
      createdAt: userTotpDevices.createdAt,
    })
    .from(userTotpDevices)
    .where(eq(userTotpDevices.userId, userId))
    .all();
}

export async function createTotpDevice(db: AppDatabase, userId: string, name: string, username: string, issuer?: string) {
  const secret = new Secret({ size: 20 });
  const id = nanoid();
  const now = new Date().toISOString();

  await db.insert(userTotpDevices).values({
    id,
    userId,
    name,
    secret: secret.base32,
    verified: false,
    createdAt: now,
  }).run();

  const totp = createTotpInstance(secret.base32, username, issuer);
  const uri = totp.toString();
  const qrCode = await QRCode.toDataURL(uri);

  return { id, name, secret: secret.base32, uri, qrCode };
}

export async function confirmTotpDevice(db: AppDatabase, deviceId: string, userId: string, code: string): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const device = await tx.select().from(userTotpDevices).where(
      and(eq(userTotpDevices.id, deviceId), eq(userTotpDevices.userId, userId)),
    ).get();

    if (!device || device.verified)
      return false;

    const totp = createTotpInstance(device.secret, "");
    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null)
      return false;

    // RFC 6238 §5.2 — reject replay of a code at the same/earlier timestep.
    const usedTimestep = Math.floor(Date.now() / 30000) + delta;
    if (usedTimestep <= device.lastUsedTimestep)
      return false;

    await tx.update(userTotpDevices)
      .set({ verified: true, lastUsedTimestep: usedTimestep })
      .where(eq(userTotpDevices.id, deviceId))
      .run();

    return true;
  });
}

export async function deleteTotpDevice(db: AppDatabase, deviceId: string, userId: string): Promise<boolean> {
  const device = await db.select().from(userTotpDevices).where(
    and(eq(userTotpDevices.id, deviceId), eq(userTotpDevices.userId, userId)),
  ).get();

  if (!device)
    return false;

  await db.delete(userTotpDevices).where(eq(userTotpDevices.id, deviceId)).run();
  return true;
}

// ── Verification ──

/**
 * Per-user TOTP failure tracker. The IP-keyed limiter on
 * /account/auth/totp-verify caps brute-force from one IP, but a
 * determined attacker rotating IPs can still grind a single user. Lock
 * the *user* after N consecutive failures and force them to restart the
 * OAuth flow (which mints a new TOTP challenge and resets the counter).
 *
 * State lives in the persistent `auth_lockouts` table so it survives a
 * process restart and is shared across replicas. See
 * `apps/api/src/modules/account/auth/lockout.service.ts`.
 */
const TOTP_USER_LOCKOUT_POLICY: LockoutPolicy = {
  threshold: 5,
  windowMs: 15 * 60 * 1000,
};

function totpLockoutKey(userId: string): string {
  return `totp:${userId}`;
}

export async function isTotpUserLocked(db: AppDatabase, userId: string): Promise<LockoutState> {
  return isLocked(db, totpLockoutKey(userId));
}

async function recordTotpFailure(db: AppDatabase, userId: string): Promise<LockoutState> {
  return recordFailure(db, totpLockoutKey(userId), TOTP_USER_LOCKOUT_POLICY);
}

async function recordTotpSuccess(db: AppDatabase, userId: string): Promise<void> {
  await clearFailures(db, totpLockoutKey(userId));
}

/** Test hook — drop every persisted lockout row between specs. */
export async function __resetTotpFailureTrackerForTests(db: AppDatabase): Promise<void> {
  await clearAllLockouts(db);
}

export async function hasVerifiedTotp(db: AppDatabase, userId: string): Promise<boolean> {
  const device = await db.select({ id: userTotpDevices.id }).from(userTotpDevices).where(
    and(eq(userTotpDevices.userId, userId), eq(userTotpDevices.verified, true)),
  ).get();
  return !!device;
}

export async function verifyTotpCode(db: AppDatabase, userId: string, code: string): Promise<boolean> {
  // Refuse before talking to the DB when the user is rate-limited; the
  // caller still gets `false` and treats it as a verification failure.
  if ((await isTotpUserLocked(db, userId)).locked)
    return false;

  const ok = await db.transaction(async (tx) => {
    const devices = await tx.select().from(userTotpDevices).where(
      and(eq(userTotpDevices.userId, userId), eq(userTotpDevices.verified, true)),
    ).all();

    for (const device of devices) {
      const totp = createTotpInstance(device.secret, "");
      const delta = totp.validate({ token: code, window: 1 });
      if (delta === null)
        continue;

      // RFC 6238 §5.2 — same code (or earlier window) cannot be redeemed twice.
      const usedTimestep = Math.floor(Date.now() / 30000) + delta;
      if (usedTimestep <= device.lastUsedTimestep)
        continue;

      await tx.update(userTotpDevices)
        .set({ lastUsedTimestep: usedTimestep })
        .where(eq(userTotpDevices.id, device.id))
        .run();
      return true;
    }

    return false;
  });

  if (ok)
    await recordTotpSuccess(db, userId);
  else
    await recordTotpFailure(db, userId);
  return ok;
}

// ── Login TOTP challenge ──

export async function createTotpChallenge(
  db: AppDatabase,
  userId: string,
  accessToken: string,
  refreshToken: string | undefined,
  expiresIn: number | undefined,
  redirectUri: string,
): Promise<string> {
  await cleanExpiredChallenges(db);

  const id = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  await db.insert(totpChallenges).values({
    id,
    userId,
    accessToken,
    refreshToken: refreshToken ?? null,
    expiresIn: expiresIn ?? null,
    redirectUri,
    expiresAt,
  }).run();

  return id;
}

export async function consumeTotpChallenge(db: AppDatabase, challengeId: string) {
  await cleanExpiredChallenges(db);

  const row = await db.select().from(totpChallenges).where(eq(totpChallenges.id, challengeId)).get();
  if (!row)
    return undefined;

  await db.delete(totpChallenges).where(eq(totpChallenges.id, challengeId)).run();

  return {
    userId: row.userId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresIn: row.expiresIn,
    redirectUri: row.redirectUri,
  };
}

async function cleanExpiredChallenges(db: AppDatabase) {
  await db.delete(totpChallenges).where(lte(totpChallenges.expiresAt, Date.now())).run();
}

// ── Step-up challenge token (for sensitive ops) ──

const STEP_UP_TTL_MS = 10 * 60 * 1000;

interface StepUpEntry {
  userId: string;
  expiresAt: number;
}

// Platform kv: in-process on Bun, a KV binding on Workers. TTL handles
// expiry on both.
function stepUpTokens() {
  return getPlatform().kv.namespace("step-up");
}

export async function issueStepUpToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await stepUpTokens().set(token, { userId, expiresAt: Date.now() + STEP_UP_TTL_MS } satisfies StepUpEntry, STEP_UP_TTL_MS);
  return token;
}

export async function validateStepUpToken(token: string, userId: string): Promise<boolean> {
  const store = stepUpTokens();
  const entry = await store.get<StepUpEntry>(token);
  if (!entry || entry.userId !== userId || entry.expiresAt <= Date.now()) {
    if (entry)
      await store.delete(token);
    return false;
  }
  // Single-use: consume on first successful validation.
  await store.delete(token);
  return true;
}
