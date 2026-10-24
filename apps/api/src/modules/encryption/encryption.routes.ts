import type { Context } from "hono";
import type { EncryptionState } from "./state";
import type { AppEnv } from "@/shared/lib/types";
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { eciesDecrypt, hexToBytes } from "@app/shared";
import { Hono } from "hono";
import { z } from "zod";
import { audit, auditMeta } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { __resetRateLimitForTests, consumeRateLimit } from "@/shared/middleware/rate-limit";
import { changeMasterKey, initEncryption, rotateDek, unlockSystem } from "./encryption.service";
import { readEncryptionMeta } from "./meta";

const initSchema = z.object({
  // The bootstrap-token generator emits exactly 64 hex chars
  // (`randomBytes(32).toString("hex")`). Restricting the schema to the
  // exact alphabet narrows the input surface and makes accidental
  // base64 / utf-8 paste mistakes fail fast at the boundary instead of
  // burning a hash compare.
  bootstrapToken: z.string().length(64).regex(/^[0-9a-f]{64}$/),
  publicKey: z.string().min(66).max(200),
  kdfSalt: z.string().length(64).regex(/^[0-9a-f]{64}$/).optional(),
});

const unlockSchema = z.object({
  challengeId: z.string().uuid(),
  encryptedDek: z.string().min(1),
});

// Both rotate-dek and change-master require the DEK via challenge-response.
// The DEK exists in server memory only for the duration of the operation.
const dekChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  encryptedDek: z.string().min(1),
});

const changeMasterSchema = dekChallengeSchema.extend({
  publicKey: z.string().min(66).max(200),
  kdfSalt: z.string().length(64).regex(/^[0-9a-f]{64}$/).optional(),
});

// --- Per-IP rate limiters for the encryption flows ---
// /unlock-challenge (which mints an ECIES keypair and exposes kdfSalt +
// encryptedDek) and /unlock (which consumes a challenge) share one bucket
// per IP, so an attacker cannot rotate between the two endpoints. The
// anonymous-IP fallback shares a single bucket so callers behind a
// misconfigured proxy cannot evade the gate by churning through `unknown`.
//
// Counting is the shared fixed-window implementation in
// `shared/middleware/rate-limit.ts`; these wrappers only turn a refusal
// into the 429 shape this module's routes return.

const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const UNLOCK_MAX_ATTEMPTS = 10;

// /encryption/init rate limit: 5 attempts per 15 minutes per IP.
const INIT_WINDOW_MS = 15 * 60 * 1000;
const INIT_MAX_ATTEMPTS = 5;

// /encryption/status rate limit: 60 requests per minute per IP.
const STATUS_WINDOW_MS = 60 * 1000;
const STATUS_MAX_ATTEMPTS = 60;

function rateLimitKey(c: Context<AppEnv>): string {
  // Defers to `getClientIp`, which honours `TRUST_PROXY=true` (X-Real-IP /
  // right-most X-Forwarded-For). Required so a proxy fronting the API does
  // not collapse all callers onto a single bucket and starve legitimate ones.
  return getClientIp(c, c.get("config"));
}

/**
 * Test-only: drop the in-memory attempt buckets. Without this, the
 * 10/15-min cap leaks across tests that share the `anon` fallback bucket.
 */
export function __resetUnlockRateLimitForTests(): Promise<void> {
  return __resetRateLimitForTests();
}

async function guard(
  c: Context<AppEnv>,
  bucket: string,
  ip: string,
  windowMs: number,
  max: number,
  message: string,
): Promise<void> {
  const retryAfter = await consumeRateLimit({ bucket, key: ip, windowMs, max });
  if (retryAfter === 0)
    return;
  // RFC 9110 SS10.2.3 - surface seconds until reset so the SPA can render an
  // unlock countdown instead of inviting click-spam.
  c.header("Retry-After", String(retryAfter));
  throw new AppError(message, 429, "RATE_LIMITED");
}

function checkUnlockRateLimit(c: Context<AppEnv>, ip: string): Promise<void> {
  return guard(c, "encryption-unlock", ip, UNLOCK_WINDOW_MS, UNLOCK_MAX_ATTEMPTS, "Too many unlock attempts. Try again later.");
}

function checkInitRateLimit(c: Context<AppEnv>, ip: string): Promise<void> {
  return guard(c, "encryption-init", ip, INIT_WINDOW_MS, INIT_MAX_ATTEMPTS, "Too many init attempts. Try again later.");
}

function checkStatusRateLimit(c: Context<AppEnv>, ip: string): Promise<void> {
  return guard(c, "encryption-status", ip, STATUS_WINDOW_MS, STATUS_MAX_ATTEMPTS, "Too many status requests. Try again later.");
}

/**
 * Best-effort audit fallback for cases where the live db handle is closed
 * (e.g. mid-DEK-rotation). Appends a single JSON line to
 * `<DATA_DIR>/audit-fallback.jsonl`. We never throw from here — this is
 * strictly observability of last resort.
 */
function appendAuditFallback(dataDir: string, payload: Record<string, unknown>): void {
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = `${dataDir}/audit-fallback.jsonl`;
    const line = `${JSON.stringify({
      ...payload,
      ts: new Date().toISOString(),
    })}\n`;
    // appendFileSync respects the existing file's mode; on first creation we
    // explicitly open with 0o600 to keep audit chatter from any other reader
    // on the same data dir. Subsequent appends inherit those bits.
    appendFileSync(file, line, { mode: 0o600 });
  }
  catch {
    // Silent — the operator already lost the db; surfacing this would just
    // confuse the failure path.
  }
}

const DEK_HEX_RE = /^[0-9a-f]{64}$/;

/** Validate DEK is 64 lowercase hex characters. */
function validateDekHex(dek: string): void {
  if (!DEK_HEX_RE.test(dek)) {
    throw new AppError("Invalid DEK format", 400, "INVALID_DEK");
  }
}

/**
 * Decrypt a DEK from a challenge-response payload.
 * The client re-encrypts the DEK with the server's ephemeral public key;
 * this function decrypts it using the corresponding ephemeral private key.
 * Returns the plaintext DEK hex string.
 */
async function decryptDekFromChallenge(state: EncryptionState, challengeId: string, encryptedDekHex: string): Promise<string> {
  const ephPrivKey = state.consumeChallenge(challengeId);
  if (!ephPrivKey) {
    throw new AppError("Challenge expired or invalid. Refresh and try again.", 400, "INVALID_CHALLENGE");
  }
  const encryptedBytes = hexToBytes(encryptedDekHex);
  const dekBytes = await eciesDecrypt(ephPrivKey, encryptedBytes);
  const dekHex = Array.from(dekBytes, b => b.toString(16).padStart(2, "0")).join("");
  validateDekHex(dekHex);
  return dekHex;
}

/**
 * Anonymous status endpoint. Returns only the boot state — no kdfSalt,
 * no encryptedDek, no dekVersion, no challenge. The unlock wizard fetches
 * those via POST /encryption/unlock-challenge (rate-limited).
 */
export function encryptionStatusRoute() {
  const router = new Hono<AppEnv>();

  router.get(
    "/encryption/status",
    describeRoute({
      tags: [TAGS.Encryption],
      summary: "Encryption boot status",
      description: "Anonymous boot-state probe (initialized / locked / status). Per-IP rate limited.",
      responses: {
        ...jsonOk(z.object({
          initialized: z.boolean(),
          locked: z.boolean(),
          status: z.string(),
          dbError: z.string().nullable(),
          unhealthy: z.boolean(),
          homePage: z.enum(["off", "base", "root"]),
        }), "Boot status"),
        ...errors(429),
      },
    }),
    async (c) => {
      await checkStatusRateLimit(c, rateLimitKey(c));

      const enc = c.get("encryption");
      const status = enc.getStatus();

      // Bootstrap token is intentionally NOT returned here even in dev. Any
      // process able to make HTTP requests to loopback (a browser extension,
      // a co-tenant test runner, a curl pipe in a sibling shell) would
      // otherwise harvest it during the setup window. Operators read the
      // token from stderr or `<data dir>/bootstrap-token.txt` — both go
      // away once `/encryption/init` succeeds.

      // `dbError` is the operator-facing message rendered on the locked-DB
      // splash; it is only ever set with internal, known-safe strings (e.g.
      // "DEK rotation failed"). `unhealthy` is the boolean view for callers
      // that don't need the human label.
      const dbError = enc.getDbError();
      return c.json({
        success: true,
        data: {
          initialized: enc.isInitialized(),
          locked: status === "locked",
          status,
          dbError,
          unhealthy: dbError !== null,
          // Rides on the first request the SPA makes, which is how it learns
          // what to render at "/" (see HOME_PAGE).
          homePage: c.get("config").HOME_PAGE,
        },
      });
    },
  );

  return router;
}

/** Routes available even when system is locked (no session auth; bootstrap-token / rate-limit gated where needed). */
export function encryptionPublicRoutes() {
  const router = new Hono<AppEnv>();

  // POST /encryption/unlock-challenge — return the materials the SPA needs to
  // perform an unlock attempt: a fresh ECIES challenge bound to this caller plus
  // the persisted kdfSalt and encryptedDek. Only meaningful while locked. Per-IP
  // rate-limited so anonymous probing cannot exhaust challenge slots or harvest
  // the salt + encrypted DEK.
  router.post(
    "/encryption/unlock-challenge",
    describeRoute({
      tags: [TAGS.Encryption],
      summary: "Mint an unlock challenge",
      description: "Returns a fresh ECIES challenge plus the persisted kdfSalt and encryptedDek. Only valid while locked. Per-IP rate limited.",
      responses: {
        ...jsonOk(z.object({
          challenge: z.unknown(),
          encryptedDek: z.string(),
          kdfSalt: z.string(),
        }), "Unlock materials"),
        ...errors(409, 429, 500, 503),
      },
    }),
    async (c) => {
      const enc = c.get("encryption");
      const status = enc.getStatus();
      if (status !== "locked") {
        throw new AppError("System is not locked", 409, "NOT_LOCKED");
      }
      if (enc.getDbError()) {
        throw new AppError("Database is in an error state", 503, "DB_ERROR");
      }

      await checkUnlockRateLimit(c, rateLimitKey(c));

      const config = c.get("config");
      const meta = readEncryptionMeta(config.DB_PATH);
      if (!meta) {
        throw new AppError("Encryption metadata missing", 500, "NO_META");
      }

      let challenge: ReturnType<typeof enc.createChallenge>;
      try {
        challenge = enc.createChallenge(rateLimitKey(c));
      }
      catch (err) {
        // createChallenge throws when the global / per-IP slot pool is full.
        // Surface as 429 with Retry-After so the client backs off instead of
        // 500-ing the user.
        c.header("Retry-After", String(60));
        throw new AppError(
          err instanceof Error
            ? err.message
            : "Too many pending challenges",
          429,
          "RATE_LIMITED",
        );
      }
      return c.json({
        success: true,
        data: {
          challenge,
          encryptedDek: meta.encryptedDek,
          kdfSalt: meta.kdfSalt,
        },
      });
    },
  );

  // POST /encryption/init — first-time setup (only when uninitialized)
  // Requires a bootstrap token to prevent anonymous takeover.
  router.post(
    "/encryption/init",
    describeRoute({
      tags: [TAGS.Encryption],
      summary: "First-time encryption setup",
      description: "Initialize encryption with a master public key. Bootstrap-token gated; only valid while uninitialized. Per-IP rate limited.",
      responses: {
        ...jsonOk(z.unknown(), "Initialized"),
        ...errors(403, 409, 422, 429, 500),
      },
    }),
    validator("json", initSchema),
    async (c) => {
      const enc = c.get("encryption");
      if (enc.isInitialized()) {
        throw new AppError("Encryption already initialized", 409, "ALREADY_INITIALIZED");
      }

      await checkInitRateLimit(c, rateLimitKey(c));

      const config = c.get("config");
      const body = c.req.valid("json");

      // Verify bootstrap token. Hash both sides to a fixed-length 32-byte
      // digest before timingSafeEqual so the underlying memcmp cannot leak
      // length information.
      const expected = enc.getBootstrapToken();
      if (!expected) {
        throw new AppError("Bootstrap token not configured", 500, "NO_BOOTSTRAP_TOKEN");
      }
      const provided = createHash("sha256").update(body.bootstrapToken).digest();
      const expectedHash = createHash("sha256").update(expected).digest();
      if (!timingSafeEqual(provided, expectedHash)) {
        throw new AppError("Invalid bootstrap token", 403, "INVALID_BOOTSTRAP_TOKEN");
      }

      if (!enc.beginOperation()) {
        throw new AppError("Initialization already in progress", 409, "OPERATION_IN_PROGRESS");
      }

      try {
        const result = await initEncryption(enc, config.DB_PATH, body.publicKey, body.kdfSalt);
        // Initialization succeeded — drop the one-time token and the sibling
        // bootstrap-token.txt file so they cannot be reused.
        try {
          const { rmSync } = await import("node:fs");
          const { dirname, resolve } = await import("node:path");
          rmSync(resolve(dirname(config.DB_PATH), "bootstrap-token.txt"), { force: true });
        }
        catch {
          // best-effort: file may not exist if init is rerun in dev
        }
        return c.json({ success: true, data: result });
      }
      catch (err) {
        // Map raw libsql / IO / crypto error text to a fixed code so the
        // anonymous setup caller never sees internal error strings. The full
        // message still goes to the structured logger.
        c.get("logger").error({ err }, "encryption.init failed");
        enc.setDbError("init_failed");
        throw new AppError("Initialization failed", 500, "INIT_FAILED");
      }
      finally {
        enc.endOperation();
      }
    },
  );

  // POST /encryption/unlock — provide re-encrypted DEK to unlock
  // The client decrypts the DEK with the master private key, then re-encrypts it
  // with the server's ephemeral public key. The DEK never travels as plaintext.
  // Bespoke: rate-limit runs BEFORE validation, and both before the operation
  // lock (see inline comment). `validator` middleware would reorder this, so we
  // keep the manual `unlockSchema.parse(...)` and document with describeRoute only.
  router.post(
    "/encryption/unlock",
    describeRoute({
      tags: [TAGS.Encryption],
      summary: "Unlock the system",
      description: "Submit the re-encrypted DEK to unlock. Only valid while locked. Per-IP rate limited.",
      responses: {
        ...jsonOk(z.object({
          status: z.literal("unlocked"),
        }), "Unlocked"),
        ...errors(400, 403, 409, 429, 500),
      },
    }),
    async (c) => {
      const enc = c.get("encryption");
      const status = enc.getStatus();
      if (status === "uninitialized") {
        throw new AppError("Encryption not initialized", 400, "NOT_INITIALIZED");
      }
      if (status === "unlocked") {
        throw new AppError("System already unlocked", 409, "ALREADY_UNLOCKED");
      }

      // Rate-limit + parse + zod-validate BEFORE acquiring the operation lock.
      // The previous order let an anonymous attacker grab the latch by
      // submitting malformed JSON: every failed parse left the lock held until
      // the next handler ran `endOperation()`.
      await checkUnlockRateLimit(c, rateLimitKey(c));
      const config = c.get("config");
      const body = unlockSchema.parse(await c.req.json());

      if (!enc.beginOperation()) {
        throw new AppError("Unlock already in progress", 409, "OPERATION_IN_PROGRESS");
      }

      try {
        const dekHex = await decryptDekFromChallenge(enc, body.challengeId, body.encryptedDek);
        await unlockSystem(enc, config.DB_PATH, dekHex);
        return c.json({
          success: true,
          data: { status: "unlocked" },
        });
      }
      catch (err) {
        if (err instanceof AppError)
          throw err;
        const msg = err instanceof Error
          ? err.message
          : String(err);
        if (msg.includes("Invalid decryption key") || msg.includes("cannot open database")) {
          throw new AppError("Invalid decryption key", 403, "INVALID_KEY");
        }
        // Map raw libsql / IO error text to a fixed code so anonymous callers
        // hitting /encryption/status never see internal error strings. The full
        // message still goes to the structured logger.
        c.get("logger").error({ err }, "encryption unlock: db error");
        enc.setDbError("unlock_failed");
        throw new AppError("Database error", 500, "DB_ERROR");
      }
      finally {
        enc.endOperation();
      }
    },
  );

  return router;
}

/** Routes that require the system to be unlocked (auth required). */
export function encryptionProtectedRoutes() {
  const router = new Hono<AppEnv>();

  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/encryption/challenge/*", authRequired);
  router.use("/encryption/change-master/*", authRequired);
  router.use("/encryption/meta/*", authRequired);
  router.use("/encryption/rotate-dek/*", authRequired);
  // POST /encryption/challenge — create an ephemeral challenge for admin operations
  // (rotate-dek, change-master). The client encrypts the DEK with the returned
  // ephemeral public key and sends it back in the subsequent operation request.
  router.post(
    "/encryption/challenge",
    describeRoute({
      tags: [TAGS.Encryption],
      summary: "Create an admin operation challenge",
      description: "Mint an ephemeral ECIES challenge for admin operations (rotate-dek, change-master). Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Challenge"),
        ...errors(401, 403, 429),
      },
    }),
    adminRequired,
    (c) => {
      const enc = c.get("encryption");
      let challenge: ReturnType<typeof enc.createChallenge>;
      try {
        challenge = enc.createChallenge(rateLimitKey(c));
      }
      catch (err) {
        // createChallenge throws when the global / per-IP slot pool is full.
        // Surface as 429 with Retry-After so the client backs off instead of
        // 500-ing the user.
        c.header("Retry-After", String(60));
        throw new AppError(
          err instanceof Error
            ? err.message
            : "Too many pending challenges",
          429,
          "RATE_LIMITED",
        );
      }
      return c.json({ success: true, data: challenge });
    },
  );

  // GET /encryption/meta — return encryptedDek + kdfSalt for authenticated admins only
  router.get(
    "/encryption/meta",
    describeRoute({
      tags: [TAGS.Encryption],
      summary: "Get encryption metadata",
      description: "Return the persisted encryptedDek + kdfSalt. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          encryptedDek: z.string().nullable(),
          kdfSalt: z.string().nullable(),
        }), "Encryption metadata"),
        ...errors(401, 403),
      },
    }),
    adminRequired,
    (c) => {
      const config = c.get("config");
      const meta = readEncryptionMeta(config.DB_PATH);
      return c.json({
        success: true,
        data: {
          encryptedDek: meta?.encryptedDek ?? null,
          kdfSalt: meta?.kdfSalt ?? null,
        },
      });
    },
  );

  // POST /encryption/rotate-dek — rotate the data encryption key.
  // Requires DEK via challenge-response; DEK is only in memory during rotation.
  //
  // EXPERIMENTAL: this path is known to hit `SQLITE_IOERR` under libsql when
  // the WAL is busy. See docs/modules/encryption.md. Production operators
  // should prefer `/encryption/change-master` (re-wraps the same DEK with a
  // new master pubkey, no row rewrite) until this is resolved.
  //
  // Gated by `ENABLE_EXPERIMENTAL_DEK_ROTATION` (default false) so an
  // accidental admin call can't kick off a long-running rewrite that
  // hits the known IOERR mid-flight.
  // Bespoke: body is parsed INSIDE the operation lock / try-finally so a bad
  // payload still flows through endOperation() and the failure-audit path.
  // `validator` middleware would short-circuit before the lock, so we keep the
  // manual `dekChallengeSchema.parse(...)` and document with describeRoute only.
  router.post(
    "/encryption/rotate-dek",
    describeRoute({
      tags: [TAGS.Encryption],
      summary: "Rotate the data encryption key",
      description: "Experimental, admin-only DEK rotation via challenge-response. Gated by ENABLE_EXPERIMENTAL_DEK_ROTATION; returns 503 when locked.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Rotation result"),
        ...errors(401, 403, 409, 500, 503),
      },
    }),
    adminRequired,
    async (c) => {
      const config = c.get("config");
      const enc = c.get("encryption");
      if (!config.ENABLE_EXPERIMENTAL_DEK_ROTATION) {
        throw new AppError(
          "DEK rotation is experimental and disabled. Set ENABLE_EXPERIMENTAL_DEK_ROTATION=true to opt in.",
          501,
          "NOT_IMPLEMENTED",
        );
      }
      if (!enc.isUnlocked()) {
        throw new AppError("System is locked", 503, "SYSTEM_LOCKED");
      }
      if (!enc.beginOperation()) {
        throw new AppError("Encryption operation already in progress", 409, "OPERATION_IN_PROGRESS");
      }

      const db = c.get("db");
      const user = c.get("user")!;

      try {
        const body = dekChallengeSchema.parse(await c.req.json());

        // Audit BEFORE rotation runs: rotateDek closes the live db handle and
        // hot-swaps the app, so this in-flight request cannot write to the db
        // afterwards. Failure is logged via the system logger because there is
        // no usable db handle inside the catch block once rename has happened.
        await audit(db, c.get("logger"), {
          actorId: user.id,
          actorName: user.name,
          action: "encryption.dek_rotation_started",
          resourceType: "encryption",
          resourceId: "dek",
          resourceName: "data-encryption-key",
          ...auditMeta(c),
          result: "success",
        });

        const currentDek = await decryptDekFromChallenge(enc, body.challengeId, body.encryptedDek);
        const result = await rotateDek(enc, config.DB_PATH, db, currentDek);
        return c.json({ success: true, data: result });
      }
      catch (err) {
        c.get("logger")?.error({ err }, "encryption.dek_rotation_failed");
        // Best-effort failure audit. By the time we land here the live db
        // handle may already be closed (rotateDek swaps it mid-flight), so
        // we try the db path first and fall back to a flat-file journal next
        // to the database. Either path is tolerant of the other being broken.
        const errorMessage = err instanceof Error
          ? err.message
          : String(err);
        const failurePayload = {
          actorId: user.id,
          actorName: user.name,
          action: "encryption.dek_rotation_failed" as const,
          resourceType: "encryption",
          resourceId: "dek",
          resourceName: "data-encryption-key",
          detail: { error: errorMessage },
          ...auditMeta(c),
          result: "failure" as const,
        };
        // audit() swallows db-write errors and returns undefined on failure,
        // which is exactly the case (closed db handle) where we want the
        // fallback journal to take over.
        const auditId = await audit(db, c.get("logger"), failurePayload).catch(() => undefined);
        if (!auditId) {
          appendAuditFallback(dirname(config.DB_PATH), failurePayload);
        }
        if (err instanceof AppError)
          throw err;
        // The audit `detail` above keeps the underlying message for admin
        // forensics, but the response body must not echo libsql / IO error
        // strings back to the client — return a fixed string and rely on the
        // structured logger + audit row for triage.
        throw new AppError("DEK rotation failed", 500, "ROTATE_FAILED");
      }
      finally {
        enc.endOperation();
      }
    },
  );

  // POST /encryption/change-master — change master public key
  // Requires DEK via challenge-response; DEK is only in memory during re-encryption.
  // Bespoke: body is parsed INSIDE the operation lock / try-finally so a bad
  // payload still flows through endOperation(). `validator` middleware would
  // short-circuit before the lock, so we keep the manual
  // `changeMasterSchema.parse(...)` and document with describeRoute only.
  router.post(
    "/encryption/change-master",
    describeRoute({
      tags: [TAGS.Encryption],
      summary: "Change the master public key",
      description: "Re-wrap the DEK under a new master public key via challenge-response. Admin only; returns 503 when locked.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.unknown(), "Change result"),
        ...errors(401, 403, 409, 500, 503),
      },
    }),
    adminRequired,
    async (c) => {
      const enc = c.get("encryption");
      if (!enc.isUnlocked()) {
        throw new AppError("System is locked", 503, "SYSTEM_LOCKED");
      }
      if (!enc.beginOperation()) {
        throw new AppError("Encryption operation already in progress", 409, "OPERATION_IN_PROGRESS");
      }

      const config = c.get("config");
      const db = c.get("db");
      const user = c.get("user")!;

      try {
        const body = changeMasterSchema.parse(await c.req.json());
        const currentDek = await decryptDekFromChallenge(enc, body.challengeId, body.encryptedDek);
        const result = await changeMasterKey(config.DB_PATH, body.publicKey, currentDek, body.kdfSalt);

        await audit(db, c.get("logger"), {
          actorId: user.id,
          actorName: user.name,
          action: "encryption.master_changed",
          resourceType: "encryption",
          resourceId: "master-key",
          resourceName: "master-key",
          ...auditMeta(c),
          result: "success",
        });

        return c.json({ success: true, data: result });
      }
      catch (err) {
        if (err instanceof AppError)
          throw err;
        c.get("logger").error({ err }, "encryption.change_master failed");
        throw new AppError("Master key change failed", 500, "CHANGE_MASTER_FAILED");
      }
      finally {
        enc.endOperation();
      }
    },
  );

  return router;
}
