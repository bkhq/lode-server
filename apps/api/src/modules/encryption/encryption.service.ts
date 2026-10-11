import type { EncryptionState } from "./state";
import type { AppDatabase } from "@/db";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { bytesToHex, eciesEncrypt, hexToBytes } from "@app/shared";
import { createClient } from "@libsql/client";
import { readEncryptionMeta, writeEncryptionMeta } from "./meta";

const DEK_LEN = 32; // AES-256
const RE_HEX_64 = /^[0-9a-f]{64}$/;

/** Generate a random DEK (hex-encoded). */
function generateDek(): string {
  return randomBytes(DEK_LEN).toString("hex");
}

/** Encrypt a DEK with the master public key using ECIES. Returns hex-encoded ciphertext. */
async function encryptDek(publicKeyHex: string, dekHex: string): Promise<string> {
  const dekBytes = hexToBytes(dekHex);
  const encrypted = await eciesEncrypt(publicKeyHex, dekBytes);
  return bytesToHex(encrypted);
}

/**
 * Initialize encryption for the first time.
 * - Generates a random DEK
 * - Encrypts DEK with the provided master public key
 * - If an unencrypted DB exists, migrates it to an encrypted one using libSQL
 * - Writes meta file
 * - Stores DEK in memory
 */
export async function initEncryption(state: EncryptionState, dbPath: string, publicKeyHex: string, kdfSalt?: string): Promise<{ dekVersion: number }> {
  if (state.isInitialized()) {
    throw new Error("Encryption already initialized");
  }

  const dek = generateDek();
  const encryptedDek = await encryptDek(publicKeyHex, dek);
  const now = new Date().toISOString();

  // If an unencrypted DB exists, migrate it to encrypted
  if (existsSync(dbPath)) {
    await migrateToEncrypted(dbPath, dek);
  }

  writeEncryptionMeta(dbPath, {
    masterPublicKey: publicKeyHex,
    encryptedDek,
    dekVersion: 1,
    initializedAt: now,
    kdfSalt: kdfSalt ?? null,
  });

  state.setInitialized(true);
  await state.setDek(dek);

  return { dekVersion: 1 };
}

/**
 * Unlock the system by providing the plaintext DEK.
 * Validates the DEK by trying to open the database with libSQL encryptionKey.
 */
export async function unlockSystem(state: EncryptionState, dbPath: string, dekHex: string): Promise<void> {
  if (!existsSync(dbPath)) {
    throw new Error("Database file not found");
  }

  // Validate DEK by opening the DB with encryptionKey
  const testClient = createClient({ url: `file:${dbPath}`, encryptionKey: dekHex });
  try {
    await testClient.execute("SELECT count(*) FROM sqlite_master");
  }
  catch {
    testClient.close();
    throw new Error("Invalid decryption key — cannot open database");
  }
  testClient.close();

  await state.setDek(dekHex);
}

/**
 * Rotate DEK: generate new DEK, re-encrypt DB, update meta.
 * Requires the system to be unlocked.
 *
 * libSQL does not support PRAGMA rekey, so we:
 * 1. Read all data from current encrypted db
 * 2. Create new db with new encryptionKey
 * 3. Copy all data
 * 4. Replace old file
 */
export async function rotateDek(state: EncryptionState, dbPath: string, currentDb: AppDatabase, currentDek: string): Promise<{ dekVersion: number }> {
  const meta = readEncryptionMeta(dbPath);
  if (!meta)
    throw new Error("Encryption not initialized");

  const newDek = generateDek();
  const tmpPath = `${dbPath}.rekey.tmp`;
  const bakPath = `${dbPath}.bak`;

  if (!RE_HEX_64.test(newDek)) {
    throw new Error("Invalid encryption key: expected 64-char lowercase hex string");
  }

  const snapPath = `${dbPath}.rekey.src`;

  // (a) Quiesce the live DB and copy from a private filesystem SNAPSHOT
  // rather than opening a second libsql client on the live path.
  //
  // The previous approach (checkpoint → close → fixed 200ms sleep →
  // copyDatabase reading the LIVE file while it is later renamed) raced
  // libsql's asynchronous WAL/SHM lock release and produced SQLITE_IOERR
  // under concurrent load — which left the live handle closed and bricked
  // every subsequent request (why the e2e was skipped).
  //
  // `wal_checkpoint(TRUNCATE)` folds the WAL into the main db file and
  // truncates the WAL to zero; after the handle is closed and the WAL has
  // drained, a plain `copyFileSync` of the single main file is a
  // consistent point-in-time image. `copyDatabase` then reads that
  // private snapshot — never the live path — so it cannot contend with
  // request handlers or the rename below. No second libsql client ever
  // touches the live file.
  await currentDb.checkpoint();
  currentDb.close();
  await waitForWalDrained(dbPath);

  try {
    if (existsSync(snapPath))
      unlinkSync(snapPath);
    cleanupWalShm(snapPath);
    copyFileSync(dbPath, snapPath);
    await copyDatabase(snapPath, currentDek, tmpPath, newDek);
  }
  catch (err) {
    // Nothing on disk has moved yet; clean up tmp + snapshot and rethrow.
    // The live db handle is already closed, so the caller must re-open
    // with the OLD dek to keep serving requests.
    if (existsSync(tmpPath))
      unlinkSync(tmpPath);
    if (existsSync(snapPath))
      unlinkSync(snapPath);
    cleanupWalShm(tmpPath);
    cleanupWalShm(snapPath);
    await reopenWithDek(state, currentDek);
    throw err;
  }
  if (existsSync(snapPath))
    unlinkSync(snapPath);
  cleanupWalShm(snapPath);

  // (b) Verify the tmp opens with the new key.
  try {
    const verifyClient = createClient({ url: `file:${tmpPath}`, encryptionKey: newDek });
    try {
      await verifyClient.execute("SELECT count(*) FROM sqlite_master");
    }
    finally {
      verifyClient.close();
    }
  }
  catch (err) {
    if (existsSync(tmpPath))
      unlinkSync(tmpPath);
    cleanupWalShm(tmpPath);
    await reopenWithDek(state, currentDek);
    throw new Error(`DEK rotation verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Point of no return ──
  // From here on, the live db file gets renamed to .bak. Any failure must
  // either restore from .bak and re-open with the OLD dek, or commit to the
  // new dek by atomically promoting the tmp file.
  try {
    // (c) Rename original main file → .bak (atomic on POSIX), drop -wal/-shm
    // (they are tied to the main file and become invalid once renamed).
    if (existsSync(dbPath)) {
      if (existsSync(bakPath))
        unlinkSync(bakPath);
      renameSync(dbPath, bakPath);
    }
    for (const suffix of ["-wal", "-shm"]) {
      const p = `${dbPath}${suffix}`;
      if (existsSync(p))
        unlinkSync(p);
    }
    renameSync(tmpPath, dbPath);
    cleanupWalShm(tmpPath);

    // (d) Update meta.db with the new encryptedDek and bumped version.
    const newEncryptedDek = await encryptDek(meta.masterPublicKey, newDek);
    const newVersion = meta.dekVersion + 1;
    writeEncryptionMeta(dbPath, {
      ...meta,
      encryptedDek: newEncryptedDek,
      dekVersion: newVersion,
    });

    // (e) Re-fire onUnlock so request handlers pick up a handle bound to the
    // freshly-rotated file with the new DEK.
    await state.setDek(newDek);

    // (f) Successful: drop the .bak and any leftover wal/shm of the OLD file.
    if (existsSync(bakPath))
      unlinkSync(bakPath);
    cleanupWalShm(bakPath);

    return { dekVersion: newVersion };
  }
  catch (err) {
    // Recovery: restore the .bak back to dbPath if possible, mark the system
    // as in error, and re-fire onUnlock with the OLD dek so request handlers
    // do not crash on a closed handle. We deliberately do NOT delete the .bak
    // so an operator can recover manually if rename-back fails.
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (existsSync(bakPath) && !existsSync(dbPath)) {
        renameSync(bakPath, dbPath);
      }
      await reopenWithDek(state, currentDek);
    }
    catch {
      // Best-effort. Keep the .bak in place either way.
    }
    state.setDbError("rotation_failed");
    throw new Error(`DEK rotation failed: ${message}`);
  }
}

/** Re-fire onUnlock with the supplied DEK so handlers see a fresh, open db. */
async function reopenWithDek(state: EncryptionState, dek: string): Promise<void> {
  try {
    await state.setDek(dek);
  }
  catch {
    // Best-effort: if reopen fails the caller has already marked the system
    // in error and the locked-state middleware will fence off requests.
  }
}

/**
 * Change master key: re-encrypt DEK with new public key.
 * Does NOT change the DEK itself — only who can decrypt it.
 */
export async function changeMasterKey(dbPath: string, newPublicKeyHex: string, currentDek: string, kdfSalt?: string): Promise<{ dekVersion: number }> {
  const meta = readEncryptionMeta(dbPath);
  if (!meta)
    throw new Error("Encryption not initialized");

  const newEncryptedDek = await encryptDek(newPublicKeyHex, currentDek);

  writeEncryptionMeta(dbPath, {
    ...meta,
    masterPublicKey: newPublicKeyHex,
    encryptedDek: newEncryptedDek,
    kdfSalt: kdfSalt ?? meta.kdfSalt,
  });

  return { dekVersion: meta.dekVersion };
}

/**
 * Migrate an existing unencrypted SQLite DB to an encrypted one.
 * Uses libSQL encryptionKey to create a new encrypted db and copy all data.
 */
async function migrateToEncrypted(dbPath: string, dekHex: string): Promise<void> {
  const tmpPath = `${dbPath}.enc.tmp`;

  await copyDatabase(dbPath, undefined, tmpPath, dekHex);

  // Verify the encrypted DB opens correctly
  const verifyClient = createClient({ url: `file:${tmpPath}`, encryptionKey: dekHex });
  try {
    await verifyClient.execute("SELECT count(*) FROM sqlite_master");
  }
  catch (err) {
    verifyClient.close();
    if (existsSync(tmpPath))
      unlinkSync(tmpPath);
    throw new Error(`Encryption verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  verifyClient.close();

  const bakPath = `${dbPath}.unencrypted.bak`;

  // Replace original with encrypted version
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${dbPath}${suffix}`;
    if (suffix === "") {
      renameSync(p, bakPath);
    }
    else if (existsSync(p)) {
      unlinkSync(p);
    }
  }

  renameSync(tmpPath, dbPath);
  cleanupWalShm(tmpPath);

  // Delete unencrypted backup
  if (existsSync(bakPath))
    unlinkSync(bakPath);
}

/** Copy all tables, indexes, and data from one SQLite db to another using libSQL clients. */
async function copyDatabase(srcPath: string, srcKey: string | undefined, dstPath: string, dstKey: string): Promise<void> {
  const src = createClient(
    srcKey
      ? { url: `file:${srcPath}`, encryptionKey: srcKey }
      : { url: `file:${srcPath}` },
  );
  const dst = createClient({ url: `file:${dstPath}`, encryptionKey: dstKey });

  try {
    await dst.execute("PRAGMA journal_mode = WAL");
    // Foreign keys are evaluated immediately by SQLite; disabling them
    // during the copy means we can create tables in any order without
    // worrying about cross-table FK references being unresolved.
    await dst.execute("PRAGMA foreign_keys = OFF");

    // Get all tables (drizzle migration tables first)
    const tablesResult = await src.execute(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY CASE WHEN name LIKE '__drizzle%' THEN 0 ELSE 1 END",
    );
    const tables = tablesResult.rows as unknown as { name: string; sql: string }[];

    // Get all indexes
    const indexesResult = await src.execute(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'",
    );
    const indexes = indexesResult.rows as unknown as { name: string; sql: string }[];

    for (const { name, sql } of tables) {
      assertCreateTableDdl(name, sql);
      await dst.execute(sql);
      await copyTableData(src, dst, name);
    }

    for (const { name, sql } of indexes) {
      assertCreateIndexDdl(name, sql);
      await dst.execute(sql);
    }

    await dst.execute("PRAGMA foreign_keys = ON");
    // Fold the destination WAL into its main file before the handle is
    // closed. Without this the copied rows stay in `${dstPath}-wal`; the
    // caller renames only the main file and deletes that sidecar, so the
    // promoted db would be missing all data and open with SQLITE_IOERR
    // (the actual root cause of the rotate-dek failure).
    await dst.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  finally {
    src.close();
    dst.close();
  }
}

const SAFE_IDENTIFIER_RE = /^[a-z_]\w*$/i;
// Only allow exactly one DDL statement that begins with the expected verb
// and references the expected name. sqlite_master rows are normally written
// only by SQLite itself; this is defence-in-depth against a future code
// path (or a malicious admin with write access to the encrypted DB) that
// poisons a row before DEK rotation copies the schema verbatim.
const RE_TABLE_DDL_PREFIX = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s*\(/i;
const RE_INDEX_DDL_PREFIX = /^\s*create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)\s+on\s+/i;

const RE_TRAILING_SEMICOLON = /;\s*$/;
function assertSingleStatement(sql: string, name: string): void {
  // Strip a single trailing `;` (SQLite emits these on PRAGMA-aided dumps);
  // anything else with `;` may be a stacked statement.
  const trimmed = sql.replace(RE_TRAILING_SEMICOLON, "");
  if (trimmed.includes(";"))
    throw new Error(`Refusing to copy schema for ${name}: multiple statements detected`);
}

function assertCreateTableDdl(name: string, sql: string): void {
  assertSafeIdentifier(name);
  assertSingleStatement(sql, name);
  if (!RE_TABLE_DDL_PREFIX.test(sql))
    throw new Error(`Refusing to copy schema for ${name}: not a CREATE TABLE statement`);
}

function assertCreateIndexDdl(name: string, sql: string): void {
  assertSafeIdentifier(name);
  assertSingleStatement(sql, name);
  if (!RE_INDEX_DDL_PREFIX.test(sql))
    throw new Error(`Refusing to copy schema for ${name}: not a CREATE INDEX statement`);
}

function assertSafeIdentifier(name: string): void {
  if (!SAFE_IDENTIFIER_RE.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
}

async function copyTableData(
  src: ReturnType<typeof createClient>,
  dst: ReturnType<typeof createClient>,
  tableName: string,
): Promise<void> {
  assertSafeIdentifier(tableName);
  const result = await src.execute(`SELECT * FROM "${tableName}"`);
  if (result.rows.length === 0)
    return;

  const cols = result.columns;
  for (const col of cols) assertSafeIdentifier(col);
  const placeholders = cols.map(() => "?").join(", ");
  const colNames = cols.map(c => `"${c}"`).join(", ");
  const insertSql = `INSERT INTO "${tableName}" (${colNames}) VALUES (${placeholders})`;

  // Use batch for efficiency
  const stmts = result.rows.map(row => ({
    sql: insertSql,
    args: cols.map(c => (row as Record<string, unknown>)[c] as null | string | number | ArrayBuffer),
  }));

  await dst.batch(stmts);
}

function cleanupWalShm(basePath: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    const p = `${basePath}${suffix}`;
    if (existsSync(p))
      unlinkSync(p);
  }
}

/**
 * Deterministic replacement for the old fixed `setTimeout(200)`: after
 * `wal_checkpoint(TRUNCATE)` + `close()`, block until the `-wal` file is
 * gone or zero-length, proving the WAL has been folded into the main db
 * file and libsql has released it. Pure filesystem stat — opens no libsql
 * client, so it cannot itself contend on the live path. Bounded so a
 * pathological hang surfaces as a rotation error (then recovered) rather
 * than wedging the request.
 */
async function waitForWalDrained(dbPath: string): Promise<void> {
  const walPath = `${dbPath}-wal`;
  const deadline = Date.now() + 3000;
  while (existsSync(walPath) && statSync(walPath).size > 0) {
    if (Date.now() >= deadline)
      throw new Error("WAL did not drain after checkpoint; aborting DEK rotation before snapshot");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
