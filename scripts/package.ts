#!/usr/bin/env bun
/* eslint-disable no-console */
import { Glob } from "bun";
/**
 * Build a lode-compatible release asset.
 *
 * The asset is a runtime directory packed as tar.gz containing a root API
 * bundle entry (`index.js`), the built SPA under `dist/`, Drizzle migrations
 * under `drizzle/`, the libsql native binding under `node_modules/@libsql/`,
 * and a `package.json` exposing concise CLI passthroughs. lode downloads the
 * asset, verifies it, and runs `bun index.js`.
 *
 * Usage:  bun scripts/package.ts [--app-name <n>] [--version <v>] [--asset-name <file>] [--asset-url <url>] [--channel <c>]
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
}

const { values: args } = parseArgs({
  options: {
    "app-name": { type: "string" },
    "version": { type: "string" },
    "asset-suffix": { type: "string" },
    "asset-name": { type: "string" },
    "asset-url": { type: "string" },
    "channel": { type: "string", default: "stable" },
  },
  strict: false,
});

const ROOT = resolve(import.meta.dir, "..");
const DIST = resolve(ROOT, "dist");
const STAGE = resolve(DIST, "package");
const API_DIST = resolve(ROOT, "apps/api/dist");
const WEB_DIST = resolve(ROOT, "apps/web/dist");
const DRIZZLE_DIR = resolve(ROOT, "apps/api/drizzle");

const rootPackage = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as PackageJson;
const apiPackage = JSON.parse(readFileSync(resolve(ROOT, "apps/api/package.json"), "utf-8")) as PackageJson;

const appName = (args["app-name"] as string | undefined) ?? process.env.APP_NAME ?? "app";
const version = (args.version as string | undefined) ?? process.env.RELEASE_VERSION ?? rootPackage.version ?? apiPackage.version ?? "0.0.0";
const channel = (args.channel as string | undefined) ?? "stable";
const assetSuffix = (args["asset-suffix"] as string | undefined) ?? process.env.ASSET_SUFFIX ?? defaultAssetSuffix();

function defaultAssetSuffix(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch;
  return `${os}-${arch}`;
}

async function run(cmd: readonly string[], cwd = ROOT): Promise<void> {
  console.log(`[package] ${cmd.join(" ")}`);
  const child = Bun.spawn(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  const code = await child.exited;
  if (code !== 0)
    throw new Error(`command failed (${code}): ${cmd.join(" ")}`);
}

function tryRun(cmd: readonly string[]): string {
  try {
    const result = Bun.spawnSync(cmd, { cwd: ROOT });
    return result.stdout.toString().trim();
  }
  catch {
    return "";
  }
}

function resolveBuildTime(): string {
  const envBuildTime = (process.env.BUILD_TIME ?? "").trim();
  if (envBuildTime)
    return envBuildTime;

  const epoch = (process.env.SOURCE_DATE_EPOCH ?? "").trim();
  if (epoch && /^\d+$/.test(epoch)) {
    const seconds = Number.parseInt(epoch, 10);
    if (Number.isFinite(seconds))
      return new Date(seconds * 1000).toISOString();
  }

  const commitIso = tryRun(["git", "show", "-s", "--format=%cI", "HEAD"]);
  if (commitIso)
    return new Date(commitIso).toISOString();

  return new Date().toISOString();
}

// libsql is a native addon: `bun build --target bun` bundles the JS wrapper but
// leaves the platform package (`@libsql/<target>`, holding index.node) as an
// external require resolved from disk next to index.js. Stage the native
// package(s) so the flat tarball runs under `bun index.js` without an install.
function stageLibsqlNative(): void {
  const bunStore = resolve(ROOT, "node_modules/.bun");
  const glob = new Glob("libsql@*/node_modules/@libsql");
  let staged = 0;
  for (const match of glob.scanSync({ cwd: bunStore, onlyFiles: false })) {
    const src = resolve(bunStore, match);
    if (!existsSync(src))
      continue;
    // Dereference symlinks so the tarball carries the real index.node bytes.
    cpSync(src, resolve(STAGE, "node_modules/@libsql"), { recursive: true, dereference: true });
    staged++;
  }
  if (staged === 0)
    throw new Error("libsql native binding not found under node_modules/.bun; run `bun install` first");
  if (!existsSync(resolve(STAGE, "node_modules/@libsql")))
    throw new Error("libsql native binding staging produced no @libsql directory");
}

const envCommit = (process.env.BUILD_COMMIT ?? process.env.GITHUB_SHA ?? "").trim();
const commit = (envCommit ? envCommit.slice(0, 12) : "") || tryRun(["git", "rev-parse", "--short=12", "HEAD"]) || "unknown";
const buildTime = resolveBuildTime();

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
mkdirSync(DIST, { recursive: true });

console.log("[package] Building web...");
await run(["bun", "run", "--filter", "@app/web", "build"]);

console.log("[package] Building API bundle...");
rmSync(API_DIST, { recursive: true, force: true });
await run([
  "bun",
  "build",
  "src/index.ts",
  "--outdir",
  "dist",
  "--target",
  "bun",
  "--minify",
  "--define",
  `BUILD_COMMIT=${JSON.stringify(commit)}`,
  "--define",
  `BUILD_TIME=${JSON.stringify(buildTime)}`,
  "--define",
  `BUILD_VERSION=${JSON.stringify(version)}`,
], resolve(ROOT, "apps/api"));

for (const path of [resolve(API_DIST, "index.js"), resolve(WEB_DIST, "index.html"), resolve(DRIZZLE_DIR, "meta/_journal.json")]) {
  if (!existsSync(path))
    throw new Error(`required build input missing: ${path}`);
}

cpSync(resolve(API_DIST, "index.js"), resolve(STAGE, "index.js"));
cpSync(WEB_DIST, resolve(STAGE, "dist"), { recursive: true });
cpSync(DRIZZLE_DIR, resolve(STAGE, "drizzle"), { recursive: true });
stageLibsqlNative();
await Bun.write(resolve(STAGE, "package.json"), `${JSON.stringify({
  name: appName,
  version,
  type: "module",
  private: true,
  scripts: {
    "start": "bun index.js",
    "healthcheck": "bun index.js healthcheck",
    "migrate:check": "bun index.js migrate --check",
  },
}, null, 2)}\n`);

const assetName = (args["asset-name"] as string | undefined) ?? process.env.ASSET_NAME ?? `${appName}-${assetSuffix}.tar.gz`;
const assetPath = resolve(DIST, assetName);
rmSync(assetPath, { force: true });
await run(["tar", "-czf", assetPath, "-C", STAGE, "."]);

const hasher = new Bun.CryptoHasher("sha256");
hasher.update(new Uint8Array(await Bun.file(assetPath).arrayBuffer()));
const sha256 = hasher.digest("hex");
const size = statSync(assetPath).size;
const assetUrl = (args["asset-url"] as string | undefined) ?? process.env.ASSET_URL ?? `https://example.com/releases/${assetName}`;

const manifest = {
  schema: "lode/v1",
  name: appName,
  channels: {
    [channel]: { latest: version },
  },
  versions: {
    [version]: {
      assets: [
        {
          name: assetName,
          url: assetUrl,
          sha256,
          size,
          // lode launches via run/exec; keep byte-identical to deploy/lode.toml
          // [command]. An asset's run/exec override the operator config.
          run: "bun index.js",
          exec: "bun run",
          auth: true,
        },
      ],
    },
  },
};

await Bun.write(resolve(DIST, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await Bun.write(resolve(DIST, "checksums.txt"), `${sha256}  ${basename(assetPath)}\n`);

console.log(`[package] Asset: ${assetPath}`);
console.log(`[package] SHA-256: ${sha256}`);
console.log("[package] Manifest: dist/manifest.json");
