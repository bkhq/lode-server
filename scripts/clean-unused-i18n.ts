#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Delete the unused-key set from every locale shard.
 *
 * The set is derived LIVE from scripts/lib/i18n-scan.ts (the same logic
 * find-unused-i18n.ts reports), not a hardcoded snapshot — so this can
 * never delete a key that became referenced since the list was authored.
 * Reference locale (en) decides the unused set; the same flattened paths
 * are removed from every locale so check-i18n parity stays intact. Empty
 * parent objects are pruned.
 *
 * Usage:  bun scripts/clean-unused-i18n.ts [--dry-run] [--ns <namespace>]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { findUnused } from "./lib/i18n-scan";

const ROOT = resolve(import.meta.dir, "..");
const LOCALES_DIR = resolve(ROOT, "apps/web/src/locales");
const CODE_ROOT = resolve(ROOT, "apps/web/src");
const REFERENCE_LANG = "en";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const idx = args.indexOf("--ns");
const nsFilter = idx >= 0 ? args[idx + 1] : undefined;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

interface Leaf {
  readonly parent: Record<string, unknown>;
  readonly key: string;
  readonly path: string;
}

function* walkLeaves(
  obj: Record<string, unknown>,
  prefix: readonly string[] = [],
): Generator<Leaf> {
  for (const [k, v] of Object.entries(obj)) {
    const segs = [...prefix, k];
    if (typeof v === "string")
      yield { parent: obj, key: k, path: segs.join(".") };
    else if (isObject(v))
      yield* walkLeaves(v, segs);
  }
}

function deleteFlattenedPaths(obj: Record<string, unknown>, targets: ReadonlySet<string>): number {
  let removed = 0;
  for (const leaf of [...walkLeaves(obj)]) {
    if (targets.has(leaf.path)) {
      delete leaf.parent[leaf.key];
      removed++;
    }
  }
  function prune(node: Record<string, unknown>): void {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (isObject(v)) {
        prune(v);
        if (Object.keys(v).length === 0)
          delete node[k];
      }
    }
  }
  let prev = -1;
  while (prev !== JSON.stringify(obj).length) {
    prev = JSON.stringify(obj).length;
    prune(obj);
  }
  return removed;
}

const { results } = findUnused(LOCALES_DIR, CODE_ROOT, REFERENCE_LANG, nsFilter);
const unusedByNs = new Map(
  results.filter(r => r.unused.length > 0).map(r => [r.ns, new Set(r.unused)]),
);

if (unusedByNs.size === 0) {
  console.log("[clean-i18n] no unused keys — nothing to do");
  process.exit(0);
}

const locales = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

let touched = 0;
let removed = 0;

for (const lang of locales) {
  for (const [ns, targets] of unusedByNs) {
    const file = resolve(LOCALES_DIR, lang, `${ns}.json`);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(readFileSync(file, "utf-8"));
    }
    catch {
      console.error(`[clean-i18n] cannot read ${lang}/${ns}.json — skipped`);
      continue;
    }
    const before = JSON.stringify(json);
    const n = deleteFlattenedPaths(json, targets);
    if (JSON.stringify(json) !== before) {
      touched++;
      removed += n;
      if (!dryRun)
        writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    }
  }
}

const totalPaths = [...unusedByNs.values()].reduce((n, s) => n + s.size, 0);
const verb = dryRun ? "would remove" : "removed";
for (const [ns, s] of unusedByNs)
  console.log(`[clean-i18n] ${ns}: ${[...s].sort().join(", ")}`);
console.log(`[clean-i18n] ${verb} ${removed} entr${removed === 1 ? "y" : "ies"} across ${touched} file(s)`);
console.log(`[clean-i18n] ${totalPaths} unique path(s) × ${locales.length} locale(s)`);
