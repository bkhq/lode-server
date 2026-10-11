/**
 * In-memory encryption state controller.
 *
 * The DEK (Data Encryption Key) is NEVER retained in process memory after use.
 * After unlock, the DEK is passed to the onUnlock callback (which opens the DB)
 * and immediately discarded. For admin operations that need the DEK (rotate,
 * change-master), the client must re-provide it via challenge-response — the DEK
 * exists in server memory only for the duration of that single operation.
 *
 * Encapsulated in a class so the bootstrap thread can hand a single instance to
 * `app.ts` via `c.var.encryption` rather than calling free functions that read
 * from a module-level singleton. The previous module-level state forced every
 * test to `__resetEncryptionStateForTests()` and made parallel test execution
 * unsafe.
 */
import { generateKeyPair } from "@app/shared";

export type EncryptionStatus = "uninitialized" | "locked" | "unlocked" | "disabled";

export type DbErrorCode
  = | "unlock_failed"
    | "rotation_failed"
    | "init_failed"
    | "io_error"
    | "internal_error";

interface Challenge {
  /** Hex-encoded ephemeral private key (server-side only). */
  readonly privateKey: string;
  /** Hex-encoded ephemeral public key (sent to client). */
  readonly publicKey: string;
  /** Expiry timestamp (ms). */
  readonly expiresAt: number;
  /** Issuing client IP — used for the per-IP outstanding-challenge cap. */
  readonly ip: string;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CHALLENGES = 100;
// Per-IP cap stops a single attacker from occupying the global slot pool
// during the 5-minute TTL and starving legitimate operators. The cap sits
// above the unlock-flow limiter (UNLOCK_MAX_ATTEMPTS = 10) so it never
// pre-empts that gate, while still keeping any one peer under a third of
// the global pool. Two attackers from distinct IPs cannot both fill 100
// slots either; the global cap remains the ceiling.
const MAX_CHALLENGES_PER_IP = 30;

export class EncryptionState {
  /** Whether the system has been unlocked (DB is open). DEK is NOT stored. */
  private unlocked = false;
  /** Whether encryption has been initialized (meta file exists). */
  private initialized = false;
  /** Whether an unlock or init operation is in progress. */
  private operationInProgress = false;
  /** Callback to invoke when the system is unlocked. */
  private onUnlock: ((dek: string) => void | Promise<void>) | null = null;
  /** Whether DB encryption is disabled via DB_ENCRYPTION=false. */
  private encryptionDisabled = false;
  /**
   * Last DB error code (startup or unlock failure). Fixed enum so we never
   * echo libsql / IO error strings to anonymous /encryption/status callers.
   */
  private dbError: DbErrorCode | null = null;
  /** One-time token published during setup mode for /encryption/init. */
  private bootstrapToken: string | null = null;
  /** Ephemeral ECIES challenge store for secure unlock transport. */
  private readonly challenges = new Map<string, Challenge>();

  // ─── Bootstrap token ───

  setBootstrapToken(token: string): void {
    this.bootstrapToken = token;
  }

  getBootstrapToken(): string | null {
    return this.bootstrapToken;
  }

  // ─── Encryption mode ───

  setEncryptionDisabled(v: boolean): void {
    this.encryptionDisabled = v;
    if (v) {
      this.unlocked = true;
    }
  }

  isEncryptionDisabled(): boolean {
    return this.encryptionDisabled;
  }

  // ─── Initialization flag ───

  setInitialized(v: boolean): void {
    this.initialized = v;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ─── DEK unlock flow ───

  /**
   * Mark the system as unlocked and (re)open the live database with the given
   * DEK. The callback stays registered so that DEK rotation can re-fire it to
   * rebuild the app context with a fresh database handle. The DEK itself is
   * NOT retained in memory — admin operations that need it receive it via
   * challenge-response.
   */
  async setDek(dek: string): Promise<void> {
    if (!this.operationInProgress) {
      throw new Error("setDek called without beginOperation");
    }
    const callback = this.onUnlock;
    if (callback) {
      await callback(dek);
    }
    this.unlocked = true;
  }

  setOnUnlock(cb: (dek: string) => void | Promise<void>): void {
    this.onUnlock = cb;
  }

  // ─── Operation lock ───

  /** Try to acquire the operation lock. Returns true if acquired. */
  beginOperation(): boolean {
    if (this.operationInProgress)
      return false;
    this.operationInProgress = true;
    return true;
  }

  /** Release the operation lock. */
  endOperation(): void {
    this.operationInProgress = false;
  }

  // ─── Status queries ───

  isUnlocked(): boolean {
    return this.unlocked;
  }

  isSystemLocked(): boolean {
    return this.initialized && !this.unlocked;
  }

  setDbError(code: DbErrorCode | null): void {
    this.dbError = code;
  }

  getDbError(): DbErrorCode | null {
    return this.dbError;
  }

  getStatus(): EncryptionStatus {
    if (this.encryptionDisabled)
      return "disabled";
    if (!this.initialized)
      return "uninitialized";
    if (!this.unlocked)
      return "locked";
    return "unlocked";
  }

  // ─── Ephemeral challenge store ───

  /** Create a new ephemeral challenge for the unlock flow. Returns challengeId + publicKey. */
  createChallenge(ip: string = "anon"): { challengeId: string; ephemeralPublicKey: string } {
    this.pruneExpiredChallenges();

    if (this.challenges.size >= MAX_CHALLENGES) {
      throw new Error("Too many pending challenges. Try again later.");
    }

    let perIp = 0;
    for (const ch of this.challenges.values()) {
      if (ch.ip === ip)
        perIp++;
    }
    if (perIp >= MAX_CHALLENGES_PER_IP) {
      throw new Error("Too many pending challenges from this client. Try again later.");
    }

    const kp = generateKeyPair();
    const challengeId = crypto.randomUUID();

    this.challenges.set(challengeId, {
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
      ip,
    });

    return { challengeId, ephemeralPublicKey: kp.publicKey };
  }

  /** Consume a challenge by its ID. Returns the ephemeral private key, or null if expired/missing. */
  consumeChallenge(challengeId: string): string | null {
    const challenge = this.challenges.get(challengeId);
    if (!challenge)
      return null;

    if (Date.now() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      return null;
    }

    this.challenges.delete(challengeId);
    return challenge.privateKey;
  }

  private pruneExpiredChallenges(): void {
    const now = Date.now();
    for (const [id, ch] of this.challenges) {
      if (now > ch.expiresAt)
        this.challenges.delete(id);
    }
  }
}
