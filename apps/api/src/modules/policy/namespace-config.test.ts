import type { NamespaceConfig } from "./namespace-config";
import { afterEach, describe, expect, test } from "bun:test";
import {
  __unregisterNamespaceForTests,
  getNamespace,
  getValidRelations,
  loadNamespaces,
  registerNamespace,
} from "./namespace-config";

const added: string[] = [];
function register(config: NamespaceConfig): void {
  registerNamespace(config);
  added.push(config.name);
}

afterEach(() => {
  for (const name of added.splice(0))
    __unregisterNamespaceForTests(name);
  loadNamespaces();
});

describe("registerNamespace", () => {
  test("adds a namespace without disturbing the shipped ones", () => {
    register({ name: "invoice", relations: { viewer: { union: [{ this: {} }] } } });
    expect(getValidRelations("invoice")).toEqual(["viewer"]);
    expect(getNamespace("item")).toBeDefined();
    expect(getNamespace("user")).toBeDefined();
  });

  test("a module's namespace survives loadNamespaces(), which tests call to reset", () => {
    // loadNamespaces() used to clear the registry back to the hardcoded
    // defaults, dropping every namespace a module had added.
    register({ name: "invoice", relations: { viewer: { union: [{ this: {} }] } } });
    loadNamespaces();
    expect(getValidRelations("invoice")).toEqual(["viewer"]);
  });

  test("loadNamespaces(configs) still replaces the registry wholesale, for tests", () => {
    register({ name: "invoice" });
    loadNamespaces([{ name: "only" }]);
    expect(getNamespace("invoice")).toBeUndefined();
    expect(getNamespace("item")).toBeUndefined();
    loadNamespaces();
    expect(getNamespace("invoice")).toBeDefined();
  });

  test("registering the same config twice is a no-op", () => {
    const config: NamespaceConfig = { name: "invoice", relations: { viewer: { union: [{ this: {} }] } } };
    register(config);
    expect(() => registerNamespace({ name: "invoice", relations: { viewer: { union: [{ this: {} }] } } })).not.toThrow();
  });

  test("a different config under a taken name is rejected", () => {
    // Two modules claiming one namespace would silently change each other's
    // access ladder; fail at boot instead.
    register({ name: "invoice", relations: { viewer: { union: [{ this: {} }] } } });
    expect(() => registerNamespace({ name: "invoice", relations: { owner: { union: [{ this: {} }] } } })).toThrow("invoice");
    expect(() => registerNamespace({ name: "item" })).toThrow("item");
  });
});
