#!/usr/bin/env bun
// One-shot rebrand helper. Rewrites .env defaults and every package.json
// (top-level + apps/* + packages/*). Optional --scope renames the @app/*
// package scope. Prints manual follow-ups it can't do safely (git remote,
// logo, lockfile regen).
//
// Usage:
//   bun scripts/rebrand.ts \
//     --name myapp --display "My App" \
//     [--scope myorg] [--repo https://github.com/myorg/myapp] \
//     [--description "Internal tools for myorg"] [--dry-run]
/* eslint-disable no-console */
import { Glob } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values: cli } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "name": { type: "string" },
    "display": { type: "string" },
    "scope": { type: "string" },
    "repo": { type: "string" },
    "description": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "help": { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (cli.help || (!cli.name && !cli.display && !cli.scope && !cli.repo && !cli.description)) {
  console.log(
    "Usage: bun scripts/rebrand.ts --name <slug> --display \"<Display Name>\" "
    + "[--scope <packageScope>] [--repo <git-url>] [--description <text>] [--dry-run]",
  );
  process.exit(cli.help ? 0 : 1);
}

const APP_NAME = cli.name;
const APP_DISPLAY = cli.display;
const SCOPE = cli.scope?.replace(/^@/, "");
const REPO_URL = cli.repo;
const DESCRIPTION = cli.description;
const DRY_RUN = !!cli["dry-run"];

const RE_NAME = /^[a-z][a-z0-9-]*$/;
if (APP_NAME && !RE_NAME.test(APP_NAME)) {
  console.error(`--name must match /^[a-z][a-z0-9-]*/, got "${APP_NAME}"`);
  process.exit(1);
}
if (SCOPE && !RE_NAME.test(SCOPE)) {
  console.error(`--scope must match /^[a-z][a-z0-9-]*/, got "${SCOPE}"`);
  process.exit(1);
}

const ROOT = resolve(import.meta.dir, "..");

interface Change {
  readonly file: string;
  readonly note: string;
}
const changes: Change[] = [];

// Set when at least one package.json scope was actually rewritten, so the
// final report can loudly flag the now-stale bun.lock.
let scopeRenamed = false;

function write(file: string, content: string, note: string): void {
  const path = resolve(ROOT, file);
  if (DRY_RUN) {
    changes.push({ file, note: `[dry-run] ${note}` });
    return;
  }
  writeFileSync(path, content);
  changes.push({ file, note });
}

// ─── 1. .env.example + .env ───
function rewriteEnvFile(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(resolve(ROOT, path), "utf-8");
  }
  catch {
    return false;
  }

  let next = text;
  if (APP_NAME !== undefined) {
    next = next.replace(/^#?\s*APP_NAME=.*$/m, `APP_NAME=${APP_NAME}`);
    if (!/^APP_NAME=/m.test(next))
      next += `\nAPP_NAME=${APP_NAME}\n`;

    // Bundled-dex IdP block (commented in .env.example, sometimes
    // uncommented in .env). Rewrite the four URLs / ids that mention
    // the literal `app` slug so a fresh fork pointing at the bundled
    // dex lands on `<name>.localhost` / `dex-<name>.localhost` instead
    // of the template's `app.localhost`. The values stay commented when
    // they started commented; uncommented in .env stay uncommented.
    next = next
      .replace(/dex-app\.localhost/g, `dex-${APP_NAME}.localhost`)
      .replace(/dex-app\.a\.wd\.ds\.cc/g, `dex-${APP_NAME}.a.wd.ds.cc`)
      .replace(/(\bhttp:\/\/)app\.localhost\b/g, `$1${APP_NAME}.localhost`)
      .replace(/(\bhttps:\/\/)app\.a\.wd\.ds\.cc\b/g, `$1${APP_NAME}.a.wd.ds.cc`)
      .replace(/^(#?\s*OAUTH_CLIENT_ID=)app$/m, `$1${APP_NAME}`)
      .replace(/^(#?\s*OAUTH_CLIENT_SECRET=)app-secret$/m, `$1${APP_NAME}-secret`);
  }
  if (APP_DISPLAY !== undefined) {
    next = next.replace(/^#?\s*APP_DISPLAY_NAME=.*$/m, `APP_DISPLAY_NAME=${APP_DISPLAY}`);
    if (!/^APP_DISPLAY_NAME=/m.test(next))
      next += `\nAPP_DISPLAY_NAME=${APP_DISPLAY}\n`;
  }
  if (next !== text)
    write(path, next, "set APP_NAME / APP_DISPLAY_NAME / dex block");
  return true;
}
rewriteEnvFile(".env.example");
rewriteEnvFile(".env");
rewriteEnvFile("examples/compose/.env.example");

// ─── 1b. examples/compose/compose.yml ───
// The reference docker-compose stack hardcodes the slug as the default
// for `${APP_NAME:-app}:local` image name. Rewriting the default keeps
// `docker compose up` ergonomic for a fresh fork even when the operator
// hasn't yet copied .env.example to .env. The other `${APP_NAME:-...}`
// usages flow from the same default so a single replacement suffices.
function rewriteComposeFile(): void {
  if (APP_NAME === undefined)
    return;
  const path = "examples/compose/compose.yml";
  let text: string;
  try {
    text = readFileSync(resolve(ROOT, path), "utf-8");
  }
  catch {
    return;
  }
  // Replace every `${VAR:-app}` default whose VAR is one of the
  // app-slug-bearing knobs. Restrict to the explicit list so we don't
  // accidentally touch unrelated `:-app` defaults that might appear in
  // future additions to the compose file.
  const next = text.replace(
    /\$\{(APP_NAME|APP_DISPLAY_NAME|OAUTH_CLIENT_ID|OAUTH_CLIENT_SECRET):-([^}]+)\}/g,
    (match, key: string, def: string) => {
      let nextDef = def;
      if (key === "APP_NAME" && def === "app")
        nextDef = APP_NAME;
      else if (key === "APP_DISPLAY_NAME" && def === "App" && APP_DISPLAY !== undefined)
        nextDef = APP_DISPLAY;
      else if (key === "OAUTH_CLIENT_ID" && def === "app")
        nextDef = APP_NAME;
      else if (key === "OAUTH_CLIENT_SECRET" && def === "app-secret")
        nextDef = `${APP_NAME}-secret`;
      return nextDef === def ? match : `\${${key}:-${nextDef}}`;
    },
  );
  if (next !== text)
    write(path, next, "rewrite compose APP_NAME / OAUTH_* defaults");
}
rewriteComposeFile();

// ─── 1c. Dockerfile ───
// Only rewrite ENV / LABEL / HEALTHCHECK lines whose literal value is
// `app` / `App` *as a slug*. Structural references — `WORKDIR /app`
// (filesystem path), `useradd app` (system user), `./app` (compiled
// binary name), `mkdir -p /app/...` (image-internal paths) — are NOT
// branding surfaces and stay untouched. The two slug-bearing spots are
// the `APP_NAME=app` / `APP_DISPLAY_NAME=App` ENV defaults a downstream
// fork may add to bake the slug into the image without relying on
// `docker run -e`; this rewriter handles them if present.
function rewriteDockerfile(): void {
  if (APP_NAME === undefined && APP_DISPLAY === undefined)
    return;
  const path = "Dockerfile";
  let text: string;
  try {
    text = readFileSync(resolve(ROOT, path), "utf-8");
  }
  catch {
    return;
  }
  let next = text;
  if (APP_NAME !== undefined) {
    // `ENV APP_NAME=app` — slug ENV default. Match only the exact slug
    // literal so a deployment that already customised it survives.
    next = next.replace(/^(ENV APP_NAME=)app$/m, `$1${APP_NAME}`);
  }
  if (APP_DISPLAY !== undefined) {
    next = next.replace(/^(ENV APP_DISPLAY_NAME=)App$/m, `$1${APP_DISPLAY}`);
    // OCI image title label — keep human-readable. Update in place if
    // present; do not synthesise a new one (Dockerfile shape stays the
    // operator's call).
    next = next.replace(
      /^(LABEL org\.opencontainers\.image\.title=)"App"$/m,
      `$1"${APP_DISPLAY}"`,
    );
  }
  if (next !== text)
    write(path, next, "rewrite APP_NAME / APP_DISPLAY_NAME ENV + OCI title label");
}
rewriteDockerfile();

// ─── 1d. Source fallback literals ───
// `rebrand.ts` rewrites .env so a fork's *runtime* APP_NAME is correct,
// but two dev scripts, the web vite config, and the config schema
// hard-code `"app"` / `"App"` as the last-resort fallback used when the
// env var is unset (commented .env, CI without .env, `bun run dev` /
// `bun run dev:dex` before the operator edits .env). The vite config
// fallback is what the document <title> resolves to, so missing it
// leaves a rebranded fork still serving "App". Without this step a
// freshly rebranded fork still prints / serves the template slug from
// those paths. Match only the exact template literal so a fork that
// already customised the fallback by hand survives.
function rewriteSourceFallbacks(): void {
  if (APP_NAME === undefined && APP_DISPLAY === undefined)
    return;

  // dev scripts: `process.env.APP_NAME ?? "app"`
  if (APP_NAME !== undefined) {
    for (const rel of ["scripts/dev-dex.ts", "scripts/dev-all.ts"]) {
      let text: string;
      try {
        text = readFileSync(resolve(ROOT, rel), "utf-8");
      }
      catch {
        continue;
      }
      const next = text.replace(
        /(process\.env\.APP_NAME \?\? ")app(")/g,
        `$1${APP_NAME}$2`,
      );
      if (next !== text)
        write(rel, next, "rewrite APP_NAME fallback literal");
    }
  }

  // web vite config: `process.env.APP_NAME ?? "app"` /
  // `process.env.APP_DISPLAY_NAME ?? "App"`. These resolve the document
  // <title> at config-load time; `bun run dev` does not forward .env into
  // the vite child, so without this rewrite a rebranded fork keeps the
  // template title in dev.
  {
    const viteRel = "apps/web/vite.config.ts";
    let text: string | undefined;
    try {
      text = readFileSync(resolve(ROOT, viteRel), "utf-8");
    }
    catch {
      text = undefined;
    }
    if (text !== undefined) {
      let next = text;
      if (APP_NAME !== undefined) {
        next = next.replace(
          /(process\.env\.APP_NAME \?\? ")app(")/g,
          `$1${APP_NAME}$2`,
        );
      }
      if (APP_DISPLAY !== undefined) {
        next = next.replace(
          /(process\.env\.APP_DISPLAY_NAME \?\? ")App(")/g,
          `$1${APP_DISPLAY}$2`,
        );
      }
      if (next !== text)
        write(viteRel, next, "rewrite APP_NAME / APP_DISPLAY_NAME fallback literal");
    }
  }

  // config schema: APP_NAME `.default("app")` / APP_DISPLAY_NAME `.default("App")`
  const schemaRel = "apps/api/src/config/schema.ts";
  let schema: string;
  try {
    schema = readFileSync(resolve(ROOT, schemaRel), "utf-8");
  }
  catch {
    return;
  }
  let nextSchema = schema;
  if (APP_NAME !== undefined) {
    nextSchema = nextSchema.replace(
      /(APP_NAME: z\.string\(\)[^\n]*\.default\(")app("\))/,
      `$1${APP_NAME}$2`,
    );
  }
  if (APP_DISPLAY !== undefined) {
    nextSchema = nextSchema.replace(
      /(APP_DISPLAY_NAME: z\.string\(\)[^\n]*\.default\(")App("\))/,
      `$1${APP_DISPLAY}$2`,
    );
  }
  if (nextSchema !== schema)
    write(schemaRel, nextSchema, "rewrite APP_NAME / APP_DISPLAY_NAME schema default");
}
rewriteSourceFallbacks();

// ─── 1e. README.md ───
// Conservative literal replacements only — the README is prose, so we touch
// just the two unambiguous template-name surfaces: the `# App Template` H1
// (display name) and the `app.localhost` dev hostname (slug, mirrors the
// .env rewrite in step 1). Anything subtler (feature copy, prose mentions of
// "app") is left for the operator. Dry-run honoured via `write`.
function rewriteReadme(): void {
  if (APP_NAME === undefined && APP_DISPLAY === undefined)
    return;
  const path = "README.md";
  let text: string;
  try {
    text = readFileSync(resolve(ROOT, path), "utf-8");
  }
  catch {
    return;
  }
  let next = text;
  if (APP_DISPLAY !== undefined) {
    // Top-of-file H1 only — match the exact template literal so a fork
    // that already retitled the README survives.
    next = next.replace(/^# App Template$/m, `# ${APP_DISPLAY}`);
  }
  if (APP_NAME !== undefined) {
    next = next.replace(/(\bhttps?:\/\/)app\.localhost\b/g, `$1${APP_NAME}.localhost`);
  }
  if (next !== text)
    write(path, next, "rewrite README H1 / app.localhost dev host");
}
rewriteReadme();

// ─── 2. package.json files ───
const manifestGlobs = ["package.json", "apps/*/package.json", "packages/*/package.json"];
const manifests: string[] = [];
for (const pattern of manifestGlobs) {
  for await (const f of new Glob(pattern).scan({ cwd: ROOT, absolute: false }))
    manifests.push(f);
}

interface Manifest {
  name?: string;
  description?: string;
  homepage?: string;
  repository?: { type?: string; url?: string; directory?: string };
  [k: string]: unknown;
}

for (const rel of manifests) {
  const path = resolve(ROOT, rel);
  const raw = readFileSync(path, "utf-8");
  const json = JSON.parse(raw) as Manifest;
  const before = JSON.stringify(json);

  if (SCOPE && typeof json.name === "string" && json.name.startsWith("@app/")) {
    json.name = json.name.replace(/^@app\//, `@${SCOPE}/`);
    scopeRenamed = true;
  }
  if (SCOPE && json.name === "@app/monorepo") {
    json.name = `@${SCOPE}/monorepo`;
    scopeRenamed = true;
  }

  if (DESCRIPTION !== undefined && rel === "package.json")
    json.description = DESCRIPTION;

  if (REPO_URL !== undefined) {
    json.homepage = REPO_URL;
    json.repository = { type: "git", url: `${REPO_URL.replace(/\.git$/, "")}.git`, ...(json.repository?.directory ? { directory: json.repository.directory } : {}) };
  }

  if (JSON.stringify(json) !== before) {
    // Match prevailing 2-space indentation; preserve trailing newline.
    const out = `${JSON.stringify(json, null, 2)}\n`;
    write(rel, out, "rewrite name / homepage / repository.url");
  }
}

// ─── 3. Report ───
if (changes.length === 0) {
  console.log("[rebrand] nothing to do — all targeted surfaces already match the supplied values.");
}
else {
  console.log(`[rebrand] ${DRY_RUN ? "would update" : "updated"} ${changes.length} file(s):`);
  for (const { file, note } of changes)
    console.log(`  ${file}  — ${note}`);
}

console.log("\n[rebrand] manual follow-up:");
console.log("  - git remote set-url origin <your-fork-url>");
console.log("  - Replace apps/web/public/logo.svg with your logo");
console.log("  - Update the inline SVG in apps/web/src/shared/components/logo.tsx");
console.log("  - bun run check # verify lint + typecheck + test + build still pass");

// A package-scope rename leaves bun.lock referencing the old `@app/*`
// names, which makes `bun install --frozen-lockfile` fail on forks and CI.
// We deliberately do NOT run `bun install` here — it is heavy and
// side-effecty for a rewrite tool — so shout about the required follow-up
// instead. Dry-run still warns since the scope WOULD have changed.
if (scopeRenamed || (DRY_RUN && SCOPE)) {
  console.log("");
  console.log("  ============================================================");
  console.log("  !! ACTION REQUIRED: bun.lock is now STALE (package scope changed)");
  console.log("  !! Run `bun install` and commit the updated bun.lock, or CI");
  console.log("  !! (`bun install --frozen-lockfile`) will FAIL on this fork.");
  console.log("  ============================================================");
}
