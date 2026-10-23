#!/usr/bin/env bun
// One-command dev: launches the bundled dex IdP and the app's dev server in
// the same process group. If OAUTH_ISSUER points elsewhere, dex is skipped
// and the user is sent back to `bun run dev`.
/* eslint-disable no-console */
import type { Subprocess } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { nslGet } from "./lib/nsl";

const ROOT = resolve(import.meta.dir, "..");
const APP_NAME = process.env.APP_NAME ?? "app";

const issuer = process.env.OAUTH_ISSUER;
// Match the dex-<app> subdomain convention this template uses; tolerant of
// arbitrary host suffix (nsl wildcards, *.localhost, custom dev TLS).
const BUNDLED_DEX = new RegExp(`(?:^|//)dex-${APP_NAME}[.\\-]`, "i");
const wantsBundledDex = !issuer || BUNDLED_DEX.test(issuer);

if (!wantsBundledDex) {
  console.log(`[dev-all] OAUTH_ISSUER=${issuer} — not the bundled dex.`);
  console.log("[dev-all] Skipping dex. Run `bun run dev` directly; the app reads OAUTH_* from .env.");
  process.exit(0);
}

// Detect the most common newcomer pitfall: a fresh `.env` copied from
// `.env.example` with the "Bundled dex IdP (local dev)" block still
// commented out. `dev:all` only makes sense when the app is configured
// to talk to the bundled dex, so guide the operator before spinning up
// dex + the dev server in a config that won't actually authenticate.
//
// Scan the `.env` file text rather than `process.env` because the user
// may have only exported a shell variable while leaving `.env` untouched
// — `bun run` reloads `.env` into the API process so the file is the
// source of truth.
function dexBlockSealed(): boolean {
  let text: string;
  try {
    text = readFileSync(resolve(ROOT, ".env"), "utf-8");
  }
  catch {
    // No .env at all — fresh checkout. Treat as "sealed" so we prompt
    // the user to populate one rather than booting against missing
    // OAUTH_* config.
    return true;
  }
  // An uncommented OAUTH_ISSUER anywhere in the file means the operator
  // committed to *some* IdP. Trust that and continue.
  if (/^\s*OAUTH_ISSUER=/m.test(text))
    return false;
  return true;
}

if (dexBlockSealed()) {
  console.error("[dev-all] .env has no uncommented OAUTH_ISSUER — bundled dex block is still sealed.");
  console.error("[dev-all] Edit .env and uncomment the \"Bundled dex IdP (local dev)\" block:");
  console.error("[dev-all]   OAUTH_ISSUER=http://dex-app.localhost:3355");
  console.error("[dev-all]   OAUTH_CLIENT_ID=app  OAUTH_CLIENT_SECRET=app-secret");
  console.error("[dev-all]   APP_URL=http://app.localhost:3355  DEFAULT_ADMIN=admin@example.com");
  console.error("[dev-all] Or, to use an external IdP, configure OAUTH_* in .env and run `bun run dev`.");
  process.exit(1);
}

const children: Subprocess[] = [];
let shuttingDown = false;

function spawn(cmd: string[], label: string): Subprocess {
  const proc = Bun.spawn(cmd, {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  children.push(proc);
  void proc.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`[dev-all] ${label} exited (code=${code}); shutting down siblings`);
      void shutdown();
    }
  });
  return proc;
}

async function shutdown(): Promise<void> {
  if (shuttingDown)
    return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    }
    catch {}
  }
  await Promise.allSettled(children.map(c => c.exited));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

console.log("[dev-all] starting dex + dev server");
spawn(["bun", "scripts/dev-dex.ts"], "dex");

// Always poll dex through the local nsl URL — the issuer may be an external
// HTTPS URL gated by a firewall, and dev shouldn't depend on external reach.
const probeUrl = nslGet(`dex-${APP_NAME}`);
if (!probeUrl) {
  console.error("[dev-all] nsl could not resolve local dex URL; aborting");
  void shutdown();
  process.exit(1);
}
const deadline = Date.now() + 20_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${probeUrl}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(1500),
    });
    if (r.ok) {
      ready = true;
      break;
    }
  }
  catch {}
  await Bun.sleep(300);
}
if (!ready) {
  console.error("[dev-all] dex did not become ready in 20s; aborting");
  void shutdown();
  process.exit(1);
}

console.log("[dev-all] dex ready, starting dev server");
spawn(["bun", "run", "dev"], "dev");

await new Promise(() => {});
