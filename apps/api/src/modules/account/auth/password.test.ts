import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { hashPassword, verifyPassword } from "./password";

describe("hashPassword + verifyPassword (PBKDF2 default)", () => {
  test("round-trip succeeds", async () => {
    const stored = await hashPassword("correct-horse-battery-staple");
    expect(stored.startsWith("pbkdf2-sha256$")).toBe(true);
    expect(await verifyPassword("correct-horse-battery-staple", stored)).toBe(true);
  });

  test("wrong password rejected", async () => {
    const stored = await hashPassword("correct-horse-battery-staple");
    expect(await verifyPassword("not the password", stored)).toBe(false);
  });

  test("each hash uses a distinct salt", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  test("encoded shape: pbkdf2-sha256$<iter>$<saltB64>$<hashB64>", async () => {
    const stored = await hashPassword("pw");
    const parts = stored.split("$");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe("pbkdf2-sha256");
    expect(Number(parts[1])).toBeGreaterThanOrEqual(600_000);
    expect(Buffer.from(parts[2]!, "base64").length).toBe(16);
    expect(Buffer.from(parts[3]!, "base64").length).toBe(32);
  });
});

describe("verifyPassword accepts alternative hash formats", () => {
  test("argon2id hashes verify", async () => {
    const argon2id = await Bun.password.hash("argon-secret", { algorithm: "argon2id" });
    expect(argon2id.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword("argon-secret", argon2id)).toBe(true);
    expect(await verifyPassword("wrong", argon2id)).toBe(false);
  });

  test("bcrypt hashes verify (htpasswd -B output)", async () => {
    const bcrypt = await Bun.password.hash("htpasswd-secret", { algorithm: "bcrypt", cost: 4 });
    expect(/^\$2[aby]\$/.test(bcrypt)).toBe(true);
    expect(await verifyPassword("htpasswd-secret", bcrypt)).toBe(true);
    expect(await verifyPassword("wrong", bcrypt)).toBe(false);
  });

  test("verifies a PBKDF2 hash produced by Node crypto.pbkdf2Sync (openssl-equivalent)", async () => {
    const { pbkdf2Sync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const iters = 600_000;
    const hash = pbkdf2Sync("openssl-style", salt, iters, 32, "sha256");
    const stored = `pbkdf2-sha256$${iters}$${salt.toString("base64")}$${hash.toString("base64")}`;
    expect(await verifyPassword("openssl-style", stored)).toBe(true);
  });

  test("rejects unknown prefix", async () => {
    expect(await verifyPassword("anything", "bcrypt$2b$10$abcdef")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });

  test("rejects malformed pbkdf2 hash", async () => {
    expect(await verifyPassword("x", "pbkdf2-sha256$abc$def")).toBe(false); // missing field
    expect(await verifyPassword("x", "pbkdf2-sha256$0$ZGVm$ZGVm")).toBe(false); // iter too low
  });
});
