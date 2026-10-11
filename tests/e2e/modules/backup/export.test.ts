// Backup export with the encryption challenge dance.
//
// The export endpoint verifies the operator can decrypt the DEK before it
// streams data out. With DB_ENCRYPTION=true (which the orchestrator pins),
// the request must carry { challengeId, encryptedDek } produced by the
// same ECIES round-trip used for unlock and rotate-dek.

import { describe, expect, it } from "bun:test";
import process from "node:process";
import { bytesToHex, deriveKeyPairFromPassword, eciesDecrypt, eciesEncrypt, hexToBytes } from "../../../../packages/shared/src/index";
import { getClient } from "../../lib/oidc";

interface MetaResponse { data: { encryptedDek: string; kdfSalt: string } }
interface ChallengeResponse { data: { challengeId: string; ephemeralPublicKey: string } }

const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-master-password";

describe("/api/backup/export (DEK proof)", () => {
  it("admin can list backup modules", async () => {
    const admin = await getClient("admin@example.com", "admin");
    const res = await admin.json<{ modules: { name: string; deps: string[] }[] }>("/api/backup/modules");
    expect(res.modules.length).toBeGreaterThan(0);
    expect(res.modules.map(m => m.name)).toContain("users");
  });

  it("non-admin cannot hit /backup/modules (403)", async () => {
    const user = await getClient("user@example.com", "admin");
    const res = await user.raw("/api/backup/modules");
    expect(res.status).toBe(403);
  });

  it("export without challenge is rejected (ENCRYPTION_REQUIRED)", async () => {
    const admin = await getClient("admin@example.com", "admin");
    const res = await admin.raw("/api/backup/export", {
      method: "POST",
      body: { modules: ["users"] },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("ENCRYPTION_REQUIRED");
  });

  it("admin export with valid DEK challenge returns a JSON body with the requested modules", async () => {
    const admin = await getClient("admin@example.com", "admin");

    // Derive DEK from master password + persisted salt → wrap under fresh
    // server challenge → submit.
    const meta = await admin.json<MetaResponse>("/api/encryption/meta");
    const masterKp = await deriveKeyPairFromPassword(PASSWORD, meta.data.kdfSalt);
    const dekBytes = await eciesDecrypt(masterKp.privateKey, hexToBytes(meta.data.encryptedDek));

    const ch = await admin.json<ChallengeResponse>("/api/encryption/challenge", { method: "POST" });
    const wrapped = bytesToHex(await eciesEncrypt(ch.data.ephemeralPublicKey, dekBytes));

    const res = await admin.raw("/api/backup/export", {
      method: "POST",
      body: {
        modules: ["users", "settings"],
        challengeId: ch.data.challengeId,
        encryptedDek: wrapped,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    // Filename slug is derived from APP_NAME on the server side; default "app".
    expect(res.headers.get("content-disposition")).toMatch(/attachment.*-backup-/);

    const body = await res.json() as { modules: string[]; tables: Record<string, unknown[]> };
    expect(body.modules).toContain("users");
    expect(body.modules).toContain("settings");
    // Tables block carries the actual rows, keyed by table name.
    expect(typeof body.tables).toBe("object");
  });
});
