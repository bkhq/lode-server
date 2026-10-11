// Encryption unlock-challenge rate-limit. Runs against a freshly-restarted
// LOCKED API so the in-memory bucket starts at zero. The orchestrator
// (tests/e2e/run.ts) restarts the API again before the actual unlock test
// so that test does not inherit the tripped limiter.
//
// This case used to live in apps/api/tests/integration/encryption.test.ts.

import { describe, expect, it } from "bun:test";
import { ApiClient } from "../../lib/api";

// Mirrors UNLOCK_MAX_ATTEMPTS in apps/api/src/modules/encryption/encryption.routes.ts.
const UNLOCK_MAX_ATTEMPTS = 10;

describe("/api/encryption/unlock-challenge rate limit (locked)", () => {
  it(`returns 429 after ${UNLOCK_MAX_ATTEMPTS} attempts within the window`, async () => {
    const c = new ApiClient();

    // First N attempts succeed; the (N+1)th must be rejected.
    for (let i = 0; i < UNLOCK_MAX_ATTEMPTS; i++) {
      const res = await c.raw("/api/encryption/unlock-challenge", { method: "POST" });
      if (res.status !== 200) {
        const text = await res.text();
        throw new Error(`attempt ${i + 1} expected 200, got ${res.status}: ${text}`);
      }
    }

    const limited = await c.raw("/api/encryption/unlock-challenge", { method: "POST" });
    expect(limited.status).toBe(429);
    const body = await limited.json() as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });
});
