#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Bundled dex IdP for local development.
 *
 * Usage:
 *   bun run dev:dex                                    # auto-detect via nsl
 *   bun run dev:dex --issuer https://idp.example.com   # override public URL
 *   bun run dev:dex --app-url https://app.example.com
 *   bun run dev:dex --client-id myapp --client-secret xyz
 *
 * Note on issuer: OIDC pins the issuer string into every id_token, so a
 * single dex instance can serve only ONE issuer at a time. To use a
 * different URL (e.g. switch local HTTP ↔ external HTTPS), restart this
 * script with a different `--issuer` / `--app-url`. There is no way to
 * make one dex instance answer for both URLs simultaneously.
 *
 * This script ONLY runs dex. Start the app separately with `bun run dev`
 * in another terminal; the app reads OAUTH_* from `.env`.
 *
 * Resolution priority for every knob:  CLI flag > env var > nsl get > default
 */
import type { Subprocess } from "bun";
import { $ } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { nslGet } from "./lib/nsl";

const { values: cli } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "issuer": { type: "string" },
    "app-url": { type: "string" },
    "client-id": { type: "string" },
    "client-secret": { type: "string" },
    "admin": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const ROOT = resolve(import.meta.dir, "..");
const E2E_DIR = join(ROOT, "tests/e2e");
const DEX_BIN = join(E2E_DIR, ".cache/dex");
const DEX_DEV_DIR = join(E2E_DIR, ".cache/dev-dex");
const DEX_CONFIG = join(DEX_DEV_DIR, "config.yaml");
const APP_NAME = process.env.APP_NAME ?? "lode-server";

// Normalise BASE_PATH like apps/api/src/config.ts: empty means root,
// otherwise "/<x>" with no trailing slash. Used to build the OAuth callback
// URI that dex will whitelist.
const trimmedBase = (process.env.BASE_PATH ?? "").replace(/^\/+|\/+$/g, "");
const BASE_PATH = trimmedBase ? `/${trimmedBase}` : "";

// App is served as `${APP_NAME}.localhost`; dex is a sibling single-label
// subdomain `dex-${APP_NAME}.localhost`. The hyphen (rather than a dot)
// keeps the hostname one level deep so nsl's `*.localhost` wildcard TLS
// cert covers both, while the browser still sees two independent origins
// for cookie / CORS purposes.
const APP_URL_DEFAULT = nslGet(APP_NAME) ?? "http://localhost:3000";
const DEX_URL_DEFAULT = nslGet(`dex-${APP_NAME}`) ?? "http://localhost:5567";

// The dex issuer and the app's `OAUTH_ISSUER` must be identical (OIDC pins
// the issuer into every id_token). Treat OAUTH_ISSUER as the canonical
// source so one .env entry feeds both this script and the API.
const APP_URL = cli["app-url"] ?? process.env.APP_URL ?? APP_URL_DEFAULT;
const DEX_ISSUER = cli.issuer ?? process.env.OAUTH_ISSUER ?? DEX_URL_DEFAULT;
const OAUTH_CLIENT_ID = cli["client-id"] ?? process.env.OAUTH_CLIENT_ID ?? APP_NAME;
const OAUTH_CLIENT_SECRET = cli["client-secret"] ?? process.env.OAUTH_CLIENT_SECRET ?? `${APP_NAME}-secret`;
const DEFAULT_ADMIN = cli.admin ?? process.env.DEFAULT_ADMIN ?? "admin@example.com";

if (!existsSync(DEX_BIN)) {
  console.log("[dev-dex] installing dex binary…");
  await $`bash ${join(E2E_DIR, "scripts/install-dex.sh")}`;
}

mkdirSync(DEX_DEV_DIR, { recursive: true });
// `issuer` is the public-facing URL the browser sees (via nsl); `web.http`
// is the loopback bind address that nsl proxies to. Dex uses the path
// component of `issuer` as a prefix for every endpoint, so a path-less
// hostname like `dex-app.localhost` makes dex serve `/auth`, `/token`, … at
// the root — exactly what `nsl run --name dex-app` forwards.
//
// `__PORT__` is filled in at launch time by the sh wrapper below, from the
// `$PORT` env that nsl injects into the spawned child. Templating the file
// means we do not have to commit to a fixed port in advance — nsl can pick
// one from its allocation range and dex picks up the same value.
const dexConfigTemplate = `issuer: ${DEX_ISSUER}
storage:
  type: memory
web:
  http: 127.0.0.1:__PORT__
  allowedOrigins: ["*"]
oauth2:
  skipApprovalScreen: true
expiry:
  idTokens: 8h
  refreshTokens:
    validIfNotUsedFor: 24h
staticClients:
  - id: ${OAUTH_CLIENT_ID}
    secret: ${OAUTH_CLIENT_SECRET}
    redirectURIs:
      - ${APP_URL}${BASE_PATH}/api/account/auth/callback
    name: ${APP_NAME} dev
enablePasswordDB: true
staticPasswords:
  # bcrypt hash of "admin" — local dev only, matches the e2e fixture so
  # the same admin@example.com / admin credential works in both
  # "bun run dev" and "bun run test:e2e". Operators who do not want a
  # publicly-known password rotate staticPasswords here, or point
  # OAUTH_ISSUER at a real IdP and skip dev:dex entirely.
  - email: ${DEFAULT_ADMIN}
    hash: "$2b$10$UrL8u9yDL7isi7fFZnKwJuT3tWh3zIs3jlbEK4glmIK/zZZqNNBcO"
    username: admin
    userID: dev-admin
  - email: user@example.com
    hash: "$2b$10$UrL8u9yDL7isi7fFZnKwJuT3tWh3zIs3jlbEK4glmIK/zZZqNNBcO"
    username: user
    userID: dev-user
`;
const DEX_CONFIG_TEMPLATE = `${DEX_CONFIG}.template`;
writeFileSync(DEX_CONFIG_TEMPLATE, dexConfigTemplate);

// Launch wrapper: `__PORT__` is only known once nsl picks a port and injects
// `$PORT` into the spawned child, so the substitution must happen at launch
// time, not here. Instead of a `sed | exec` shell pipeline that splices repo
// paths into a `sh -c` string (injection-shaped — paths could contain shell
// metacharacters), run a small Bun child via an argv array: it reads the
// template, does the `__PORT__` → $PORT replace in TS, writes the config,
// then `exec`s dex via execvp so dex stays the direct child of nsl and
// signals / lifetime still propagate without an extra layer. All paths are
// passed via env, never interpolated into a shell string.
const launchProgram = `
const { readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const tpl = readFileSync(process.env.DEX_CONFIG_TEMPLATE, "utf-8");
const port = process.env.PORT ?? "";
writeFileSync(process.env.DEX_CONFIG, tpl.replaceAll("__PORT__", port));
const child = spawn(process.env.DEX_BIN, ["serve", process.env.DEX_CONFIG], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
`;

console.log(`[dev-dex] starting dex on ${DEX_ISSUER}`);
const dex: Subprocess = Bun.spawn(
  ["nsl", "run", "--name", `dex-${APP_NAME}`, "--force", "bun", "-e", launchProgram],
  {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      DEX_CONFIG_TEMPLATE,
      DEX_CONFIG,
      DEX_BIN,
    },
  },
);

// Always probe the local nsl URL — the issuer may be an external HTTPS URL
// gated by a firewall, and dev shouldn't depend on external reachability.
const DEX_PROBE_URL = nslGet(`dex-${APP_NAME}`);
if (!DEX_PROBE_URL) {
  console.error("[dev-dex] nsl could not resolve local dex URL; aborting");
  dex.kill();
  process.exit(1);
}
const deadline = Date.now() + 15_000;
let dexReady = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${DEX_PROBE_URL}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      dexReady = true;
      break;
    }
  }
  catch {
    // not yet
  }
  await Bun.sleep(250);
}
if (!dexReady) {
  console.error("[dev-dex] dex did not become ready in 15s; aborting");
  dex.kill();
  process.exit(1);
}
console.log(`[dev-dex] dex ready · login: ${DEFAULT_ADMIN} / admin`);
console.log("[dev-dex] expected .env (matching values):");
console.log(`            OAUTH_ISSUER=${DEX_ISSUER}`);
console.log(`            OAUTH_CLIENT_ID=${OAUTH_CLIENT_ID}`);
console.log(`            OAUTH_CLIENT_SECRET=${OAUTH_CLIENT_SECRET}`);
console.log(`            APP_URL=${APP_URL}`);
console.log(`            DEFAULT_ADMIN=${DEFAULT_ADMIN}`);
console.log("[dev-dex] run `bun run dev` in another terminal to start the app.");

let stopped = false;
async function stop(): Promise<void> {
  if (stopped)
    return;
  stopped = true;
  console.log("\n[dev-dex] shutting down");
  dex.kill();
  await dex.exited.catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

void dex.exited.then(() => void stop());

// Keep the script alive while dex runs.
await new Promise(() => {});
