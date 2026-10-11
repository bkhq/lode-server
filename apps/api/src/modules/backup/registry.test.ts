import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetBackupRegistryForTests,
  getDataModules,
  getModuleNames,
  getTablesForModules,
  registerBackupContribution,
  resolveModulesWithDeps,
} from "./registry";

// Minimal fake table objects — getTableName(table) reads `_.name` on the
// underlying drizzle table. Fake just enough surface for registry tests.
function fakeTable(name: string): SQLiteTable {
  return {
    _: { name, schema: undefined, baseName: name, columns: {}, dialect: "sqlite", excludedMethods: [] },
    [Symbol.for("drizzle:Schema")]: undefined,
    [Symbol.for("drizzle:Name")]: name,
  } as unknown as SQLiteTable;
}

beforeEach(() => __resetBackupRegistryForTests());
afterEach(() => __resetBackupRegistryForTests());

describe("registerBackupContribution + getDataModules", () => {
  test("registers and round-trips a contribution", () => {
    const t = fakeTable("users");
    registerBackupContribution({ name: "users", tables: [t], deps: [] });
    const got = getDataModules();
    expect(Object.keys(got)).toEqual(["users"]);
    expect(got.users!.tables).toEqual([t]);
  });

  test("re-registering the same name overwrites (idempotent / last-write-wins)", () => {
    registerBackupContribution({ name: "users", tables: [fakeTable("a")], deps: [] });
    registerBackupContribution({ name: "users", tables: [fakeTable("b")], deps: [] });
    expect(Object.keys(getDataModules())).toHaveLength(1);
  });
});

describe("getModuleNames", () => {
  test("returns sorted names regardless of registration order", () => {
    registerBackupContribution({ name: "issues", tables: [fakeTable("issues")], deps: ["users"] });
    registerBackupContribution({ name: "users", tables: [fakeTable("users")], deps: [] });
    registerBackupContribution({ name: "policies", tables: [fakeTable("rt")], deps: ["users"] });
    expect(getModuleNames()).toEqual(["issues", "policies", "users"]);
  });
});

describe("resolveModulesWithDeps", () => {
  test("expands transitive deps, keeps dependency-first order", () => {
    registerBackupContribution({ name: "users", tables: [fakeTable("users")], deps: [] });
    registerBackupContribution({ name: "documents", tables: [fakeTable("documents")], deps: ["users"] });

    const r = resolveModulesWithDeps(["documents"]);
    expect(r).toEqual(["users", "documents"]);
  });

  test("dedupes when a dep is named twice", () => {
    registerBackupContribution({ name: "users", tables: [fakeTable("users")], deps: [] });
    registerBackupContribution({ name: "documents", tables: [fakeTable("documents")], deps: ["users"] });
    registerBackupContribution({ name: "issues", tables: [fakeTable("issues")], deps: ["users"] });

    const r = resolveModulesWithDeps(["documents", "issues"]);
    expect(r).toEqual(["users", "documents", "issues"]);
  });

  test("ignores unknown module names rather than throwing", () => {
    registerBackupContribution({ name: "users", tables: [fakeTable("users")], deps: [] });
    expect(resolveModulesWithDeps(["mystery", "users"])).toEqual(["users"]);
  });

  test("walks transitive deps further than one level", () => {
    registerBackupContribution({ name: "a", tables: [fakeTable("a")], deps: [] });
    registerBackupContribution({ name: "b", tables: [fakeTable("b")], deps: ["a"] });
    registerBackupContribution({ name: "c", tables: [fakeTable("c")], deps: ["b"] });
    expect(resolveModulesWithDeps(["c"])).toEqual(["a", "b", "c"]);
  });
});

describe("getTablesForModules", () => {
  test("flattens module → tables, preserving order and dedupe by table name", () => {
    const t1 = fakeTable("users");
    const t2 = fakeTable("docs");
    const t3 = fakeTable("docs"); // duplicate name, different object
    registerBackupContribution({ name: "users", tables: [t1], deps: [] });
    registerBackupContribution({ name: "docsA", tables: [t2], deps: [] });
    registerBackupContribution({ name: "docsB", tables: [t3], deps: [] });

    const tables = getTablesForModules(["users", "docsA", "docsB"]);
    expect(tables).toEqual([t1, t2]);
  });

  test("ignores unknown module entries", () => {
    registerBackupContribution({ name: "users", tables: [fakeTable("users")], deps: [] });
    expect(getTablesForModules(["nothing"])).toEqual([]);
  });
});
