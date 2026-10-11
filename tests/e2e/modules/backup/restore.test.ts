// Backup export → restore round-trip.
//
// The export endpoint streams a complete JSON snapshot of the running
// DB; the import endpoint replays it. This test walks the full cycle
// end-to-end:
//
//   1. spin up an isolated API instance — plaintext DB and single-user
//      mode keep this test independent from the orchestrator's dex.
//      The fixture dex config hard-codes the OAuth callback URI to
//      port 3010, so any test running on a different API port has to
//      bypass the OAuth dance entirely.
//   2. log in via /api/account/auth/login-local to seed a real admin
//      session + user row.
//   3. POST /api/backup/export with [users, settings].
//   4. POST /api/backup/import with includeUsers=true → the import
//      replays the same rows back into the DB.
//   5. assert the import response reports rowsImported >= the snapshot.
//
// The test deliberately uses its own API subprocess instead of the
// shared phase-B API: the restore truncates the `users` table, which
// cascades-deletes every `sessions` row, which would otherwise break
// every later phase-B test that shares a cached admin session.

import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { ApiClient } from "../../lib/api";

const ROOT = resolve(import.meta.dir, "../../../..");
const API_PORT = 3413;
const BASE = `http://127.0.0.1:${API_PORT}/app`;
const USERNAME = "admin";
const PASSWORD = "backup-restore-e2e-password";
// `bun run hash-password backup-restore-e2e-password`. Regenerate if
// PASSWORD changes; the hash is portable PBKDF2-SHA256.
const PASSWORD_HASH = "pbkdf2-sha256$600000$bE2wkiPrapKItd2afr4+pg==$P38Ezm8djwdHI75CtieRYgDHRuSr38ESVZISCRBnY60=";

let api: Subprocess | null = null;
let dataDir: string;

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 20_000;
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
  throw new Error(`restore-test API never came up at ${BASE}`);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "restore-e2e-"));
  // Scrub anything the parent shell / orchestrator might have left in
  // process.env that would override the explicit values below.
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
      // Plaintext DB removes the DEK challenge requirement on the
      // import / export endpoints — orthogonal to what we're testing
      // here, and skipping it keeps the round-trip simple.
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

describe("/api/backup round-trip (export → import)", () => {
  it("admin can export then restore the same JSON back into the live DB", async () => {
    const admin = new ApiClient(BASE);
    const login = await admin.raw("/api/account/auth/login-local", {
      method: "POST",
      body: { username: USERNAME, password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(admin.cookies.has("session_id")).toBe(true);

    const exportRes = await admin.raw("/api/backup/export", {
      method: "POST",
      body: { modules: ["users", "settings"] },
    });
    expect(exportRes.status).toBe(200);
    const dump = await exportRes.json() as {
      version: number;
      modules: string[];
      tables: Record<string, unknown[]>;
    };
    // Backup format v3 (sentinel subject_relation on tuples + group members, resource_groups table).
    expect(dump.version).toBe(3);
    expect(dump.modules).toContain("users");
    expect(dump.modules).toContain("settings");

    const beforeUsers = (dump.tables.users ?? []).length;
    const beforeSettings = (dump.tables.settings ?? []).length;
    expect(beforeUsers).toBeGreaterThan(0);

    // Replay the dump back into the same DB. `includeUsers=true` is
    // required so the importing admin's row survives — otherwise the
    // service refuses with RESTORE_FK_MISSING_USERS / RESTORE_WOULD_LOCK_OUT.
    const blob = new Blob([JSON.stringify(dump)], { type: "application/json" });
    const fd = new FormData();
    fd.append("file", blob, "backup.json");
    fd.append("includeUsers", "true");

    const importRes = await admin.raw("/api/backup/import", {
      method: "POST",
      formData: fd,
    });
    expect(importRes.status).toBe(200);
    const importBody = await importRes.json() as { success: boolean; rowsImported: number; tablesImported: number };
    expect(importBody.success).toBe(true);
    // The service may emit additional FK-related rows beyond the two tables
    // we asked for, so use >= rather than equality.
    expect(importBody.rowsImported).toBeGreaterThanOrEqual(beforeUsers + beforeSettings);
  });
});
