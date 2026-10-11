import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { bytesToHex, eciesDecrypt, generateKeyPair, hexToBytes } from "@app/shared";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { changeMasterKey, initEncryption, unlockSystem } from "./encryption.service";
import { readEncryptionMeta } from "./meta";
import { EncryptionState } from "./state";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let dir: string;
let dbPath: string;

/**
 * Build a fresh state with the operation lock pre-acquired and an onUnlock
 * callback that records the DEK it was handed. `setDek` (called internally by
 * initEncryption / unlockSystem) requires both to be present.
 */
function makeState(): { state: EncryptionState; unlockedWith: string[] } {
  const state = new EncryptionState();
  const unlockedWith: string[] = [];
  state.setOnUnlock((dek) => {
    unlockedWith.push(dek);
  });
  state.beginOperation();
  return { state, unlockedWith };
}

beforeEach(() => {
  dir = resolve(tmpdir(), `test-encryption-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
});

afterEach(() => {
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

describe("initEncryption", () => {
  test("initializes on a fresh path: writes meta, marks state, fires onUnlock with the DEK", async () => {
    const { state, unlockedWith } = makeState();
    const { publicKey } = generateKeyPair();

    const result = await initEncryption(state, dbPath, publicKey);

    expect(result.dekVersion).toBe(1);
    expect(state.isInitialized()).toBe(true);
    expect(state.isUnlocked()).toBe(true);

    const meta = readEncryptionMeta(dbPath);
    expect(meta).not.toBeNull();
    expect(meta!.masterPublicKey).toBe(publicKey);
    expect(meta!.dekVersion).toBe(1);
    expect(meta!.kdfSalt).toBeNull();
    expect(meta!.initializedAt.length).toBeGreaterThan(0);

    // onUnlock received the plaintext DEK; it must be a 64-char hex string.
    expect(unlockedWith).toHaveLength(1);
    expect(unlockedWith[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  test("persists the supplied kdfSalt into meta", async () => {
    const { state } = makeState();
    const { publicKey } = generateKeyPair();
    const salt = "ab".repeat(32);

    await initEncryption(state, dbPath, publicKey, salt);

    expect(readEncryptionMeta(dbPath)!.kdfSalt).toBe(salt);
  });

  test("the encryptedDek in meta decrypts back to the DEK handed to onUnlock", async () => {
    const { state, unlockedWith } = makeState();
    const { publicKey, privateKey } = generateKeyPair();

    await initEncryption(state, dbPath, publicKey);

    const meta = readEncryptionMeta(dbPath)!;
    const decrypted = await eciesDecrypt(privateKey, hexToBytes(meta.encryptedDek));
    expect(bytesToHex(decrypted)).toBe(unlockedWith[0]!);
  });

  test("is idempotent-guarded: a second init on an already-initialized state throws", async () => {
    const { state } = makeState();
    const { publicKey } = generateKeyPair();

    await initEncryption(state, dbPath, publicKey);
    state.endOperation();
    state.beginOperation();

    await expect(initEncryption(state, dbPath, publicKey)).rejects.toThrow(/already initialized/i);
  });
});

describe("unlockSystem", () => {
  test("unlocks with the correct DEK and fires onUnlock", async () => {
    // Create a real encrypted DB with a known DEK.
    const { state: initState } = makeState();
    const { publicKey } = generateKeyPair();
    await initEncryption(initState, dbPath, publicKey);

    // Recover the plaintext DEK via the meta + master private key path is not
    // available here (we only have the public key), so create the encrypted
    // file directly with a known DEK instead.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const dek = "cd".repeat(32);
    const db = await createDb(dbPath, dek);
    db.close();

    const { state, unlockedWith } = makeState();
    await unlockSystem(state, dbPath, dek);

    expect(state.isUnlocked()).toBe(true);
    expect(unlockedWith).toEqual([dek]);
  });

  test("rejects a wrong DEK and does NOT unlock", async () => {
    const correct = "11".repeat(32);
    const db = await createDb(dbPath, correct);
    db.close();

    const { state } = makeState();
    const wrong = "22".repeat(32);
    await expect(unlockSystem(state, dbPath, wrong)).rejects.toThrow(/invalid decryption key/i);
    expect(state.isUnlocked()).toBe(false);
  });

  test("throws when the database file is missing", async () => {
    const { state } = makeState();
    await expect(unlockSystem(state, dbPath, "33".repeat(32))).rejects.toThrow(/not found/i);
  });

  test("unlocking again re-fires onUnlock (re-open path)", async () => {
    const dek = "44".repeat(32);
    const db = await createDb(dbPath, dek);
    db.close();

    const { state, unlockedWith } = makeState();
    await unlockSystem(state, dbPath, dek);
    await unlockSystem(state, dbPath, dek);
    expect(unlockedWith).toEqual([dek, dek]);
    expect(state.isUnlocked()).toBe(true);
  });
});

describe("changeMasterKey", () => {
  test("re-wraps the DEK under a new master without changing the DEK or version", async () => {
    const oldMaster = generateKeyPair();

    // Establish initial meta via init, then learn the DEK by decrypting with
    // the old master private key.
    const { state } = makeState();
    await initEncryption(state, dbPath, oldMaster.publicKey);
    const metaBefore = readEncryptionMeta(dbPath)!;
    const realDek = bytesToHex(await eciesDecrypt(oldMaster.privateKey, hexToBytes(metaBefore.encryptedDek)));

    const newMaster = generateKeyPair();
    const result = await changeMasterKey(dbPath, newMaster.publicKey, realDek);

    expect(result.dekVersion).toBe(metaBefore.dekVersion);

    const metaAfter = readEncryptionMeta(dbPath)!;
    expect(metaAfter.masterPublicKey).toBe(newMaster.publicKey);
    expect(metaAfter.dekVersion).toBe(metaBefore.dekVersion);
    expect(metaAfter.encryptedDek).not.toBe(metaBefore.encryptedDek);

    // New master can decrypt; the recovered DEK is unchanged.
    const viaNew = bytesToHex(await eciesDecrypt(newMaster.privateKey, hexToBytes(metaAfter.encryptedDek)));
    expect(viaNew).toBe(realDek);
  });

  test("after change, the OLD master key can no longer decrypt the wrapped DEK", async () => {
    const oldMaster = generateKeyPair();
    const { state } = makeState();
    await initEncryption(state, dbPath, oldMaster.publicKey);
    const metaBefore = readEncryptionMeta(dbPath)!;
    const realDek = bytesToHex(await eciesDecrypt(oldMaster.privateKey, hexToBytes(metaBefore.encryptedDek)));

    const newMaster = generateKeyPair();
    await changeMasterKey(dbPath, newMaster.publicKey, realDek);

    const metaAfter = readEncryptionMeta(dbPath)!;
    await expect(eciesDecrypt(oldMaster.privateKey, hexToBytes(metaAfter.encryptedDek))).rejects.toThrow();
  });

  test("preserves the existing kdfSalt when none is supplied, and overrides it when given", async () => {
    const oldMaster = generateKeyPair();
    const salt = "ee".repeat(32);
    const { state } = makeState();
    await initEncryption(state, dbPath, oldMaster.publicKey, salt);
    const metaBefore = readEncryptionMeta(dbPath)!;
    const realDek = bytesToHex(await eciesDecrypt(oldMaster.privateKey, hexToBytes(metaBefore.encryptedDek)));

    const newMaster = generateKeyPair();
    await changeMasterKey(dbPath, newMaster.publicKey, realDek);
    expect(readEncryptionMeta(dbPath)!.kdfSalt).toBe(salt);

    const newSalt = "ff".repeat(32);
    await changeMasterKey(dbPath, newMaster.publicKey, realDek, newSalt);
    expect(readEncryptionMeta(dbPath)!.kdfSalt).toBe(newSalt);
  });

  test("throws when encryption is not initialized (no meta)", async () => {
    await expect(changeMasterKey(dbPath, generateKeyPair().publicKey, "77".repeat(32)))
      .rejects
      .toThrow(/not initialized/i);
  });
});
