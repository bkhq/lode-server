#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Report locale keys that no code reference can reach.
 *
 * Detection core lives in scripts/lib/i18n-scan.ts and is shared verbatim
 * with clean-unused-i18n.ts, so this report and that deletion can never
 * disagree. Heuristic limits still apply (see the lib header); the
 * documented dynamic-key safety net is now actually enforced: a namespace
 * touched by a fully dynamic `t()` is treated as entirely used.
 *
 * Usage:  bun scripts/find-unused-i18n.ts [--ns <namespace>]
 */
import { resolve } from "node:path";
import process from "node:process";
import { findUnused } from "./lib/i18n-scan";

const ROOT = resolve(import.meta.dir, "..");
const LOCALES_DIR = resolve(ROOT, "apps/web/src/locales");
const CODE_ROOT = resolve(ROOT, "apps/web/src");
const REFERENCE_LANG = "en";

const args = process.argv.slice(2);
const idx = args.indexOf("--ns");
const nsFilter = idx >= 0 ? args[idx + 1] : undefined;

const { results } = findUnused(LOCALES_DIR, CODE_ROOT, REFERENCE_LANG, nsFilter);

let totalUnused = 0;
let totalKeys = 0;
for (const { ns, total, unused } of results) {
  totalKeys += total;
  if (unused.length === 0)
    continue;
  console.log(`\n[${ns}] ${unused.length} unused key(s) of ${total}:`);
  for (const k of unused)
    console.log(`  - ${ns}:${k}`);
  totalUnused += unused.length;
}

console.log(`\n──────────────────────────────────────────`);
console.log(`scanned ${totalKeys} key(s) across ${results.length} namespace(s)`);
console.log(`${totalUnused} potentially unused (heuristic — verify before deleting)`);
