// Unit tests for the pure analysis core in i18n-scan.ts. Locale + code
// fixtures are written to a throwaway temp dir per test so the filesystem
// walk runs against a tiny, deterministic tree.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  collectReferences,
  findMissing,
  findUnused,
  flatten,
} from "./i18n-scan";

let root: string;
let localesDir: string;
let codeRoot: string;

function writeFixture(rel: string, content: string): void {
  const full = resolve(root, rel);
  mkdirSync(resolve(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
}

beforeEach(() => {
  root = resolve(tmpdir(), `i18n-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  localesDir = resolve(root, "locales");
  codeRoot = resolve(root, "src");
  mkdirSync(codeRoot, { recursive: true });
});

afterEach(() => {
  if (existsSync(root))
    rmSync(root, { recursive: true, force: true });
});

describe("flatten", () => {
  test("flattens a nested tree to dot-joined leaf paths", () => {
    const tree = {
      title: "Hello",
      nav: { home: "Home", deep: { x: "X" } },
      // arrays / non-string leaves are not key leaves
      arr: ["a", "b"],
    };
    expect(flatten(tree).sort()).toEqual(["nav.deep.x", "nav.home", "title"].sort());
  });

  test("a bare string at the root yields the prefix only", () => {
    expect(flatten("just a string", "root")).toEqual(["root"]);
    expect(flatten("no prefix")).toEqual([""]);
  });

  test("non-object / non-string values yield nothing", () => {
    expect(flatten(42)).toEqual([]);
    expect(flatten(null)).toEqual([]);
    expect(flatten(["a"])).toEqual([]);
  });
});

describe("collectReferences", () => {
  test("captures t() literals, defaults, stems and dynamic namespaces", () => {
    writeFixture(
      "src/comp.tsx",
      [
        `import "node:fs";`,
        `const a = useTranslation("common");`,
        `t("plain.key");`,
        `t("defaulted.key", "Fallback text");`,
        `t("obj.defaulted", { defaultValue: "Obj fallback" });`,
        // eslint-disable-next-line no-template-curly-in-string
        "t(`stem.${x}`);",
        `t("admin:explicit.key");`,
      ].join("\n"),
    );
    writeFixture(
      "src/dyn.tsx",
      [
        `const a = useTranslation("dynns");`,
        `t(someDynamicVar);`,
      ].join("\n"),
    );

    const refs = collectReferences(codeRoot);

    expect(refs.literals.has("plain.key")).toBe(true);
    expect(refs.literals.has("defaulted.key")).toBe(true);
    expect(refs.literals.has("admin:explicit.key")).toBe(true);
    // "node:fs" looks like ns:key but `fs` has no lowercase-after-strip
    // issue; it is captured as a weak nsLiteral but never asserted missing.
    expect(refs.stems.has("stem.")).toBe(true);

    // string-shorthand + object default both flagged as defaulted
    const defaulted = refs.staticRefs.filter(r => r.hasDefault).map(r => r.raw).sort();
    expect(defaulted).toEqual(["defaulted.key", "obj.defaulted"]);

    // t(dynamicVar) makes the whole declared ns dynamically covered
    expect(refs.dynamicNamespaces.has("dynns")).toBe(true);

    // explicit ns:key is parsed into ns + key
    const explicit = refs.staticRefs.find(r => r.raw === "admin:explicit.key");
    expect(explicit?.ns).toBe("admin");
    expect(explicit?.key).toBe("explicit.key");
  });
});

describe("findMissing (code → locale)", () => {
  test("string-shorthand & object defaults are NOT missing; explicit ns:key miss IS", () => {
    writeFixture("locales/en/common.json", JSON.stringify({ present: { ok: "OK" } }));
    writeFixture("locales/en/admin.json", JSON.stringify({ known: "Known" }));
    writeFixture(
      "src/page.tsx",
      [
        `const a = useTranslation("common");`,
        `import "node:fs";`,
        `t("present.ok");`,
        `t("missing.key", "Has default so not fatal");`,
        `t("obj.missing", { defaultValue: "also fine" });`,
        `t("admin:does.not.exist");`,
        `t("admin:known");`,
      ].join("\n"),
    );

    const missing = findMissing(localesDir, codeRoot, "en");
    const raws = missing.map(m => m.raw);

    // present key — not flagged
    expect(raws).not.toContain("present.ok");
    // defaulted (string shorthand) — not flagged
    expect(raws).not.toContain("missing.key");
    // defaulted (object) — not flagged
    expect(raws).not.toContain("obj.missing");
    // "node:fs" — `node` is not a real namespace, skipped (not flagged)
    expect(raws).not.toContain("node:fs");
    // present explicit ns:key — not flagged
    expect(raws).not.toContain("admin:known");
    // explicit ns:key that does not exist — flagged
    expect(raws).toContain("admin:does.not.exist");
  });

  test("a bare key with no resolvable file ns is skipped (no false positive)", () => {
    writeFixture("locales/en/common.json", JSON.stringify({ a: "A" }));
    writeFixture("src/no-ns.tsx", `t("totally.unknown.key");`);

    const missing = findMissing(localesDir, codeRoot, "en");
    expect(missing.map(m => m.raw)).not.toContain("totally.unknown.key");
  });
});

describe("findUnused (locale → code)", () => {
  test("flags unreferenced keys and spares referenced + dynamic-ns keys", () => {
    writeFixture(
      "locales/en/common.json",
      JSON.stringify({ used: { a: "A" }, dead: { b: "B" } }),
    );
    writeFixture(
      "locales/en/dynns.json",
      JSON.stringify({ anything: "Anything", more: "More" }),
    );
    writeFixture(
      "src/app.tsx",
      [
        `useTranslation("common");`,
        `t("used.a");`,
      ].join("\n"),
    );
    writeFixture(
      "src/dyn.tsx",
      [
        `useTranslation("dynns");`,
        `t(runtimeKey);`,
      ].join("\n"),
    );

    const { results } = findUnused(localesDir, codeRoot, "en");
    const common = results.find(r => r.ns === "common")!;
    const dynns = results.find(r => r.ns === "dynns")!;

    expect(common.unused).toContain("dead.b");
    expect(common.unused).not.toContain("used.a");
    // dynamic-ns safety net: every dynns key treated as referenced
    expect(dynns.unused).toEqual([]);
  });
});
