#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Validate the lode release artifacts produced by `scripts/package.ts` before
 * they are uploaded to a GitHub release. Fails fast on any structural or
 * manifest mismatch so a broken asset never ships.
 *
 * Inputs (env): RELEASE_VERSION, ASSET_NAME, ASSET_URL, APP_NAME.
 * Run from the repo root (reads ./dist).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

interface LodeAsset {
  readonly name?: string;
  readonly url?: string;
  readonly sha256?: string;
  readonly size?: number;
  readonly run?: string;
  readonly exec?: string;
  readonly [key: string]: unknown;
}

interface LodeManifest {
  readonly schema?: string;
  readonly name?: string;
  readonly channels?: { readonly stable?: { readonly latest?: string } };
  readonly versions?: Record<string, { readonly assets?: readonly LodeAsset[] }>;
}

function fail(msg: string): never {
  console.error(`[validate-lode-release] ${msg}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    fail(`${name} is required`);
  return value;
}

const version = requireEnv("RELEASE_VERSION");
const assetName = requireEnv("ASSET_NAME");
const assetUrl = requireEnv("ASSET_URL");
const appName = requireEnv("APP_NAME");

const dist = resolve(process.cwd(), "dist");
const assetPath = resolve(dist, assetName);
const manifestPath = resolve(dist, "manifest.json");
const checksumsPath = resolve(dist, "checksums.txt");

for (const p of [assetPath, manifestPath, checksumsPath]) {
  if (!existsSync(p))
    fail(`missing artifact: ${p}`);
}

// The tarball must carry the runtime entry, SPA, migrations, and native binding.
const listing = Bun.spawnSync(["tar", "-tzf", assetPath]);
if (listing.exitCode !== 0)
  fail(`tar -tzf failed for ${assetName}`);
const files = listing.stdout.toString();
const requiredPaths: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|\n)(?:\.\/)?index\.js(?:\n|$)/, "index.js"],
  [/(?:^|\n)(?:\.\/)?dist\/index\.html(?:\n|$)/, "dist/index.html"],
  [/(?:^|\n)(?:\.\/)?drizzle\/meta\/_journal\.json(?:\n|$)/, "drizzle/meta/_journal.json"],
  [/(?:^|\n)(?:\.\/)?node_modules\/@libsql\//, "node_modules/@libsql/"],
];
for (const [re, label] of requiredPaths) {
  if (!re.test(files))
    fail(`tarball missing required path: ${label}`);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as LodeManifest;
const asset = manifest.versions?.[version]?.assets?.find(a => a.name === assetName);

if (manifest.schema !== "lode/v1")
  fail("manifest schema must be lode/v1");
if (manifest.name !== appName)
  fail("manifest name mismatch");
if (manifest.channels?.stable?.latest !== version)
  fail("stable channel must point at the release version");
if (!asset)
  fail(`missing ${assetName} asset in manifest`);
if (asset.url !== assetUrl)
  fail("asset URL must match the GitHub release asset URL");
if (asset.run !== "bun index.js")
  fail("asset run command mismatch");
if (asset.exec !== "bun run")
  fail("asset exec command mismatch");
for (const stale of ["entry", "platform", "format"]) {
  if (stale in asset)
    fail(`asset \`${stale}\` is not part of lode/v1`);
}
if (!asset.sha256 || !asset.size)
  fail("asset integrity fields (sha256, size) are required");
if (!readFileSync(checksumsPath, "utf8").includes(assetName))
  fail("checksums.txt must reference the tarball");

console.log(`[validate-lode-release] OK: ${assetName} ${version} (sha256=${String(asset.sha256).slice(0, 12)}…, size=${asset.size})`);
