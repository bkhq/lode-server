// Cross-cutting security guards on the live API. The orchestrator boots the
// API with CORS_ORIGIN set to the test base URL so the csrfGuard's Origin
// check is active end-to-end.
//
// These cases used to live in apps/api/tests/integration/csrf.test.ts. They
// were migrated here so the project has a single test path and the guards
// run against the real Bun.serve pipeline (not a synthetic app.fetch()).

import { describe, expect, it } from "bun:test";
import { API_BASE, ApiClient } from "../../lib/api";

const TARGET = "/api/account/auth/logout"; // any state-changing route under csrfGuard

describe("security guards (CSRF + Origin)", () => {
  it("POST without X-Requested-With is rejected (CSRF_REJECTED)", async () => {
    const c = new ApiClient();
    const res = await c.raw(TARGET, {
      method: "POST",
      body: {},
      // Override the auto-injected X-Requested-With with empty so it's absent.
      headers: { "X-Requested-With": "" },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("CSRF_REJECTED");
  });

  it("POST with Bearer token bypasses CSRF (no cookie surface)", async () => {
    const c = new ApiClient();
    const res = await c.raw(TARGET, {
      method: "POST",
      body: {},
      headers: {
        "X-Requested-With": "",
        "Authorization": "Bearer fake-token-for-csrf-bypass-test",
      },
    });
    // Bearer-token requests skip the CSRF guard entirely. Without a valid
    // token the route fails downstream — typically 401 — but never with
    // CSRF_REJECTED.
    if (res.status === 403) {
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).not.toBe("CSRF_REJECTED");
    }
  });

  it("POST with mismatching Origin is rejected (CSRF_REJECTED)", async () => {
    const c = new ApiClient();
    const res = await c.raw(TARGET, {
      method: "POST",
      body: {},
      headers: { Origin: "https://attacker.example.com" },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("CSRF_REJECTED");
    expect(body.error.message).toMatch(/Origin/);
  });

  it("POST with neither Origin nor Referer (and CORS_ORIGIN configured) is rejected", async () => {
    const c = new ApiClient();
    // Both Origin and Referer override to empty string so the guard sees no
    // origin signal and rejects.
    const res = await c.raw(TARGET, {
      method: "POST",
      body: {},
      headers: { Origin: "", Referer: "" },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("CSRF_REJECTED");
  });

  it("POST with matching Origin passes the CSRF guard", async () => {
    const c = new ApiClient();
    const origin = new URL(API_BASE).origin;
    const res = await c.raw(TARGET, {
      method: "POST",
      body: {},
      headers: { Origin: origin },
    });
    // CSRF guard accepts; downstream may still 401 (no session cookie). That
    // is fine — the contract here is only "not 403 CSRF_REJECTED".
    if (res.status === 403) {
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).not.toBe("CSRF_REJECTED");
    }
  });
});
