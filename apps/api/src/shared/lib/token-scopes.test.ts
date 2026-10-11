import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __isolateTokenScopesForTests, getTokenScopes, registerTokenScope, tokenScopesAllow } from "./token-scopes";

let restore: () => void;
beforeEach(() => {
  restore = __isolateTokenScopesForTests();
  registerTokenScope({
    name: "issues:read",
    description: "Read issues",
    routes: [{ method: "GET", path: "/issues" }, { method: "GET", path: "/issues/*" }],
  });
  registerTokenScope({
    name: "issues:write",
    description: "Change issues",
    routes: [{ method: "POST", path: "/issues" }, { method: "PATCH", path: "/issues/:id" }],
  });
});
afterEach(() => restore());

describe("tokenScopesAllow", () => {
  test("allows a route one of the token's scopes covers", () => {
    expect(tokenScopesAllow(["issues:read"], "GET", "/issues")).toBe(true);
    expect(tokenScopesAllow(["issues:read"], "GET", "/issues/abc/comments")).toBe(true);
    expect(tokenScopesAllow(["issues:write"], "PATCH", "/issues/abc")).toBe(true);
  });

  test("denies by default: a route no scope covers is closed to every token", () => {
    expect(tokenScopesAllow(["issues:read", "issues:write"], "GET", "/account/me/tokens")).toBe(false);
    expect(tokenScopesAllow(["issues:read", "issues:write"], "DELETE", "/issues/abc")).toBe(false);
  });

  test("denies a route covered only by a scope the token lacks", () => {
    expect(tokenScopesAllow(["issues:read"], "POST", "/issues")).toBe(false);
  });

  test("matches whole segments", () => {
    expect(tokenScopesAllow(["issues:read"], "GET", "/issues-archive")).toBe(false);
    expect(tokenScopesAllow(["issues:write"], "PATCH", "/issues/abc/comments")).toBe(false);
    expect(tokenScopesAllow(["issues:write"], "PATCH", "/issues/")).toBe(false);
  });

  test("ignores scopes that are not registered", () => {
    expect(tokenScopesAllow(["admin:everything"], "GET", "/issues")).toBe(false);
  });
});

describe("registerTokenScope", () => {
  test("lists registered scopes without their route patterns", () => {
    expect(getTokenScopes()).toEqual([
      { name: "issues:read", description: "Read issues" },
      { name: "issues:write", description: "Change issues" },
    ]);
  });

  test("rejects a second registration under a taken name", () => {
    expect(() => registerTokenScope({ name: "issues:read", description: "again", routes: [] })).toThrow("issues:read");
  });

  test("rejects a malformed name", () => {
    expect(() => registerTokenScope({ name: "Issues Read", description: "x", routes: [] })).toThrow();
  });
});
