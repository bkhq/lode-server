import type { Context } from "hono";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { getPlatform } from "@/platform";
import { ROOT_DIR } from "../../root";

// Vite emits hashed filenames for JS/CSS/asset bundles (e.g. `app-d4a91f.js`,
// `style-aa11bb.css`, fonts), which are content-addressed and safe to pin
// for a year. Anything else (index.html, /logo.svg) must revalidate so a
// deploy is picked up immediately. Locale JSONs now ship as hashed JS
// chunks under `assets/` (see apps/web/src/app/i18n.ts) and are covered
// by the same immutable rule.
const HASHED_ASSET_RE = /\.[a-f0-9]{8,}\.(?:js|css|woff2?|ttf|otf|svg|png|jpe?g|gif|ico|webp|map)$/i;
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE = "no-cache";
// Resolved on first use, not at module load: a runtime without a
// filesystem (Cloudflare Workers, where the SPA is served by the platform's
// own asset pipeline) must be able to import this module without touching
// `node:fs`.
let staticRoot: string | null | undefined;

function getStaticRoot(): string | null {
  if (staticRoot === undefined) {
    staticRoot = getPlatform().capabilities.filesystem ? resolveStaticRoot() : null;
  }
  return staticRoot;
}

export function serveStaticAssets(basePath: string) {
  return async (c: Context) => {
    const path = new URL(c.req.url).pathname;
    const direct = resolveStaticAsset(requestPathToAsset(path, basePath));
    const asset = direct ?? resolveStaticAsset("index.html");
    if (!asset) {
      return c.notFound();
    }
    const file = Bun.file(asset);
    const headers = new Headers();
    headers.set("Cache-Control", direct && HASHED_ASSET_RE.test(path) ? IMMUTABLE_CACHE : REVALIDATE_CACHE);
    // Bun.file infers Content-Type from extension. Forward it so secureHeaders
    // (set on the outer app) and CSP enforcement see the right mime.
    if (file.type) {
      headers.set("Content-Type", file.type);
    }
    return new Response(file, { headers });
  };
}

export function hasStaticAssets(): boolean {
  const root = getStaticRoot();
  return root !== null && isFile(resolve(root, "index.html"));
}

function resolveStaticRoot(): string {
  const packaged = resolve(ROOT_DIR, "dist");
  if (isFile(resolve(packaged, "index.html")))
    return packaged;
  return resolve(ROOT_DIR, "apps/web/dist");
}

function requestPathToAsset(path: string, basePath: string): string {
  let assetPath = path;
  if (basePath !== "") {
    if (assetPath === basePath || assetPath === `${basePath}/`)
      return "index.html";
    if (assetPath.startsWith(`${basePath}/`))
      assetPath = assetPath.slice(basePath.length + 1);
  }
  try {
    return decodeURIComponent(assetPath.replace(/^\/+/, "")) || "index.html";
  }
  catch {
    return "index.html";
  }
}

function resolveStaticAsset(assetPath: string): string | null {
  const root = getStaticRoot();
  if (root === null)
    return null;
  const candidate = resolve(root, assetPath);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel))
    return null;
  return isFile(candidate) ? candidate : null;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  }
  catch {
    return false;
  }
}
