// TOTP enrolment + verify flow against the live API. Uses the otpauth
// library (already a project dep) on the test side to generate codes from
// the secret returned by the create endpoint.

import { describe, expect, it } from "bun:test";
import { Secret, TOTP } from "otpauth";
import { getClient } from "../../lib/oidc";

interface TotpDevice { id: string; name: string; verified?: boolean }
interface CreateTotpResponse {
  data: { id: string; name: string; secret: string; uri: string; qrCode: string };
}

function code(secret: string, offsetMs = 0): string {
  return new TOTP({
    issuer: "App",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate({ timestamp: Date.now() + offsetMs });
}

describe("TOTP enrolment + verify (live)", () => {
  it("user enrols a device, confirms with a code, lists it, performs step-up, then deletes it", async () => {
    const user = await getClient("user@example.com", "admin");

    // 1. Create — returns secret + QR.
    const created = await user.json<CreateTotpResponse>("/api/account/me/totp", {
      method: "POST",
      body: { name: "e2e-laptop" },
    });
    expect(created.data.id.length).toBe(8);
    expect(created.data.secret.length).toBeGreaterThan(0);
    expect(created.data.uri).toMatch(/^otpauth:\/\//);
    expect(created.data.qrCode).toMatch(/^data:image\/png;base64,/);

    const deviceId = created.data.id;
    const secret = created.data.secret;

    // 2. Listed but unverified.
    const before = await user.json<{ data: TotpDevice[] }>("/api/account/me/totp");
    const beforeRow = before.data.find(d => d.id === deviceId);
    expect(beforeRow).toBeDefined();
    expect(beforeRow!.verified ?? false).toBe(false);

    // 3. Confirm — supplies a freshly-generated TOTP code.
    await user.raw(`/api/account/me/totp/${deviceId}/confirm`, {
      method: "POST",
      body: { code: code(secret) },
    });

    // 4. Listed AND verified.
    const after = await user.json<{ data: TotpDevice[] }>("/api/account/me/totp");
    const afterRow = after.data.find(d => d.id === deviceId);
    expect(afterRow).toBeDefined();
    expect(afterRow!.verified).toBe(true);

    // 5. Step-up verify — returns a token. Use the next 30s window so the
    //    code differs from the one used at confirm; the replay guard rejects
    //    re-use of a timestep that was already redeemed (RFC 6238 §5.2).
    const stepUp = await user.json<{ data: { token: string } }>("/api/account/me/totp/verify", {
      method: "POST",
      body: { code: code(secret, 30_000) },
    });
    expect(stepUp.data.token.length).toBeGreaterThan(0);

    // 6. Wrong code → 400.
    const bad = await user.raw("/api/account/me/totp/verify", {
      method: "POST",
      body: { code: "000000" },
    });
    expect(bad.status).toBe(400);

    // 7. Delete — device gone. Step-up gate requires `x-totp-token`; reuse
    //    the token from step 5 (single-use, consumed on the DELETE).
    await user.raw(`/api/account/me/totp/${deviceId}`, {
      method: "DELETE",
      headers: { "x-totp-token": stepUp.data.token },
    });
    const final = await user.json<{ data: TotpDevice[] }>("/api/account/me/totp");
    expect(final.data.find(d => d.id === deviceId)).toBeUndefined();
  });
});
