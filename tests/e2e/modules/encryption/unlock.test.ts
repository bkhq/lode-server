// Phase B — API restarted with the meta.db left over from Phase A. The
// system boots in "locked" state (initialised but no DEK in memory yet).
// The test walks the unlock flow: pull a challenge bundle, decrypt the
// wrapped DEK with the master private key derived from the same password,
// re-encrypt with the server's ephemeral public key, POST /unlock, verify
// the app rebuilds and /health flips from 503 → 200.

import { afterAll, describe, expect, it } from "bun:test";
import { bytesToHex, deriveKeyPairFromPassword, eciesDecrypt, eciesEncrypt, hexToBytes } from "../../../../packages/shared/src/index";
import { ApiClient } from "../../lib/api";

interface StatusBody {
  data: { initialized: boolean; locked: boolean; status: string; dbError: string | null };
}

interface UnlockChallengeBody {
  data: {
    challenge: { challengeId: string; ephemeralPublicKey: string };
    encryptedDek: string;
    kdfSalt: string;
  };
}

const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-master-password";

describe("encryption unlock flow (locked API)", () => {
  const c = new ApiClient();

  it("status starts locked (initialized + no DEK in memory)", async () => {
    const res = await c.json<StatusBody>("/api/encryption/status");
    expect(res.data.initialized).toBe(true);
    expect(res.data.locked).toBe(true);
    expect(res.data.status).toBe("locked");
    expect(res.data.dbError).toBeNull();
  });

  it("/api/health (liveness) returns 200 even while locked — process is alive", async () => {
    const res = await c.raw("/api/health");
    expect(res.status).toBe(200);
  });

  it("/api/health/ready (readiness) returns 503 while the system is locked", async () => {
    const res = await c.raw("/api/health/ready");
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("locked");
  });

  it("POST /encryption/unlock-challenge returns the bundle (kdfSalt + encryptedDek + challenge)", async () => {
    const ch = await c.json<UnlockChallengeBody>("/api/encryption/unlock-challenge", { method: "POST" });
    expect(ch.data.challenge.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof ch.data.challenge.ephemeralPublicKey).toBe("string");
    expect(ch.data.encryptedDek.length).toBeGreaterThan(0);
    expect(ch.data.kdfSalt.length).toBeGreaterThan(0);
  });

  it("end-to-end: derive master key, decrypt DEK, re-encrypt to challenge, POST /unlock", async () => {
    const ch = await c.json<UnlockChallengeBody>("/api/encryption/unlock-challenge", { method: "POST" });

    // Derive the master keypair from password + the salt the server sent us.
    const masterKp = await deriveKeyPairFromPassword(PASSWORD, ch.data.kdfSalt);
    // Decrypt the wrapped DEK.
    const dekBytes = await eciesDecrypt(masterKp.privateKey, hexToBytes(ch.data.encryptedDek));
    // Re-wrap under the server's ephemeral public key.
    const reEncrypted = await eciesEncrypt(ch.data.challenge.ephemeralPublicKey, dekBytes);

    const unlock = await c.json<{ data: { status: string } }>("/api/encryption/unlock", {
      method: "POST",
      body: {
        challengeId: ch.data.challenge.challengeId,
        encryptedDek: bytesToHex(reEncrypted),
      },
    });
    expect(unlock.data.status).toBe("unlocked");
  });

  it("after unlock /health flips to 200 + status reports unlocked", async () => {
    let healthOk = false;
    for (let i = 0; i < 20; i++) {
      const r = await c.raw("/api/health");
      if (r.status === 200) {
        healthOk = true;
        break;
      }
      await Bun.sleep(100);
    }
    expect(healthOk).toBe(true);

    const status = await c.json<StatusBody>("/api/encryption/status");
    expect(status.data.locked).toBe(false);
    expect(status.data.status).toBe("unlocked");
  });

  it("setup endpoints disappear after unlock", async () => {
    // setupRoutes is mounted only by buildLockedApp; once buildFullApp takes
    // over, /unlock-challenge (and /init / /unlock) are no longer routes and
    // answer 404 — not the locked-state 409 NOT_LOCKED. It used to answer
    // 401, but only because a module's session guard leaked onto every path
    // mounted after it; guards are scoped now.
    const res = await c.raw("/api/encryption/unlock-challenge", { method: "POST" });
    expect(res.status).toBe(404);
  });

  afterAll(() => {});
});
