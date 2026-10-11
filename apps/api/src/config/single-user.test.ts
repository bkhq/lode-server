import type { Config } from "./schema";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { customAlphabet } from "nanoid";
import { ConfigError } from "./errors";
import { oauthInPlay, readPasswordHashFile, resolveSingleUserConfig } from "./single-user";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let workdir: string;

beforeEach(() => {
  workdir = resolve(tmpdir(), `cfg-singleuser-${Date.now()}-${nanoid()}`);
  mkdirSync(workdir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workdir))
    rmSync(workdir, { recursive: true, force: true });
});

function baseData(overrides: Partial<Config> = {}): Config {
  return {
    SINGLE_USER_MODE: false,
    SINGLE_USER_USERNAME: undefined,
    SINGLE_USER_PASSWORD_HASH: undefined,
    SINGLE_USER_PASSWORD_HASH_FILE: undefined,
    OAUTH_CLIENT_ID: undefined,
    ...overrides,
  } as unknown as Config;
}

describe("readPasswordHashFile", () => {
  test("strips htpasswd `user:hash` prefix", () => {
    const path = join(workdir, "h.txt");
    writeFileSync(path, "admin:$2y$05$abcdefghijklmnopqrstuv\n");
    expect(readPasswordHashFile(path)).toBe("$2y$05$abcdefghijklmnopqrstuv");
  });

  test("accepts a raw hash line", () => {
    const path = join(workdir, "h.txt");
    writeFileSync(path, "$argon2id$v=19$m=65536,t=3,p=4$abc$xyz\n");
    expect(readPasswordHashFile(path)).toBe("$argon2id$v=19$m=65536,t=3,p=4$abc$xyz");
  });

  test("skips blank and comment lines, picks the first hash", () => {
    const path = join(workdir, "h.txt");
    writeFileSync(path, "# comment\n\n  \npbkdf2-sha256$600000$saltsalt$hashhash\n# next\n");
    expect(readPasswordHashFile(path)).toBe("pbkdf2-sha256$600000$saltsalt$hashhash");
  });

  test("throws when no hash line is found", () => {
    const path = join(workdir, "h.txt");
    writeFileSync(path, "# only comments\n");
    expect(() => readPasswordHashFile(path)).toThrow(/no hash found/);
  });
});

describe("resolveSingleUserConfig", () => {
  const id = (p: string) => p; // identity resolvePath for the test

  test("no-op when SINGLE_USER_MODE is off", () => {
    const data = baseData();
    expect(() => resolveSingleUserConfig(data, id)).not.toThrow();
  });

  test("loads the hash from FILE when only the path was provided", () => {
    const path = join(workdir, "h.txt");
    writeFileSync(path, "$argon2id$v=19$m=65536,t=3,p=4$abc$xyz\n");
    const data = baseData({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "admin",
      SINGLE_USER_PASSWORD_HASH_FILE: path,
    });
    resolveSingleUserConfig(data, id);
    expect(data.SINGLE_USER_PASSWORD_HASH).toMatch(/^\$argon2id\$/);
  });

  test("throws ConfigError when the file is unreadable", () => {
    const data = baseData({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "admin",
      SINGLE_USER_PASSWORD_HASH_FILE: join(workdir, "missing.txt"),
    });
    expect(() => resolveSingleUserConfig(data, id)).toThrow(ConfigError);
  });

  test("throws ConfigError when username or hash is missing", () => {
    expect(() => resolveSingleUserConfig(baseData({ SINGLE_USER_MODE: true }), id)).toThrow(/USERNAME/);
    expect(() => resolveSingleUserConfig(
      baseData({ SINGLE_USER_MODE: true, SINGLE_USER_USERNAME: "admin" }),
      id,
    )).toThrow(/USERNAME/);
  });

  test("rejects an unrecognised hash format", () => {
    const data = baseData({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "admin",
      SINGLE_USER_PASSWORD_HASH: "plaintext-not-a-hash",
    });
    expect(() => resolveSingleUserConfig(data, id)).toThrow(/recognised hash format/);
  });

  test.each([
    "$argon2id$v=19$m=65536,t=3,p=4$abc$xyz",
    "$argon2i$v=19$m=65536,t=3,p=4$abc$xyz",
    "$argon2d$v=19$m=65536,t=3,p=4$abc$xyz",
    "$2a$10$abcdefghijklmnopqrstuv",
    "$2b$10$abcdefghijklmnopqrstuv",
    "$2y$10$abcdefghijklmnopqrstuv",
    "pbkdf2-sha256$600000$salt$hash",
  ])("accepts hash %s", (hash) => {
    const data = baseData({
      SINGLE_USER_MODE: true,
      SINGLE_USER_USERNAME: "admin",
      SINGLE_USER_PASSWORD_HASH: hash,
    });
    expect(() => resolveSingleUserConfig(data, id)).not.toThrow();
  });
});

describe("oauthInPlay", () => {
  test("true when single-user mode is off (OAuth handles login)", () => {
    expect(oauthInPlay(baseData())).toBe(true);
  });

  test("true when single-user mode is on but an OAuth client is also configured", () => {
    expect(oauthInPlay(baseData({
      SINGLE_USER_MODE: true,
      OAUTH_CLIENT_ID: "client-id",
    }))).toBe(true);
  });

  test("false in pure single-user deployments (no OAuth client)", () => {
    expect(oauthInPlay(baseData({ SINGLE_USER_MODE: true }))).toBe(false);
  });
});
