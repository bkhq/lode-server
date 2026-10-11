import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * ROOT_DIR resolution:
 * 1. ROOT_DIR env var — explicit override
 * 2. Flattened lode package root — the bundled `index.js` sits next to
 *    `dist/` (SPA) and `drizzle/` (migrations); ROOT_DIR is that directory.
 * 3. Legacy Bun-compiled binary (/$bunfs) — process.cwd()
 * 4. Otherwise (dev / Vite) — 3 levels up from this file to monorepo root
 */
function detectRootDir(): string {
  if (process.env.ROOT_DIR) {
    return resolve(process.env.ROOT_DIR);
  }

  // `import.meta.url` is present on Bun, Node and Vite, but a runtime that
  // bundles the app into one non-file module (Cloudflare Workers) leaves it
  // undefined. Nothing on such a runtime reads the filesystem, so any stable
  // path satisfies the callers that only join onto ROOT_DIR.
  const metaUrl = import.meta.url as string | undefined;
  if (!metaUrl) {
    return "/";
  }

  const thisDir = dirname(fileURLToPath(metaUrl));

  // Packaged lode artifact: index.js + dist/ + drizzle/ are siblings.
  if (exists(resolve(thisDir, "dist/index.html")) || exists(resolve(thisDir, "drizzle/meta/_journal.json"))) {
    return thisDir;
  }

  // Compiled binary: Bun virtual filesystem
  if (thisDir.startsWith("/$bunfs")) {
    return process.cwd();
  }

  // Dev or Vite: this file is at apps/api/src/root.ts → go up 3 levels
  return resolve(thisDir, "../../..");
}

// This module is evaluated before any platform adapter is installed, so it
// cannot ask `platform.capabilities.filesystem` whether probing is safe. On
// a runtime without a real filesystem the probe simply reports "not found"
// and detection falls through to the source-tree layout, which is only ever
// used to resolve paths that such a runtime does not read anyway.
function exists(path: string): boolean {
  try {
    return existsSync(path);
  }
  catch {
    return false;
  }
}

export const ROOT_DIR = detectRootDir();
