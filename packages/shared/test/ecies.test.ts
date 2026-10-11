import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  deriveKeyPairFromPassword,
  eciesDecrypt,
  eciesEncrypt,
  generateKeyPair,
  generateSalt,
  hexToBytes,
} from "../src/ecies";

describe("hex helpers", () => {
  it("bytesToHex / hexToBytes round-trip", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 254, 255]);
    expect(bytesToHex(bytes)).toBe("00010f10feff");
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it("hexToBytes handles uppercase + lowercase", () => {
    expect(bytesToHex(hexToBytes("ABCDEF"))).toBe("abcdef");
  });
});

describe("generateKeyPair", () => {
  it("returns 32-byte private + 65-byte uncompressed public, both hex", () => {
    const kp = generateKeyPair();
    expect(kp.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(kp.publicKey).toMatch(/^04[0-9a-f]{128}$/);
  });

  it("each call produces a fresh key", () => {
    expect(generateKeyPair().privateKey).not.toBe(generateKeyPair().privateKey);
  });
});

describe("generateSalt", () => {
  it("returns 32 random bytes hex-encoded", () => {
    const a = generateSalt();
    const b = generateSalt();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("deriveKeyPairFromPassword", () => {
  it("same password + salt produce the same keypair (deterministic)", async () => {
    const salt = "11".repeat(32);
    const kp1 = await deriveKeyPairFromPassword("hunter2", salt);
    const kp2 = await deriveKeyPairFromPassword("hunter2", salt);
    expect(kp1.privateKey).toBe(kp2.privateKey);
    expect(kp1.publicKey).toBe(kp2.publicKey);
  });

  it("different salts produce different keys", async () => {
    const a = await deriveKeyPairFromPassword("hunter2", "11".repeat(32));
    const b = await deriveKeyPairFromPassword("hunter2", "22".repeat(32));
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it("different passwords produce different keys", async () => {
    const salt = "11".repeat(32);
    const a = await deriveKeyPairFromPassword("hunter2", salt);
    const b = await deriveKeyPairFromPassword("hunter3", salt);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe("eciesEncrypt + eciesDecrypt", () => {
  it("round-trips a plaintext under a freshly-generated keypair", async () => {
    const kp = generateKeyPair();
    const plaintext = new TextEncoder().encode("the quick brown fox");
    const ct = await eciesEncrypt(kp.publicKey, plaintext);
    // Layout: 65-byte ephemeral pubkey + 12-byte iv + (plaintext + 16-byte tag)
    expect(ct.length).toBe(65 + 12 + plaintext.length + 16);
    const recovered = await eciesDecrypt(kp.privateKey, ct);
    expect(new TextDecoder().decode(recovered)).toBe("the quick brown fox");
  });

  it("each encryption produces a fresh ciphertext (random IV + ephemeral key)", async () => {
    const kp = generateKeyPair();
    const plaintext = new Uint8Array([1, 2, 3]);
    const a = await eciesEncrypt(kp.publicKey, plaintext);
    const b = await eciesEncrypt(kp.publicKey, plaintext);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it("eciesDecrypt with the wrong private key fails", async () => {
    const kp = generateKeyPair();
    const other = generateKeyPair();
    const ct = await eciesEncrypt(kp.publicKey, new Uint8Array([42]));
    await expect(eciesDecrypt(other.privateKey, ct)).rejects.toThrow();
  });

  it("rejects an invalid public-key hex", async () => {
    await expect(eciesEncrypt("not-a-key", new Uint8Array([1]))).rejects.toThrow();
  });

  it("works with password-derived keypair (used by setup / unlock)", async () => {
    const salt = "33".repeat(32);
    const kp = await deriveKeyPairFromPassword("password", salt);
    const ct = await eciesEncrypt(kp.publicKey, new TextEncoder().encode("deadbeef"));
    const out = await eciesDecrypt(kp.privateKey, ct);
    expect(new TextDecoder().decode(out)).toBe("deadbeef");
  });
});
