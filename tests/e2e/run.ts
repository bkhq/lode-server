#!/usr/bin/env bun

// Unified e2e orchestrator. Boots the API with DB_ENCRYPTION=true, walks
// the full encryption setup, then exercises every module against the live
// stack, and finally restarts to verify the unlock cycle.
//
// Phases (single shared data dir under tests/e2e/.cache/data/<rid>):
//
//   1. dex up (OIDC fixture).
//   2. API up — fresh, encrypted, no meta.db → status "uninitialized".
//   3. modules/encryption/init.test.ts → init flow → status "unlocked".
//   4. modules/{system,account,policy,document,file,issue,settings,audit,backup}
//      → all module tests against the unlocked API. Includes
//      modules/system/security.test.ts (CSRF + Origin guard cases).
//   5. API restart — sees meta.db → status "locked".
//   6. modules/encryption/rate-limit.test.ts → bursts unlock-challenge to
//      verify the 429 path. Trips the in-memory limiter.
//   7. API restart — drops the limiter so the unlock test starts clean.
//   8. modules/encryption/unlock.test.ts → unlock flow → status "unlocked".
//   9. Tear everything down; remove the data dir.
//
// Per-phase JUnit XML lands in tests/e2e/.cache/reports/<run-ts>/<phase>.xml,
// and a `latest/` symlink points to the most recent run. The orchestrator
// also prints a final summary (total / passed / failed / skipped per phase
// + grand total) and writes summary.json next to the XMLs for CI to ingest.

import type { Subprocess } from "bun";
import { $ } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dir, "../..");
const E2E_DIR = resolve(import.meta.dir);
const DEX_BIN = join(E2E_DIR, ".cache/dex");
const DEX_CONFIG = join(E2E_DIR, "dex/config.yaml");
const DATA_ROOT = join(E2E_DIR, ".cache/data");
const REPORT_ROOT = join(E2E_DIR, ".cache/reports");

const DEX_PORT = 5566;
const API_PORT = 3010;
const DEX_BASE = `http://127.0.0.1:${DEX_PORT}/dex`;
const API_BASE = `http://127.0.0.1:${API_PORT}/app`;
const MASTER_PASSWORD = "e2e-master-password";

/**
 * The API auto-generates a one-time bootstrap token at every boot and writes
 * it to <DATA_DIR>/bootstrap-token.txt while the system is in setup mode.
 * Read the file once the API is up; the value is consumed by phase A and
 * deleted server-side on /encryption/init success.
 */
function readBootstrapToken(dataDir: string): string {
  const file = join(dataDir, "bootstrap-token.txt");
  return readFileSync(file, "utf-8").trim();
}

const ENCRYPTION_INIT_TEST = join(E2E_DIR, "modules/encryption/init.test.ts");
const ENCRYPTION_UNLOCK_TEST = join(E2E_DIR, "modules/encryption/unlock.test.ts");
const ENCRYPTION_ADMIN_TEST = join(E2E_DIR, "modules/encryption/admin.test.ts");
const ENCRYPTION_RATE_LIMIT_TEST = join(E2E_DIR, "modules/encryption/rate-limit.test.ts");
// Every module folder runs in phase B, except encryption: its suites are
// wired into the phases that set up and unlock the system (admin.test.ts is
// added to phase B explicitly, after the others).
const MODULE_DIRS = readdirSync(join(E2E_DIR, "modules"), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name !== "encryption")
  .map(entry => join(E2E_DIR, "modules", entry.name))
  .toSorted();

interface PhaseSummary {
  readonly phase: string;
  readonly tests: number;
  readonly assertions: number;
  readonly failures: number;
  readonly skipped: number;
  readonly time: number;
  readonly reportPath: string;
}

async function waitFor(url: string, label: string, opts: { acceptAny?: boolean; timeoutMs?: number } = {}): Promise<void> {
  const { acceptAny = false, timeoutMs = 15000 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(2000),
      });
      if (acceptAny || (res.status >= 200 && res.status < 400)) {
        console.log(`[run] ${label} ready (status ${res.status})`);
        return;
      }
    }
    catch {
      // not yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`[run] ${label} never came up at ${url}`);
}

function spawnApi(dataDir: string): Subprocess {
  const debug = process.env.E2E_DEBUG_API === "true";
  // The orchestrator owns the OAuth surface — it must speak to its own
  // fixture dex on DEX_BASE, not whatever IdP the developer's `.env`
  // happens to point at. Strip OAUTH_* / APP_URL out of process.env so
  // a split-horizon dev config (issuer = external HTTPS, endpoints =
  // local nsl) cannot leak into the test API process, then re-inject the
  // values the orchestrator wants. `OAUTH_ISSUER` alone drives discovery;
  // the explicit endpoint overrides stay unset so the API picks them up
  // from /.well-known/openid-configuration against the fixture dex.
  const SCRUB = new Set([
    "OAUTH_ISSUER",
    "OAUTH_CLIENT_ID",
    "OAUTH_CLIENT_SECRET",
    "OAUTH_PKCE",
    "OAUTH_AUTHORIZE_URL",
    "OAUTH_TOKEN_URL",
    "OAUTH_USERINFO_URL",
    "OIDC_LOGOUT_URL",
    "APP_URL",
    "DEFAULT_ADMIN",
  ]);
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SCRUB.has(k))
      cleanEnv[k] = v;
  }
  // Bun otherwise auto-loads `<repo>/.env` (the developer's dev config) and
  // those values trump the ones we pass via `env:` below. Pointing at
  // /dev/null disables auto-loading so the orchestrator's env is final.
  return Bun.spawn(["bun", "--env-file=/dev/null", "src/index.ts"], {
    cwd: join(ROOT, "apps/api"),
    env: {
      ...cleanEnv,
      NODE_ENV: "development",
      PORT: String(API_PORT),
      HOST: "127.0.0.1",
      BASE_PATH: "/app",
      DB_PATH: join(dataDir, "app.db"),
      DB_ENCRYPTION: "true",
      LOG_LEVEL: "warn",
      LOG_FILE: join(dataDir, "api.log"),
      LOG_TO_STDOUT: "true",
      APP_URL: `http://127.0.0.1:${API_PORT}`,
      // Set CORS_ORIGIN so csrfGuard's Origin check is exercised end-to-end.
      // The test client (lib/api.ts) injects a matching Origin header by
      // default; the security suite overrides it to test the mismatch path.
      CORS_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      OAUTH_ISSUER: DEX_BASE,
      OAUTH_CLIENT_ID: "app",
      OAUTH_CLIENT_SECRET: "app-secret",
      OAUTH_PKCE: "true",
      DEFAULT_ADMIN: "admin@example.com",
      // Keep the creation throttle wired up (a middleware that crashed or
      // rejected everything must still fail the suite) but well clear of the
      // burst a fast functional run produces. The throttle's own behaviour is
      // covered by its unit tests and the workers smoke suite.
      CREATE_RATE_LIMIT_PER_MINUTE: "1000",
      CREATE_RATE_LIMIT_PER_HOUR: "10000",
      // Cron defaults to off; the orchestrator's e2e suite covers the
      // catalog routes, so flip it on for every API spawn.
      CRON_ENABLED: "true",
    },
    stdout: debug ? "inherit" : "pipe",
    stderr: debug ? "inherit" : "pipe",
  });
}

function parseJunit(xmlPath: string, phase: string): PhaseSummary {
  if (!existsSync(xmlPath)) {
    return {
      phase,
      tests: 0,
      assertions: 0,
      failures: 0,
      skipped: 0,
      time: 0,
      reportPath: xmlPath,
    };
  }
  const xml = readFileSync(xmlPath, "utf-8");
  const root = /<testsuites\b([^>]*)/.exec(xml);
  const attrs = root?.[1] ?? "";
  const num = (key: string) => Number(new RegExp(`${key}="([^"]+)"`).exec(attrs)?.[1] ?? 0);
  return {
    phase,
    tests: num("tests"),
    assertions: num("assertions"),
    failures: num("failures"),
    skipped: num("skipped"),
    time: num("time"),
    reportPath: xmlPath,
  };
}

async function runPhase(phaseId: string, label: string, paths: readonly string[], reportDir: string, extraEnv: Record<string, string> = {}): Promise<{ exit: number; summary: PhaseSummary }> {
  console.log(`[run] === ${label} ===`);
  const reportPath = join(reportDir, `${phaseId}.xml`);
  const result = await $`bun test --reporter=junit --reporter-outfile=${reportPath} ${paths}`.cwd(ROOT).env({
    ...process.env,
    E2E_API_BASE: API_BASE,
    E2E_DEX_BASE: DEX_BASE,
    E2E_PASSWORD: MASTER_PASSWORD,
    ...extraEnv,
  }).quiet().nothrow();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return {
    exit: result.exitCode,
    summary: parseJunit(reportPath, phaseId),
  };
}

function printSummary(summaries: readonly PhaseSummary[]): void {
  const total = summaries.reduce(
    (acc, s) => ({
      tests: acc.tests + s.tests,
      assertions: acc.assertions + s.assertions,
      failures: acc.failures + s.failures,
      skipped: acc.skipped + s.skipped,
      time: acc.time + s.time,
    }),
    {
      tests: 0,
      assertions: 0,
      failures: 0,
      skipped: 0,
      time: 0,
    },
  );

  const fmt = (n: number, w: number) => String(n).padStart(w);
  console.log("");
  console.log("──────────────────────────────────────────────────────────────");
  console.log("e2e summary");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  ${"phase".padEnd(36)} ${"tests".padStart(6)} ${"pass".padStart(6)} ${"fail".padStart(6)} ${"skip".padStart(6)} ${"time".padStart(8)}`);
  for (const s of summaries) {
    const pass = s.tests - s.failures - s.skipped;
    console.log(
      `  ${s.phase.padEnd(36)} ${fmt(s.tests, 6)} ${fmt(pass, 6)} ${fmt(s.failures, 6)} ${fmt(s.skipped, 6)} ${`${s.time.toFixed(2)}s`.padStart(8)}`,
    );
  }
  console.log(`  ${"─".repeat(58)}`);
  const totalPass = total.tests - total.failures - total.skipped;
  console.log(
    `  ${"TOTAL".padEnd(36)} ${fmt(total.tests, 6)} ${fmt(totalPass, 6)} ${fmt(total.failures, 6)} ${fmt(total.skipped, 6)} ${`${total.time.toFixed(2)}s`.padStart(8)}`,
  );
  console.log("──────────────────────────────────────────────────────────────");
}

async function main() {
  if (!existsSync(DEX_BIN)) {
    console.log("[run] dex missing; running install-dex.sh");
    await $`bash ${join(E2E_DIR, "scripts/install-dex.sh")}`;
  }

  // Per-run data dir under tests/e2e/.cache/data so it never collides with
  // the local dev DB at <repo>/data/db/app.db.
  if (!existsSync(DATA_ROOT))
    mkdirSync(DATA_ROOT, { recursive: true });
  if (!existsSync(REPORT_ROOT))
    mkdirSync(REPORT_ROOT, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const dataDir = mkdtempSync(join(DATA_ROOT, "run-"));
  const reportDir = join(REPORT_ROOT, runId);
  mkdirSync(reportDir, { recursive: true });
  console.log(`[run] data dir:    ${dataDir}`);
  console.log(`[run] report dir:  ${reportDir}`);

  let exitCode = 0;
  const summaries: PhaseSummary[] = [];
  let dex: Subprocess | null = null;
  let api: Subprocess | null = null;
  const stopApi = async () => {
    if (api) {
      api.kill();
      try {
        await api.exited;
      }
      catch {}
      api = null;
    }
  };
  const stopDex = async () => {
    if (dex) {
      dex.kill();
      try {
        await dex.exited;
      }
      catch {}
      dex = null;
    }
  };

  try {
    // ── 1. dex
    console.log("[run] starting dex");
    dex = Bun.spawn([DEX_BIN, "serve", DEX_CONFIG], { stdout: "pipe", stderr: "pipe" });
    await waitFor(`${DEX_BASE}/.well-known/openid-configuration`, "dex");

    // ── 2. API (encrypted, no DB → uninitialized).
    console.log("[run] starting api (phase A — uninitialized)");
    api = spawnApi(dataDir);
    await waitFor(`${API_BASE}/api/health`, "api", { acceptAny: true });

    // ── 3. encryption init phase. Read the auto-generated bootstrap token
    // off the filesystem and forward it to the test process.
    const bootstrapToken = readBootstrapToken(dataDir);
    const init = await runPhase("phase-a-encryption-init", "phase A: encryption init", [ENCRYPTION_INIT_TEST], reportDir, { E2E_BOOTSTRAP_TOKEN: bootstrapToken });
    summaries.push(init.summary);
    if (init.exit !== 0) {
      exitCode = init.exit;
      throw new Error("init phase failed; aborting");
    }

    // ── 4. modules (business modules + admin encryption ops which need an
    // unlocked + admin session)
    const modules = await runPhase("phase-b-modules", "phase B: module suites", [...MODULE_DIRS, ENCRYPTION_ADMIN_TEST], reportDir);
    summaries.push(modules.summary);
    if (modules.exit !== 0)
      exitCode = modules.exit;

    // ── 5. restart API to re-lock (rate-limit pass uses a fresh in-memory
    //      bucket; the unlock pass then gets a second restart so the limiter
    //      tripped by the burst does not bleed into it).
    await stopApi();
    console.log("[run] restarting api (phase C-rate-limit — locked)");
    api = spawnApi(dataDir);
    await waitFor(`${API_BASE}/api/health`, "api", { acceptAny: true });

    // ── 6. encryption rate-limit phase (locked, fresh limiter)
    const rateLimit = await runPhase("phase-c-encryption-rate-limit", "phase C: encryption rate-limit", [ENCRYPTION_RATE_LIMIT_TEST], reportDir);
    summaries.push(rateLimit.summary);
    if (rateLimit.exit !== 0)
      exitCode = rateLimit.exit;

    // ── 7. restart API to drop the rate-limit bucket before unlock
    await stopApi();
    console.log("[run] restarting api (phase C-unlock — locked, fresh limiter)");
    api = spawnApi(dataDir);
    await waitFor(`${API_BASE}/api/health`, "api", { acceptAny: true });

    // ── 8. encryption unlock phase
    const unlock = await runPhase("phase-c-encryption-unlock", "phase C: encryption unlock", [ENCRYPTION_UNLOCK_TEST], reportDir);
    summaries.push(unlock.summary);
    if (unlock.exit !== 0)
      exitCode = unlock.exit;
  }
  catch (err) {
    console.error("[run]", err instanceof Error
      ? err.message
      : err);
    if (exitCode === 0)
      exitCode = 1;
  }
  finally {
    await stopApi();
    await stopDex();
    if (existsSync(dataDir))
      rmSync(dataDir, { recursive: true, force: true });
  }

  // Always print the summary even if a phase aborted.
  printSummary(summaries);

  // Persist JSON summary alongside the XMLs and update the `latest` symlink.
  writeFileSync(
    join(reportDir, "summary.json"),
    `${JSON.stringify({ runId, phases: summaries, exitCode }, null, 2)}\n`,
  );
  const latest = join(REPORT_ROOT, "latest");
  try {
    rmSync(latest, { recursive: true, force: true });
  }
  catch {}
  try {
    symlinkSync(reportDir, latest, "dir");
  }
  catch {
    // symlink may fail on some FSes; fall back to a marker file.
    writeFileSync(`${latest}.txt`, reportDir);
  }

  // Trim historical reports — keep the 10 most recent runs.
  const runs = readdirSync(REPORT_ROOT).filter(n => n !== "latest" && !n.endsWith(".txt")).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - 10))) {
    rmSync(join(REPORT_ROOT, old), { recursive: true, force: true });
  }

  console.log(`\n[run] reports: ${reportDir}`);
  console.log(`[run] latest:  ${latest}`);
  process.exit(exitCode);
}

await main();
