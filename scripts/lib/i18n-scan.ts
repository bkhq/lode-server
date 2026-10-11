/**
 * Shared i18n static-analysis core used by:
 *   - check-i18n.ts        (CI gate: en↔zh parity + code→locale missing)
 *   - find-unused-i18n.ts  (report locale keys unreferenced by code)
 *   - clean-unused-i18n.ts (delete the unused set, derived live from here)
 *
 * Single source of truth so the "find" report and the "clean" deletion can
 * never drift. Resolution mirrors the runtime i18next config in
 * apps/web/src/app/i18n.ts: nsSeparator ":", keySeparator ".",
 * defaultNS / fallbackNS = "common".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

export const FALLBACK_NS = "common";

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Flatten a locale JSON tree to dot-joined leaf paths. */
export function flatten(value: unknown, prefix = ""): string[] {
  if (typeof value === "string")
    return [prefix];
  if (!isObject(value))
    return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${k}` : k;
    out.push(...flatten(v, next));
  }
  return out;
}

export interface NamespaceKeys {
  readonly ns: string;
  readonly keys: ReadonlySet<string>;
}

export function loadNamespaces(localesDir: string, lang: string): NamespaceKeys[] {
  const dir = resolve(localesDir, lang);
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map((f) => {
      const ns = f.replace(/\.json$/, "");
      const raw = JSON.parse(readFileSync(resolve(dir, f), "utf-8"));
      return { ns, keys: new Set(flatten(raw)) };
    });
}

// ── Code walk ────────────────────────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "locales", ".turbo"]);
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx"]);

export function* walkCode(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry))
      continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory())
      yield* walkCode(full);
    else if (st.isFile() && CODE_EXTS.has(extname(entry)))
      yield full;
  }
}

// First arg of a `t("...")` / `t(`...`)` call.
const RE_T_CALL = /\bt\(\s*(["'`])((?:\\.|(?!\1).)*?)\1/g;
// A `t(...)` whose first arg is a bare identifier/member expression — a
// fully dynamic key (e.g. `t(field.label)`, `t(titleKey)`).
const RE_T_DYNAMIC = /\bt\(\s*[A-Za-z_$][\w$.]*\s*[),]/g;
// A key whose `t()` call supplies a default — either the object form
// `t("k", { defaultValue: ... })` or the i18next string shorthand
// `t("k", "Fallback")` / `t("k", `Fallback`)`. A missing such key still
// renders the default, so it is not a broken-UI bug and is excluded from
// the missing-key check.
// Bounded repetition (keys are short; `looksLikeKey` caps at 120) keeps this
// linear — an unbounded lazy run next to the trailing `\s*,\s*` group is
// super-linear-backtracking-prone on adversarial source.
const RE_T_WITH_DEFAULT = /\bt\(\s*(["'`])((?:\\.|(?!\1).){0,200})\1\s*,\s*(?:\{[^}]{0,500}\bdefaultValue\b|["'`])/g;
const RE_TITLE_KEY = /titleKey\s*:\s*["']([^"']+)["']/g;
const RE_USE_TRANS = /\buseTranslation\(\s*(?:(?:\[([^\]]*)\]|(["'])([^"']+)\2)\s*)?\)/g;
const RE_NS_OPTION = /\{\s*ns:\s*["']([^"']+)["']\s*\}/g;
const RE_NS_PREFIXED_LITERAL = /["'`](\w+:[\w.-]+)["'`]/g;

export function looksLikeKey(s: string): boolean {
  if (s.length === 0 || s.length > 120)
    return false;
  if (!/^[\w:.-]+$/.test(s))
    return false;
  return /[a-z]/i.test(s);
}

/** Static prefix of a template literal up to the first `${`. */
function templatePrefix(arg: string): string | undefined {
  const idx = arg.indexOf("${");
  if (idx < 0)
    return undefined;
  const stem = arg.slice(0, idx);
  return stem.length === 0 ? undefined : stem;
}

export interface StaticRef {
  readonly file: string;
  readonly raw: string;
  /** Explicit namespace if the literal was `ns:rest`, else undefined. */
  readonly ns: string | undefined;
  /** Key path after stripping any `ns:` prefix. */
  readonly key: string;
  /** ns scope visible in the file (useTranslation + {ns:}). */
  readonly fileNs: readonly string[];
  /** Same call carried a defaultValue → missing is non-fatal. */
  readonly hasDefault: boolean;
  /**
   * "t"        — first arg of a `t()` call (strong i18n signal)
   * "titleKey" — `titleKey: "..."` static-data prop (strong)
   * "nsLiteral" — bare `"ns:word"` literal anywhere (weak: may be a
   *               cache/query key, not i18n — used for unused coverage
   *               only, never to assert a key is missing)
   */
  readonly source: "t" | "titleKey" | "nsLiteral";
}

export interface CodeReferences {
  readonly literals: ReadonlySet<string>;
  readonly defaultNamespaces: ReadonlyMap<string, string[]>;
  readonly stems: ReadonlySet<string>;
  readonly titleKeys: ReadonlySet<string>;
  /** Namespaces fully covered by a dynamic `t()` (documented safety net). */
  readonly dynamicNamespaces: ReadonlySet<string>;
  /** Every static literal reference, for code→locale missing detection. */
  readonly staticRefs: readonly StaticRef[];
}

export function collectReferences(codeRoot: string): CodeReferences {
  const literals = new Set<string>();
  const stems = new Set<string>();
  const titleKeys = new Set<string>();
  const defaultNamespaces = new Map<string, string[]>();
  const dynamicNamespaces = new Set<string>();
  const staticRefs: StaticRef[] = [];

  for (const file of walkCode(codeRoot)) {
    const src = readFileSync(file, "utf-8");

    const nsForFile: string[] = [];
    for (const m of src.matchAll(RE_USE_TRANS)) {
      if (m[1]) {
        for (const part of m[1].split(",")) {
          const cleaned = part.trim().replace(/^['"]|['"]$/g, "");
          if (cleaned)
            nsForFile.push(cleaned);
        }
      }
      else if (m[3]) {
        nsForFile.push(m[3]);
      }
    }
    for (const m of src.matchAll(RE_NS_OPTION))
      nsForFile.push(m[1]!);
    if (nsForFile.length > 0)
      defaultNamespaces.set(file, nsForFile);

    const defaultedKeys = new Set<string>();
    for (const m of src.matchAll(RE_T_WITH_DEFAULT))
      defaultedKeys.add(m[2]!);

    let fileIsDynamic = false;

    for (const m of src.matchAll(RE_T_CALL)) {
      const quote = m[1]!;
      const arg = m[2]!;
      if (quote === "`") {
        const stem = templatePrefix(arg);
        if (stem) {
          stems.add(stem);
          for (const ns of nsForFile)
            stems.add(`${ns}:${stem}`);
        }
        else {
          // Backtick with a leading `${` — fully dynamic.
          fileIsDynamic = true;
        }
      }
      else if (looksLikeKey(arg)) {
        literals.add(arg);
        const colon = arg.indexOf(":");
        staticRefs.push({
          file,
          raw: arg,
          ns: colon > 0 ? arg.slice(0, colon) : undefined,
          key: colon > 0 ? arg.slice(colon + 1) : arg,
          fileNs: nsForFile,
          hasDefault: defaultedKeys.has(arg),
          source: "t",
        });
      }
    }

    if (RE_T_DYNAMIC.test(src))
      fileIsDynamic = true;
    RE_T_DYNAMIC.lastIndex = 0;
    if (fileIsDynamic) {
      for (const ns of nsForFile)
        dynamicNamespaces.add(ns);
    }

    for (const m of src.matchAll(RE_TITLE_KEY)) {
      const k = m[1]!;
      if (looksLikeKey(k)) {
        titleKeys.add(k);
        const colon = k.indexOf(":");
        staticRefs.push({
          file,
          raw: k,
          ns: colon > 0 ? k.slice(0, colon) : undefined,
          key: colon > 0 ? k.slice(colon + 1) : k,
          fileNs: nsForFile,
          hasDefault: false,
          source: "titleKey",
        });
      }
    }

    for (const m of src.matchAll(RE_NS_PREFIXED_LITERAL)) {
      const k = m[1]!;
      if (!looksLikeKey(k))
        continue;
      literals.add(k);
      const colon = k.indexOf(":");
      staticRefs.push({
        file,
        raw: k,
        ns: k.slice(0, colon),
        key: k.slice(colon + 1),
        fileNs: nsForFile,
        hasDefault: false,
        source: "nsLiteral",
      });
    }
  }

  return { literals, stems, titleKeys, defaultNamespaces, dynamicNamespaces, staticRefs };
}

// ── Unused detection ─────────────────────────────────────────────

export function keyIsReferenced(ns: string, key: string, refs: CodeReferences): boolean {
  // Documented safety net: a namespace touched by a fully dynamic `t()`
  // is treated as entirely covered (we cannot statically prove otherwise).
  if (refs.dynamicNamespaces.has(ns))
    return true;

  const fq = `${ns}:${key}`;
  if (refs.literals.has(fq) || refs.titleKeys.has(fq))
    return true;
  if (refs.literals.has(key) || refs.titleKeys.has(key)) {
    for (const nsList of refs.defaultNamespaces.values()) {
      if (nsList.includes(ns))
        return true;
    }
  }
  for (const stem of refs.stems) {
    if (fq.startsWith(stem))
      return true;
    if (key.startsWith(stem)) {
      for (const nsList of refs.defaultNamespaces.values()) {
        if (nsList.includes(ns))
          return true;
      }
    }
  }
  return false;
}

export interface UnusedResult {
  readonly ns: string;
  readonly total: number;
  readonly unused: readonly string[];
}

export function findUnused(
  localesDir: string,
  codeRoot: string,
  referenceLang: string,
  nsFilter?: string,
): { results: UnusedResult[]; refs: CodeReferences } {
  const refs = collectReferences(codeRoot);
  const results: UnusedResult[] = [];
  for (const { ns, keys } of loadNamespaces(localesDir, referenceLang)) {
    if (nsFilter && ns !== nsFilter)
      continue;
    const unused = [...keys].filter(k => !keyIsReferenced(ns, k, refs)).sort();
    results.push({ ns, total: keys.size, unused });
  }
  return { results, refs };
}

// ── Missing detection (code → locale) ────────────────────────────

export interface MissingRef {
  readonly file: string;
  readonly raw: string;
  readonly tried: readonly string[];
}

/**
 * Static `t()` / config-literal references whose key resolves to no locale
 * entry in any candidate namespace. Conservative: only reported when the
 * namespace is determinable, so a green result is trustworthy and a red
 * one is a real broken label rather than analyzer noise.
 */
export function findMissing(
  localesDir: string,
  codeRoot: string,
  referenceLang: string,
  refs?: CodeReferences,
): MissingRef[] {
  const r = refs ?? collectReferences(codeRoot);
  const nsList = loadNamespaces(localesDir, referenceLang);
  const nsNames = new Set(nsList.map(n => n.ns));
  const keysByNs = new Map(nsList.map(n => [n.ns, n.keys]));

  const has = (ns: string, key: string): boolean =>
    keysByNs.get(ns)?.has(key) ?? false;

  const missing: MissingRef[] = [];
  for (const ref of r.staticRefs) {
    // Bare `ns:word` literals are too weak to assert "missing" — they may
    // be cache/query keys, not i18n. They still count for unused coverage.
    if (ref.source === "nsLiteral")
      continue;
    if (ref.hasDefault)
      continue;

    if (ref.ns !== undefined) {
      // Explicit `ns:key`. Only adjudicate when `ns` is a real namespace —
      // otherwise it is a non-i18n literal (e.g. "node:fs") and we skip.
      if (!nsNames.has(ref.ns))
        continue;
      if (has(ref.ns, ref.key) || has(FALLBACK_NS, ref.key))
        continue;
      missing.push({ file: ref.file, raw: ref.raw, tried: [ref.ns, FALLBACK_NS] });
      continue;
    }

    // Bare key — resolvable only if the file declares its ns scope.
    const candidates = [...new Set([...ref.fileNs, FALLBACK_NS])].filter(n => nsNames.has(n));
    if (ref.fileNs.length === 0)
      continue; // ns unknowable from regex — skip to avoid false positives.
    if (candidates.some(ns => has(ns, ref.key)))
      continue;
    missing.push({ file: ref.file, raw: ref.raw, tried: candidates });
  }
  return missing;
}
