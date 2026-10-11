#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Verify EN/ZH translation files are in sync. For every locale namespace
 * the script compares two surfaces:
 *
 *   1. Key set — every dot-path that exists in one locale must exist in
 *      the other. Missing keys break translations at runtime.
 *
 *   2. Interpolation tokens — `{{name}}` style placeholders must appear
 *      in every locale's copy of the same key, or the translator dropped
 *      a variable and the runtime will render `{{name}}` literally.
 *
 *   3. Empty strings — `""` is a valid JSON value but a useless
 *      translation; flag so the gap is caught at PR time rather than
 *      shipping a blank label.
 *
 * Plural variants (`foo_one` / `foo_other` / `foo_zero`) are NOT yet
 * checked for symmetric coverage — add when the project starts using
 * i18next pluralization.
 *
 *   4. Code → locale — every static `t("ns:key")` / `t("key")` and
 *      ns-prefixed config literal in the web code must resolve to an
 *      existing locale entry. Locale-only parity (1–3) never catches a
 *      key the code asks for but no JSON provides; this does. Dynamic
 *      keys and `defaultValue`-guarded calls are skipped (see lib).
 *
 * Usage:  bun scripts/check-i18n.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { findMissing, findUnused } from "./lib/i18n-scan";

const ROOT = resolve(import.meta.dir, "..");
const LOCALES_DIR = resolve(ROOT, "apps/web/src/locales");
const RE_INTERPOLATION = /\{\{\s*([\w.-]+)\s*\}\}/g;

interface LeafEntry {
  readonly path: string;
  readonly value: string;
  readonly tokens: ReadonlySet<string>;
  readonly empty: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of value.matchAll(RE_INTERPOLATION)) {
    tokens.add(m[1]!);
  }
  return tokens;
}

function flattenLeaves(value: unknown, prefix = ""): LeafEntry[] {
  if (typeof value === "string") {
    return [{
      path: prefix,
      value,
      tokens: extractTokens(value),
      empty: value.length === 0,
    }];
  }
  if (!isObject(value))
    return [];
  const out: LeafEntry[] = [];
  for (const [k, v] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${k}` : k;
    out.push(...flattenLeaves(v, next));
  }
  return out;
}

function loadLeaves(lang: string, ns: string): Map<string, LeafEntry> {
  const path = resolve(LOCALES_DIR, lang, `${ns}.json`);
  const raw = readFileSync(path, "utf-8");
  const map = new Map<string, LeafEntry>();
  for (const leaf of flattenLeaves(JSON.parse(raw))) {
    map.set(leaf.path, leaf);
  }
  return map;
}

function setsDiffer(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size)
    return true;
  for (const v of a) {
    if (!b.has(v))
      return true;
  }
  return false;
}

const langs = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

if (langs.length < 2) {
  console.log("[check-i18n] only one locale present, nothing to compare");
  process.exit(0);
}

const [reference, ...rest] = langs;
const namespaces = readdirSync(resolve(LOCALES_DIR, reference!))
  .filter(f => f.endsWith(".json"))
  .map(f => f.replace(/\.json$/, ""));

let failed = 0;

for (const ns of namespaces) {
  const refLeaves = loadLeaves(reference!, ns);
  for (const lang of rest) {
    let otherLeaves: Map<string, LeafEntry>;
    try {
      otherLeaves = loadLeaves(lang, ns);
    }
    catch {
      console.error(`[check-i18n] ${lang}/${ns}.json missing (vs ${reference})`);
      failed++;
      continue;
    }

    const missingInOther: string[] = [];
    const missingInRef: string[] = [];
    const placeholderDrift: { path: string; ref: ReadonlySet<string>; other: ReadonlySet<string> }[] = [];
    const emptyInRef: string[] = [];
    const emptyInOther: string[] = [];

    for (const [path, leaf] of refLeaves) {
      const other = otherLeaves.get(path);
      if (!other) {
        missingInOther.push(path);
        continue;
      }
      if (setsDiffer(leaf.tokens, other.tokens))
        placeholderDrift.push({ path, ref: leaf.tokens, other: other.tokens });
      if (leaf.empty)
        emptyInRef.push(path);
      if (other.empty)
        emptyInOther.push(path);
    }
    for (const path of otherLeaves.keys()) {
      if (!refLeaves.has(path))
        missingInRef.push(path);
    }

    const nsHasFailures
      = missingInOther.length > 0
        || missingInRef.length > 0
        || placeholderDrift.length > 0
        || emptyInRef.length > 0
        || emptyInOther.length > 0;

    if (!nsHasFailures)
      continue;

    console.error(`[check-i18n] ${ns}: ${reference} ↔ ${lang} mismatch`);
    if (missingInOther.length) {
      console.error(`  missing in ${lang}/${ns}.json:`);
      for (const k of missingInOther)
        console.error(`    - ${k}`);
    }
    if (missingInRef.length) {
      console.error(`  missing in ${reference}/${ns}.json:`);
      for (const k of missingInRef)
        console.error(`    - ${k}`);
    }
    if (placeholderDrift.length) {
      console.error(`  interpolation tokens diverge:`);
      for (const { path, ref, other } of placeholderDrift) {
        console.error(`    - ${path}: ${reference}={${[...ref].join(",")}} ${lang}={${[...other].join(",")}}`);
      }
    }
    if (emptyInRef.length) {
      console.error(`  empty strings in ${reference}/${ns}.json:`);
      for (const k of emptyInRef)
        console.error(`    - ${k}`);
    }
    if (emptyInOther.length) {
      console.error(`  empty strings in ${lang}/${ns}.json:`);
      for (const k of emptyInOther)
        console.error(`    - ${k}`);
    }
    failed++;
  }
}

// ── 4. Code → locale ──
// Parity (1–3) only compares locales to each other; it is blind to a key
// the code calls but no JSON defines. This closes that gap.
const CODE_ROOT = resolve(ROOT, "apps/web/src");
const missing = findMissing(LOCALES_DIR, CODE_ROOT, reference!);
if (missing.length > 0) {
  console.error(`[check-i18n] ${missing.length} code reference(s) resolve to no locale entry:`);
  for (const m of missing) {
    const rel = m.file.replace(`${ROOT}/`, "");
    console.error(`  - "${m.raw}"  (${rel})  — tried ns: ${m.tried.join(", ")}`);
  }
  failed++;
}

if (failed > 0) {
  console.error(`[check-i18n] ${failed} check(s) failed`);
  process.exit(1);
}

// Heuristic, non-blocking: surface drift in CI logs without letting a
// false positive break the build (deletion stays a deliberate manual op
// via `bun scripts/clean-unused-i18n.ts`).
const { results: unusedResults } = findUnused(LOCALES_DIR, CODE_ROOT, reference!);
const totalUnused = unusedResults.reduce((n, r) => n + r.unused.length, 0);
if (totalUnused > 0)
  console.warn(`[check-i18n] note: ${totalUnused} potentially unused key(s) (heuristic, non-blocking)`);

console.log(
  `[check-i18n] all ${namespaces.length} namespace(s) in sync across ${langs.length} locales; `
  + `code references resolve`,
);
