import { describe, expect, it } from "vitest";
import { keyInputError } from "./-detail-key-input";

const KEY = "3q2-7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("keyInputError", () => {
  it("accepts a bare base64url key", () => {
    expect(keyInputError(KEY)).toBeUndefined();
  });

  it("accepts a padded standard base64 key", () => {
    expect(keyInputError("3q2+7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")).toBeUndefined();
  });

  it("accepts lode's prefixed forms", () => {
    expect(keyInputError(`0123456789abcdef:${KEY}`)).toBeUndefined();
    expect(keyInputError(`ed25519:${KEY}`)).toBeUndefined();
    expect(keyInputError(`ed25519:0123456789abcdef:${KEY}`)).toBeUndefined();
  });

  it("ignores surrounding whitespace", () => {
    expect(keyInputError(`  ${KEY}\n`)).toBeUndefined();
  });

  it("rejects empty and whitespace-only input", () => {
    expect(keyInputError("")).toBe("empty");
    expect(keyInputError(" \n\t ")).toBe("empty");
  });

  it("rejects whitespace inside the key", () => {
    expect(keyInputError(`${KEY.slice(0, 20)} ${KEY.slice(20)}`)).toBe("whitespace");
    expect(keyInputError(`${KEY.slice(0, 20)}\n${KEY.slice(20)}`)).toBe("whitespace");
    expect(keyInputError(`ed25519: ${KEY}`)).toBe("whitespace");
  });

  it("rejects a PEM block", () => {
    expect(keyInputError(`-----BEGIN PUBLIC KEY-----\n${KEY}\n-----END PUBLIC KEY-----`)).toBe("privateKey");
    expect(keyInputError("-----BEGINPUBLICKEY-----")).toBe("privateKey");
  });

  it("rejects input that names a private key", () => {
    expect(keyInputError(`-----BEGIN PRIVATE KEY-----\n${KEY}\n-----END PRIVATE KEY-----`)).toBe("privateKey");
    expect(keyInputError(`PRIVATE:${KEY}`)).toBe("privateKey");
    expect(keyInputError(`private:${KEY}`)).toBe("privateKey");
  });
});
