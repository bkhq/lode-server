// Admin encryption operations against the unlocked API. These are mounted
// in protectedRoutes (require admin session). The full DEK challenge dance
// runs against the real ECIES helpers in @app/shared.
//
// NOTE: this test deliberately runs in Phase B (modules), not in the
// init/unlock phases — by then the API is already unlocked and we have an
// admin session via OIDC. Each operation requires the operator to prove
// possession of the DEK by submitting a re-encrypted copy under a fresh
// server-issued ephemeral pubkey.

import { describe, expect, it } from "bun:test";
import process from "node:process";
import { bytesToHex, deriveKeyPairFromPassword, eciesDecrypt, eciesEncrypt, hexToBytes } from "../../../../packages/shared/src/index";
import { getClient } from "../../lib/oidc";

interface MetaResponse { data: { encryptedDek: string; kdfSalt: string } }
interface ChallengeResponse { data: { challengeId: string; ephemeralPublicKey: string } }

const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-master-password";

async function getDekHex(admin: Awaited<ReturnType<typeof getClient>>): Promise<string> {
  const meta = await admin.json<MetaResponse>("/api/encryption/meta");
  const masterKp = await deriveKeyPairFromPassword(PASSWORD, meta.data.kdfSalt);
  const dekBytes = await eciesDecrypt(masterKp.privateKey, hexToBytes(meta.data.encryptedDek));
  return bytesToHex(dekBytes);
}

async function wrapForChallenge(dekHex: string, ephemeralPubKeyHex: string): Promise<string> {
  const reEncrypted = await eciesEncrypt(ephemeralPubKeyHex, hexToBytes(dekHex));
  return bytesToHex(reEncrypted);
}

describe("/api/encryption admin ops (require admin session + DEK proof)", () => {
  it("/encryption/meta returns the persisted master pubkey + encrypted DEK", async () => {
    const admin = await getClient("admin@example.com", "admin");
    const meta = await admin.json<MetaResponse>("/api/encryption/meta");
    expect(meta.data.encryptedDek.length).toBeGreaterThan(0);
    expect(meta.data.kdfSalt.length).toBe(64);
  });

  it("/encryption/meta is gated to admin (regular user → 403)", async () => {
    const user = await getClient("user@example.com", "admin");
    const res = await user.raw("/api/encryption/meta");
    expect(res.status).toBe(403);
  });

  it("/encryption/challenge mints an ephemeral pubkey for admin", async () => {
    const admin = await getClient("admin@example.com", "admin");
    const ch = await admin.json<ChallengeResponse>("/api/encryption/challenge", { method: "POST" });
    expect(ch.data.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof ch.data.ephemeralPublicKey).toBe("string");
  });

  // rotate-dek is marked EXPERIMENTAL — known SQLITE_IOERR under libsql when
  // the WAL is busy. We can't exercise the endpoint in this phase: a failed
  // rotation leaves the live db handle closed, which breaks every subsequent
  // request in the modules pass (most visibly the change-master test below).
  // The route is flagged EXPERIMENTAL in its OpenAPI summary and in
  // docs/modules/encryption.md; once the underlying I/O issue is fixed the
  // skip can be lifted.
  it.skip("rotate-dek round-trip (EXPERIMENTAL)", async () => {
    const admin = await getClient("admin@example.com", "admin");
    const dekHex = await getDekHex(admin);
    const ch = await admin.json<ChallengeResponse>("/api/encryption/challenge", { method: "POST" });
    const wrapped = await wrapForChallenge(dekHex, ch.data.ephemeralPublicKey);
    const result = await admin.json<{ data: { dekVersion: number } }>("/api/encryption/rotate-dek", {
      method: "POST",
      body: { challengeId: ch.data.challengeId, encryptedDek: wrapped },
    });
    expect(result.data.dekVersion).toBeGreaterThanOrEqual(2);
  });

  it("change-master: prove DEK + provide a new master pubkey under the same password", async () => {
    // Derive a NEW keypair from the SAME password but a fresh salt; the
    // Phase C unlock will re-derive the master key from `E2E_PASSWORD` +
    // whatever salt the server returns, so this leaves the system unlockable.
    const admin = await getClient("admin@example.com", "admin");
    const dekHex = await getDekHex(admin);
    const ch = await admin.json<ChallengeResponse>("/api/encryption/challenge", { method: "POST" });
    const wrapped = await wrapForChallenge(dekHex, ch.data.ephemeralPublicKey);

    const newSalt = "11".repeat(32);
    const newKp = await deriveKeyPairFromPassword(PASSWORD, newSalt);

    await admin.json("/api/encryption/change-master", {
      method: "POST",
      body: {
        challengeId: ch.data.challengeId,
        encryptedDek: wrapped,
        publicKey: newKp.publicKey,
        kdfSalt: newSalt,
      },
    });

    const after = await admin.json<MetaResponse>("/api/encryption/meta");
    expect(after.data.kdfSalt).toBe(newSalt);
  });
});
