#!/usr/bin/env bun
/**
 * Clean all local temporary files, build artifacts, and caches.
 *
 * Usage:
 *   bun run clean          # standard clean
 *   bun run clean --all    # also remove node_modules, data/db, data/uploads, e2e cache
 */
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { consola } from "consola";

const ROOT = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const all = args.has("--all");

const targets = [
  // Build output
  "dist",
  // Vite cache
  "apps/web/.vite",
  "apps/web/.tanstack",
  // Coverage
  "apps/api/coverage",
  // Turbo cache
  ".turbo",
  // PID lock
  "data/db/app.pid",
  // Logs
  "data/logs",
];

const allTargets = [
  // Node modules
  "node_modules",
  "apps/api/node_modules",
  "apps/web/node_modules",
  "packages/shared/node_modules",
  "packages/tsconfig/node_modules",
  // Local database, with its WAL/SHM and the encryption meta.db that pairs
  // with it. The template regenerates the squashed 0000_init migration in
  // place, so a dev DB from an earlier schema cannot be migrated — it has
  // to be rebuilt, and `app.db` without its `meta.db` (or vice versa) boots
  // into a locked state against a file that no longer matches.
  "data/db",
  // Test residue: per-test attachment trees and the e2e cache (run dirs +
  // dex binary + JUnit reports).
  "data/uploads",
  "tests/e2e/.cache",
];

let cleaned = 0;

for (const rel of targets) {
  const abs = resolve(ROOT, rel);
  if (existsSync(abs)) {
    rmSync(abs, { recursive: true, force: true });
    consola.log(`  removed ${rel}`);
    cleaned++;
  }
}

if (all) {
  for (const rel of allTargets) {
    const abs = resolve(ROOT, rel);
    if (existsSync(abs)) {
      rmSync(abs, { recursive: true, force: true });
      consola.log(`  removed ${rel}`);
      cleaned++;
    }
  }
}

if (cleaned === 0) {
  consola.log("  nothing to clean");
}
else {
  consola.log(`\n  cleaned ${cleaned} items`);
  if (all) {
    consola.log("  run 'bun install' to restore dependencies");
  }
}
