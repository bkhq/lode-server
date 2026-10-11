#!/usr/bin/env bun
// Generate docs/reference/env-reference.md from three sources:
//   - apps/api/src/config.ts (zod schema → types / defaults / required)
//   - apps/api/src           (env reads outside the schema, e.g. ROOT_DIR)
//   - .env.example           (comments → descriptions)
// Fails when a variable the code reads is missing from .env.example, or
// .env.example documents one nothing reads, so docs can't drift silently. --check makes CI report drift without rewriting the file.
/* eslint-disable no-console */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values: cli } = parseArgs({
  args: process.argv.slice(2),
  options: { check: { type: "boolean", default: false } },
  strict: true,
  allowPositionals: false,
});

const ROOT = resolve(import.meta.dir, "..");
// Schema lives in `apps/api/src/config/schema.ts` since the config-loader
// split (see `docs/develop/module/standards.md`). Keep this pointer in lockstep
// with the actual location of `configSchema = z.object({ ... })`.
const CONFIG_PATH = resolve(ROOT, "apps/api/src/config/schema.ts");
const SRC_DIR = resolve(ROOT, "apps/api/src");
// Vendored lode SDK: it reads the variables the lode supervisor sets for the
// process it runs, which are not the app's configuration.
const SCAN_EXCLUDE = new Set(["apps/api/src/lode/sdk.ts"]);
const ENV_EXAMPLE_PATH = resolve(ROOT, ".env.example");
const OUT_PATH = resolve(ROOT, "docs/reference/env-reference.md");

interface FieldShape {
  readonly key: string;
  readonly type: string;
  readonly defaultValue: string;
  readonly required: boolean;
}

interface FieldDoc extends FieldShape {
  readonly description: string;
}

// ─── Parse the zod schema source ───
//
// We deliberately read the raw source instead of importing config.ts,
// because importing triggers `loadConfig` side effects (reading Bun.env,
// process.exit, etc.). The schema's syntactic shape is what we want.
function parseConfigSchema(): FieldShape[] {
  const src = readFileSync(CONFIG_PATH, "utf-8");
  const start = src.indexOf("const configSchema = z.object({");
  const end = src.indexOf("\n});", start);
  if (start < 0 || end < 0)
    throw new Error("could not locate configSchema in config.ts");
  const body = src.slice(start, end);

  // Match lines like `KEY: z.<type>(...).<modifiers>(...)`.
  const fields: FieldShape[] = [];
  // Bounded repetition removes the `[^,]+ / [^)]* / [^,]*` overlap that is
  // super-linear-backtracking-prone; schema lines are far under these caps.
  const lineRe = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*(z\.[^,]{1,300}(?:\([^)]{0,300}\))?[^,]{0,300}),\s*$/gm;
  for (const m of body.matchAll(lineRe)) {
    const key = m[1]!;
    const chain = m[2]!;
    fields.push({
      key,
      type: extractType(chain),
      defaultValue: extractDefault(chain),
      required: !/\.optional\(/.test(chain) && !/\.default\(/.test(chain),
    });
  }
  return fields;
}

function extractType(chain: string): string {
  if (/z\.enum\(\[[^\]]+\]\)/.test(chain)) {
    const m = /z\.enum\(\[([^\]]+)\]\)/.exec(chain);
    return `enum(${m![1]!.replace(/["\s]/g, "")})`;
  }
  if (/z\.coerce\.number/.test(chain))
    return "number";
  if (/z\.coerce\.boolean/.test(chain))
    return "boolean";
  if (/z\.string\(\)\.url\(\)/.test(chain))
    return "url";
  if (/z\.string\(\)/.test(chain))
    return "string";
  return "unknown";
}

// Numeric expressions made of integer literals + `*` / `_` separators
// are common in the schema (e.g. `10 * 1024 * 1024`). Evaluate them so
// the rendered table shows the resolved byte / second count rather than
// the unmangled source. Strings, booleans, and other shapes pass
// through unchanged. Anything richer than this conservative subset
// (function calls, identifiers, mixed operators) is left as the raw
// source — `eval` would be a security regression for a docs tool.
const RE_SAFE_NUMERIC_EXPR = /^[\d_\s*]+$/;

function evaluateNumericExpr(raw: string): string {
  if (!RE_SAFE_NUMERIC_EXPR.test(raw))
    return raw;
  const factors = raw
    .replace(/_/g, "")
    .split("*")
    .map(s => Number.parseInt(s.trim(), 10));
  if (factors.some(n => !Number.isFinite(n)))
    return raw;
  const product = factors.reduce((acc, n) => acc * n, 1);
  if (!Number.isFinite(product))
    return raw;
  return String(product);
}

function extractDefault(chain: string): string {
  // `.default(value)` — value can be a string literal, number, or a
  // safe numeric expression like `10 * 1024 * 1024`.
  const m = /\.default\(([^)]+)\)/.exec(chain);
  if (!m)
    return "";
  const raw = m[1]!.trim().replace(/^['"]|['"]$/g, "");
  return evaluateNumericExpr(raw);
}

// ─── Scan the API source for env reads outside the schema ───
//
// The schema covers what `loadConfig` parses, but a few variables have to be
// read before config exists (ROOT_DIR anchors the paths config resolves), and
// a module can read one through the platform seam. Match the read shapes the
// code uses: `process.env.X`, `Bun.env.X`, `env.get("X")` and `env["X"]`.
const RE_ENV_READ = /(?:process|Bun)\.env\.([A-Z][A-Z0-9_]*)|\benv\.get\(\s*["']([A-Z][A-Z0-9_]*)["']\s*\)|(?:process|Bun)\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map(f => resolve(dir, f));
}

/** Variable name → the source files reading it, relative to the repo root. */
function scanEnvReads(): Map<string, string[]> {
  const reads = new Map<string, string[]>();
  for (const file of sourceFiles(SRC_DIR)) {
    const rel = relative(ROOT, file);
    if (SCAN_EXCLUDE.has(rel))
      continue;
    for (const m of readFileSync(file, "utf-8").matchAll(RE_ENV_READ)) {
      const key = (m[1] ?? m[2] ?? m[3])!;
      const files = reads.get(key) ?? [];
      if (!files.includes(rel))
        files.push(rel);
      reads.set(key, files);
    }
  }
  return reads;
}

// ─── Parse .env.example: collect a `key -> description` map ───
//
// Description is the contiguous block of `# ...` comment lines immediately
// above each `KEY=` or `# KEY=` line, with section dividers stripped.
function parseEnvExample(): Map<string, string> {
  const src = readFileSync(ENV_EXAMPLE_PATH, "utf-8");
  const lines = src.split("\n");
  const out = new Map<string, string>();
  let buf: string[] = [];
  const keyRe = /^#?\s*([A-Z][A-Z0-9_]*)=/;
  const SECTION_DIVIDER = /^#\s*─+\s/;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "") {
      buf = [];
      continue;
    }
    // Try the KEY= pattern first so `# KEY=value` ("commented-out default")
    // is recognised as a key, not as another description line.
    const m = keyRe.exec(line);
    if (m) {
      const key = m[1]!;
      if (!out.has(key)) {
        const desc = buf
          .filter(l => l.length > 0)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        out.set(key, desc);
      }
      buf = [];
      continue;
    }
    if (line.startsWith("#") && !SECTION_DIVIDER.test(line)) {
      buf.push(line.replace(/^#\s?/, "").trim());
    }
  }
  return out;
}

// ─── Merge + render ───
interface ExtraDoc {
  readonly key: string;
  readonly files: readonly string[];
  readonly description: string;
}

function render(fields: FieldDoc[], extras: ExtraDoc[]): string {
  const header = "# Environment reference\n\n"
    + "> Auto-generated by `scripts/gen-env-docs.ts`. Do not edit by hand —\n"
    + "> change the zod schema in `apps/api/src/config/schema.ts` or the comment in\n"
    + "> `.env.example` and re-run `bun run gen:env-docs`. CI verifies the\n"
    + "> generated file is up to date.\n\n"
    + "| Variable | Type | Default | Required | Description |\n"
    + "|---|---|---|---|---|\n";
  const rows = fields
    .toSorted((a, b) => a.key.localeCompare(b.key))
    .map((f) => {
      const def = f.defaultValue ? `\`${f.defaultValue}\`` : "—";
      const req = f.required ? "yes" : "no";
      const desc = f.description.replace(/\|/g, "\\|");
      return `| \`${f.key}\` | ${f.type} | ${def} | ${req} | ${desc} |`;
    })
    .join("\n");
  if (extras.length === 0)
    return `${header}${rows}\n`;
  const extraHeader = "\n## Read outside the config schema\n\n"
    + "These are read directly from the environment, not through `loadConfig`,\n"
    + "so they have no schema type or default.\n\n"
    + "| Variable | Read by | Description |\n"
    + "|---|---|---|\n";
  const extraRows = extras
    .toSorted((a, b) => a.key.localeCompare(b.key))
    .map(e => `| \`${e.key}\` | ${e.files.map(f => `\`${f}\``).join(", ")} | ${e.description.replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `${header}${rows}\n${extraHeader}${extraRows}\n`;
}

const schemaFields = parseConfigSchema();
const descriptions = parseEnvExample();

const envReads = scanEnvReads();

const schemaKeys = new Set(schemaFields.map(f => f.key));
const extraKeys = [...envReads.keys()].filter(k => !schemaKeys.has(k));
const envKeys = new Set(descriptions.keys());

const missingFromEnv = [...schemaKeys].filter(k => !envKeys.has(k));
const readButUndocumented = extraKeys.filter(k => !envKeys.has(k));
const missingFromSchema = [...envKeys].filter(k => !schemaKeys.has(k) && !envReads.has(k));

if (missingFromEnv.length || readButUndocumented.length || missingFromSchema.length) {
  console.error("[gen-env-docs] env/schema drift detected:");
  if (missingFromEnv.length)
    console.error(`  in schema but missing from .env.example: ${missingFromEnv.join(", ")}`);
  for (const key of readButUndocumented)
    console.error(`  read by ${envReads.get(key)!.join(", ")} but missing from .env.example: ${key}`);
  if (missingFromSchema.length)
    console.error(`  in .env.example but read nowhere in apps/api/src: ${missingFromSchema.join(", ")}`);
  process.exit(1);
}

const docs: FieldDoc[] = schemaFields.map(f => ({
  ...f,
  description: descriptions.get(f.key) ?? "",
}));

const extras: ExtraDoc[] = extraKeys.map(key => ({
  key,
  files: envReads.get(key)!,
  description: descriptions.get(key) ?? "",
}));

const rendered = render(docs, extras);

if (cli.check) {
  const existing = (() => {
    try {
      return readFileSync(OUT_PATH, "utf-8");
    }
    catch {
      return "";
    }
  })();
  if (existing.trim() !== rendered.trim()) {
    console.error(`[gen-env-docs] ${OUT_PATH} is stale. Run \`bun run gen:env-docs\` and commit.`);
    process.exit(1);
  }
  console.log("[gen-env-docs] up to date");
}
else {
  writeFileSync(OUT_PATH, rendered);
  console.log(`[gen-env-docs] wrote ${OUT_PATH} (${docs.length} entries)`);
}
