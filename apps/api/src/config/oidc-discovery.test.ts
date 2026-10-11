import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { customAlphabet } from "nanoid";
import {
  discoveryEndpointsMatchIssuer,
  readDiscoveryCache,
  writeDiscoveryCache,
} from "./oidc-discovery";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let workdir: string;

beforeEach(() => {
  workdir = resolve(tmpdir(), `cfg-oidc-${Date.now()}-${nanoid()}`);
  mkdirSync(workdir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workdir))
    rmSync(workdir, { recursive: true, force: true });
});

describe("discoveryEndpointsMatchIssuer", () => {
  const issuer = "https://idp.example.com";
  const ok = {
    authorization_endpoint: "https://idp.example.com/authorize",
    token_endpoint: "https://idp.example.com/token",
    userinfo_endpoint: "https://idp.example.com/userinfo",
    end_session_endpoint: "https://idp.example.com/logout",
  };

  test("accepts a fully same-origin discovery", () => {
    expect(discoveryEndpointsMatchIssuer(ok, issuer)).toBe(true);
  });

  test("rejects when authorize_endpoint is off-origin", () => {
    expect(discoveryEndpointsMatchIssuer({
      ...ok,
      authorization_endpoint: "https://attacker.example.com/authorize",
    }, issuer)).toBe(false);
  });

  test("rejects when token_endpoint is off-origin", () => {
    expect(discoveryEndpointsMatchIssuer({
      ...ok,
      token_endpoint: "https://attacker.example.com/token",
    }, issuer)).toBe(false);
  });

  test("rejects when userinfo_endpoint is off-origin", () => {
    expect(discoveryEndpointsMatchIssuer({
      ...ok,
      userinfo_endpoint: "https://attacker.example.com/userinfo",
    }, issuer)).toBe(false);
  });

  test("rejects when end_session_endpoint is off-origin", () => {
    expect(discoveryEndpointsMatchIssuer({
      ...ok,
      end_session_endpoint: "https://attacker.example.com/logout",
    }, issuer)).toBe(false);
  });

  test("accepts when end_session_endpoint is omitted", () => {
    const { end_session_endpoint: _omit, ...rest } = ok;
    expect(discoveryEndpointsMatchIssuer(rest, issuer)).toBe(true);
  });

  test("rejects when an endpoint is malformed", () => {
    expect(discoveryEndpointsMatchIssuer({
      ...ok,
      token_endpoint: "not a url",
    }, issuer)).toBe(false);
  });

  test("rejects when the issuer itself is malformed", () => {
    expect(discoveryEndpointsMatchIssuer(ok, "not-a-url")).toBe(false);
  });
});

describe("readDiscoveryCache / writeDiscoveryCache", () => {
  const issuer = "https://idp.example.com";
  const ok = {
    authorization_endpoint: "https://idp.example.com/authorize",
    token_endpoint: "https://idp.example.com/token",
    userinfo_endpoint: "https://idp.example.com/userinfo",
  };

  test("returns null discovery + blank warnings when the file is missing", async () => {
    const result = await readDiscoveryCache(join(workdir, "nope.json"), issuer);
    expect(result.discovery).toBeNull();
    expect(result.warnings.tampered).toBe(false);
    expect(result.warnings.stale).toBe(false);
  });

  test("returns null discovery + blank warnings when the cached issuer differs", async () => {
    const path = join(workdir, "c.json");
    await writeDiscoveryCache(path, "https://other.example.com", ok);
    const result = await readDiscoveryCache(path, issuer);
    expect(result.discovery).toBeNull();
  });

  test("flags tampered when an off-origin endpoint sits in the cache", async () => {
    const path = join(workdir, "c.json");
    await writeDiscoveryCache(path, issuer, {
      ...ok,
      token_endpoint: "https://attacker.example.com/token",
    });
    const result = await readDiscoveryCache(path, issuer);
    expect(result.discovery).toBeNull();
    expect(result.warnings.tampered).toBe(true);
  });

  test("returns the cached discovery when same-origin and fresh", async () => {
    const path = join(workdir, "c.json");
    await writeDiscoveryCache(path, issuer, ok);
    const result = await readDiscoveryCache(path, issuer);
    expect(result.discovery).toEqual(ok);
    expect(result.warnings.tampered).toBe(false);
  });
});
