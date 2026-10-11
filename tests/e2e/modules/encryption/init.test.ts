// Phase A — fresh API with DB_ENCRYPTION=true and no meta.db. The system
// boots in "uninitialized" state (DB doesn't exist yet); a single
// /api/encryption/init walks: derive keypair → POST init → server
// generates DEK → wraps it under the master public key → opens the new
// encrypted db → flips the app to "unlocked" inline (no separate /unlock
// is needed for the operator who just initialised the system).

import { afterAll, describe, expect, it } from "bun:test";
import { deriveKeyPairFromPassword, generateSalt } from "../../../../packages/shared/src/index";
import { ApiClient } from "../../lib/api";

interface StatusBody {
  data: { initialized: boolean; locked: boolean; status: string; dbError: string | null };
}

const PASSWORD = "e2e-master-password";
const BOOTSTRAP_TOKEN = process.env.E2E_BOOTSTRAP_TOKEN;
if (!BOOTSTRAP_TOKEN)
  throw new Error("E2E_BOOTSTRAP_TOKEN missing — run.ts reads it from <DATA_DIR>/bootstrap-token.txt and forwards it to this phase");

describe("encryption init flow (fresh API)", () => {
  const c = new ApiClient();

  it("status starts uninitialized", async () => {
    const res = await c.json<StatusBody>("/api/encryption/status");
    expect(res.data.initialized).toBe(false);
    expect(res.data.locked).toBe(false);
    expect(res.data.status).toBe("uninitialized");
  });

  it("POST /encryption/init with bootstrap token + master pubkey → unlocked", async () => {
    const salt = generateSalt();
    const kp = await deriveKeyPairFromPassword(PASSWORD, salt);

    await c.json("/api/encryption/init", {
      method: "POST",
      body: { bootstrapToken: BOOTSTRAP_TOKEN, publicKey: kp.publicKey, kdfSalt: salt },
    });

    // initEncryption() calls setDek inline, which fires the persistent
    // onUnlock callback → opens the encrypted db → rebuilds buildFullApp.
    // So a freshly-initialised system goes straight to "unlocked".
    let status: StatusBody | undefined;
    for (let i = 0; i < 20; i++) {
      status = await c.json<StatusBody>("/api/encryption/status");
      if (status.data.status === "unlocked")
        break;
      await Bun.sleep(100);
    }
    expect(status!.data.initialized).toBe(true);
    expect(status!.data.locked).toBe(false);
    expect(status!.data.status).toBe("unlocked");
  });

  it("/encryption/init is no longer reachable after the system is unlocked", async () => {
    // setupRoutes is mounted only in the locked app; once buildFullApp takes
    // over, the route no longer exists and answers 404 — not 409
    // ALREADY_INITIALIZED, which only fires while the system is still locked.
    // It used to answer 401, but only because a module's session guard
    // leaked onto every path mounted after it; guards are scoped now.
    const res = await c.raw("/api/encryption/init", {
      method: "POST",
      body: { bootstrapToken: BOOTSTRAP_TOKEN, publicKey: "0".repeat(66), kdfSalt: "0".repeat(64) },
    });
    expect(res.status).toBe(404);
  });

  it("/api/health returns 200 after init completes", async () => {
    const res = await c.raw("/api/health");
    expect(res.status).toBe(200);
  });

  afterAll(() => {});
});
