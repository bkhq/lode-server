import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { ApiClient } from "../../lib/api";

describe("/api/health (live, encrypted, unlocked)", () => {
  it("returns 200 + status:ok", async () => {
    const c = new ApiClient();
    const res = await c.json<{ status: string }>("/api/health");
    expect(res.status).toBe("ok");
  });

  it("/api/health/ready returns 200 + status:ready when unlocked + DB reachable", async () => {
    const c = new ApiClient();
    const res = await c.raw("/api/health/ready");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("ready");
  });

  it("anonymous /api/encryption/status payload is minimal (no leaks)", async () => {
    const c = new ApiClient();
    const res = await c.json<{ data: Record<string, unknown> }>("/api/encryption/status");
    // Critical: an unauth caller must not see kdfSalt / encryptedDek /
    // dekVersion / challenge — these go through the protected /encryption
    // surface or the locked-only /encryption/unlock-challenge.
    expect(res.data).not.toHaveProperty("kdfSalt");
    expect(res.data).not.toHaveProperty("encryptedDek");
    expect(res.data).not.toHaveProperty("dekVersion");
    expect(res.data).not.toHaveProperty("challenge");
    expect(res.data.initialized).toBe(true);
    expect(res.data.locked).toBe(false);
    expect(res.data.status).toBe("unlocked");
  });
});

// ─── Failure-state coverage ─────────────────────────────────────────
// The unlocked orchestrator API is in the happy path; spin up a second
// API on a different port with an encrypted-but-uninitialized data dir
// so /health/ready returns 503 (the system is in setup mode and the DB
// is not yet open).
describe("/api/health/ready returns 503 when the system is not yet unlocked", () => {
  const ROOT = resolve(import.meta.dir, "../../../..");
  const API_PORT = 3412;
  const BASE = `http://127.0.0.1:${API_PORT}/app`;

  let api: Subprocess | null = null;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "health-locked-e2e-"));
    const SCRUB = new Set([
      "PORT",
      "DB_PATH",
      "DB_ENCRYPTION",
      "LOG_FILE",
      "APP_URL",
      "OAUTH_ISSUER",
      "OAUTH_CLIENT_ID",
      "OAUTH_CLIENT_SECRET",
      "OAUTH_PKCE",
      "OAUTH_AUTHORIZE_URL",
      "OAUTH_TOKEN_URL",
      "OAUTH_USERINFO_URL",
      "OIDC_LOGOUT_URL",
      "DEFAULT_ADMIN",
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
        // Encrypted + no meta.db -> bootstrap stays in setup mode and
        // /health/ready must report 503 because the DB is still locked.
        DB_ENCRYPTION: "true",
        LOG_LEVEL: "warn",
        LOG_TO_STDOUT: "true",
        APP_URL: `http://127.0.0.1:${API_PORT}`,
        CORS_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    // The live API replies to /api/health with 200 once Bun.serve is
    // bound — that proves the process is up even though the encrypted
    // app is still locked.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (res.status === 200)
          return;
      }
      catch {
        // not yet
      }
      await Bun.sleep(200);
    }
    throw new Error(`secondary API never came up at ${BASE}`);
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

  it("/api/health stays live (200) even while the system is locked", async () => {
    const c = new ApiClient(BASE);
    const res = await c.raw("/api/health");
    expect(res.status).toBe(200);
  });

  it("/api/health/ready returns 503 when the DB is not unlocked yet", async () => {
    const c = new ApiClient(BASE);
    const res = await c.raw("/api/health/ready");
    expect(res.status).toBe(503);
    const body = await res.json() as { status: string };
    // The exact status string depends on whether the bootstrap landed
    // in setup mode (no meta) or in locked mode (meta exists). Both
    // resolve to a 503 — accept either.
    expect(["locked", "no_db", "db_unavailable"]).toContain(body.status);
  });
});
