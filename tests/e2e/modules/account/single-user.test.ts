// Single-user mode (OAuth bypass) e2e.
//
// The shared orchestrator (tests/e2e/run.ts) always injects OAUTH_* into
// the API process; single-user mode needs the OAuth surface left blank.
// This test launches its own API subprocess on a separate port with a
// fresh plaintext data directory, runs the local-login flow against it,
// and tears the process down at the end.
//
// All credentials used here live in this file — no shared secret is
// crossed between phases.

import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { ApiClient } from "../../lib/api";

const ROOT = resolve(import.meta.dir, "../../../..");
const API_PORT = 3411;
const BASE = `http://127.0.0.1:${API_PORT}/app`;
const USERNAME = "admin";
const PASSWORD = "single-user-e2e-password";
// Generated once via `bun run hash-password "single-user-e2e-password"`.
// Re-generate (cd /app/zzci/access && bun run hash-password single-user-e2e-password)
// when changing PASSWORD. The hash is a portable PBKDF2-SHA256 string.
const PASSWORD_HASH = "pbkdf2-sha256$600000$MC1FLB6VFBnsN7M7ZhMIaQ==$pgqATbxmMfmryXey2SYt0GgOMSVzxubKZ2CAJF9tV0A=";

let api: Subprocess | null = null;
let dataDir: string;

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.status >= 200 && res.status < 500)
        return;
    }
    catch {
      // not yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`single-user API never came up at ${BASE}`);
}

// Spawning a second API process + waiting for it to come up can take
// well over the default 5s beforeAll budget on slow CI nodes. Bun's
// hook hooks accept a per-invocation timeout as the second argument.
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "single-user-e2e-"));

  // Strip OAUTH_* / APP_URL so the OAuth surface is genuinely absent
  // — the orchestrator parent injects them and they would otherwise be
  // inherited via process.env.
  const SCRUB = new Set([
    "OAUTH_ISSUER",
    "OAUTH_CLIENT_ID",
    "OAUTH_CLIENT_SECRET",
    "OAUTH_AUTHORIZE_URL",
    "OAUTH_TOKEN_URL",
    "OAUTH_USERINFO_URL",
    "OAUTH_PKCE",
    "OIDC_LOGOUT_URL",
    "APP_URL",
    "DEFAULT_ADMIN",
    "DB_ENCRYPTION",
    "PORT",
    "DB_PATH",
    "LOG_FILE",
    "SINGLE_USER_MODE",
    "SINGLE_USER_USERNAME",
    "SINGLE_USER_PASSWORD_HASH",
    "SINGLE_USER_NAME",
    "SINGLE_USER_EMAIL",
  ]);
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SCRUB.has(k))
      cleanEnv[k] = v;
  }

  api = Bun.spawn(["bun", "--env-file=/dev/null", "src/index.ts"], {
    cwd: join(ROOT, "apps/api"),
    env: {
      ...cleanEnv,
      NODE_ENV: "development",
      PORT: String(API_PORT),
      HOST: "127.0.0.1",
      BASE_PATH: "/app",
      DB_PATH: join(dataDir, "app.db"),
      DB_ENCRYPTION: "false",
      LOG_LEVEL: "warn",
      LOG_TO_STDOUT: "true",
      APP_URL: `http://127.0.0.1:${API_PORT}`,
      CORS_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      SINGLE_USER_MODE: "true",
      SINGLE_USER_USERNAME: USERNAME,
      SINGLE_USER_PASSWORD_HASH: PASSWORD_HASH,
      SINGLE_USER_NAME: "Admin",
      SINGLE_USER_EMAIL: "admin@example.com",
      // The auth route limits per IP at 120/minute; the test makes <10
      // login attempts so the global limiter never trips. The lockout
      // threshold (10 consecutive failures) is exercised below.
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  await waitForReady();
}, 30_000);

afterAll(async () => {
  if (api) {
    api.kill();
    try {
      await api.exited;
    }
    catch {}
    api = null;
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("single-user mode", () => {
  it("/api/account/auth/mode reports single-user with no OAuth configured", async () => {
    const c = new ApiClient(BASE);
    const body = await c.json<{ data: { mode: string; oauthConfigured: boolean } }>("/api/account/auth/mode");
    expect(body.data.mode).toBe("single-user");
    expect(body.data.oauthConfigured).toBe(false);
  });

  it("login-local with correct credentials issues a session cookie", async () => {
    const c = new ApiClient(BASE);
    const res = await c.raw("/api/account/auth/login-local", {
      method: "POST",
      body: { username: USERNAME, password: PASSWORD },
    });
    expect(res.status).toBe(200);
    expect(c.cookies.has("session_id")).toBe(true);

    // /me must now return the single-user identity.
    const me = await c.json<{ data: { username: string; email: string } }>("/api/account/me");
    expect(me.data.username).toBe(USERNAME);

    // Logout returns 200; the server invalidates the session row so
    // any subsequent /me with the same cookie still returns 401. The
    // shared CookieJar helper's capture regex skips empty Set-Cookie
    // values, so we assert against server state (the 401 below)
    // rather than the local cookie jar.
    const out = await c.raw("/api/account/auth/logout", { method: "POST" });
    expect(out.status).toBe(200);

    const me2 = await c.raw("/api/account/me");
    expect(me2.status).toBe(401);
  });

  it("login-local with wrong password returns 401 INVALID_CREDENTIALS", async () => {
    const c = new ApiClient(BASE);
    const res = await c.raw("/api/account/auth/login-local", {
      method: "POST",
      body: { username: USERNAME, password: "definitely-wrong" },
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
    expect(c.cookies.has("session_id")).toBe(false);
  });

  it("10 wrong attempts trips ACCOUNT_LOCKED (429) and the next valid attempt is rejected", async () => {
    // The lockout threshold is 10 consecutive failures. Step the counter
    // up exactly to the boundary, then verify the 11th attempt — even
    // with the correct password — returns 429.
    const c = new ApiClient(BASE);
    for (let i = 0; i < 10; i++) {
      const res = await c.raw("/api/account/auth/login-local", {
        method: "POST",
        body: { username: USERNAME, password: `still-wrong-${i}` },
      });
      // First nine: 401 INVALID_CREDENTIALS. Tenth: 429 ACCOUNT_LOCKED
      // (the failure that crossed the threshold also reports the lock).
      expect([401, 429]).toContain(res.status);
    }
    const final = await c.raw("/api/account/auth/login-local", {
      method: "POST",
      body: { username: USERNAME, password: PASSWORD },
    });
    expect(final.status).toBe(429);
    const body = await final.json() as { error: { code: string } };
    expect(body.error.code).toBe("ACCOUNT_LOCKED");
  });
});
