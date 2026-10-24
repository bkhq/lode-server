import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { bytesToHex, eciesEncrypt, hexToBytes } from "@app/shared";
import { createClient } from "@libsql/client";
import { EncryptionState } from "@/modules/encryption/state";
import { verifyDekChallenge } from "./export.service";

const DEK = "11".repeat(32);
const OTHER_DEK = "22".repeat(32);

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "dek-challenge-"));
  dbPath = resolve(dir, "app.db");
  const client = createClient({ url: `file:${dbPath}`, encryptionKey: DEK });
  await client.execute("CREATE TABLE t (x INTEGER)");
  client.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function answer(enc: EncryptionState, dek: string) {
  const { challengeId, ephemeralPublicKey } = enc.createChallenge();
  return {
    challengeId,
    encryptedDek: bytesToHex(await eciesEncrypt(ephemeralPublicKey, hexToBytes(dek))),
  };
}

async function codeOf(p: Promise<void>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  }
  catch (err) {
    return (err as { code?: string }).code;
  }
}

describe("verifyDekChallenge", () => {
  test("passes with the database's DEK, and spends the challenge", async () => {
    const enc = new EncryptionState();
    const { challengeId, encryptedDek } = await answer(enc, DEK);
    expect(await codeOf(verifyDekChallenge(enc, dbPath, challengeId, encryptedDek))).toBeUndefined();
    expect(await codeOf(verifyDekChallenge(enc, dbPath, challengeId, encryptedDek))).toBe("INVALID_CHALLENGE");
  });

  test("requires the challenge answer", async () => {
    const enc = new EncryptionState();
    expect(await codeOf(verifyDekChallenge(enc, dbPath, undefined, undefined))).toBe("ENCRYPTION_REQUIRED");
  });

  test("rejects an unknown challenge", async () => {
    const enc = new EncryptionState();
    expect(await codeOf(verifyDekChallenge(enc, dbPath, "nope", "00"))).toBe("INVALID_CHALLENGE");
  });

  test("rejects a key that does not open the database", async () => {
    const enc = new EncryptionState();
    const { challengeId, encryptedDek } = await answer(enc, OTHER_DEK);
    expect(await codeOf(verifyDekChallenge(enc, dbPath, challengeId, encryptedDek))).toBe("INVALID_KEY");
  });

  test("rejects an answer that does not decrypt", async () => {
    const enc = new EncryptionState();
    const { challengeId } = enc.createChallenge();
    expect(await codeOf(verifyDekChallenge(enc, dbPath, challengeId, "00ff"))).toBe("INVALID_KEY");
  });

  test("is a no-op when encryption is disabled", async () => {
    const enc = new EncryptionState();
    enc.setEncryptionDisabled(true);
    expect(await codeOf(verifyDekChallenge(enc, dbPath, undefined, undefined))).toBeUndefined();
  });
});
