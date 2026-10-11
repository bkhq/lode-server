import { describe, expect, it } from "vitest";
import en from "@/locales/en/regerrors.json";
import zh from "@/locales/zh/regerrors.json";
import { HttpError } from "@/shared/lib/http";
import { REGISTRY_ERROR_CODES, registryErrorMessage } from "./errors";

const t = (key: string) => `t(${key})`;

describe("registryErrorMessage", () => {
  it("translates a known registry code", () => {
    const err = new HttpError("server text", 409, "VERSION_IN_CHANNEL");
    expect(registryErrorMessage(err, t, "fallback")).toBe("t(regerrors:VERSION_IN_CHANNEL)");
  });

  it("translates every known code", () => {
    for (const code of REGISTRY_ERROR_CODES)
      expect(registryErrorMessage(new HttpError("x", 400, code), t, "fallback")).toBe(`t(regerrors:${code})`);
  });

  it("returns the fallback for an unknown code", () => {
    const err = new HttpError("server text", 404, "NOT_FOUND");
    expect(registryErrorMessage(err, t, "fallback")).toBe("fallback");
  });

  it("returns the message of a code-less HttpError", () => {
    expect(registryErrorMessage(new HttpError("HTTP 502", 502), t, "fallback")).toBe("HTTP 502");
  });

  it("returns the message of a plain Error", () => {
    expect(registryErrorMessage(new Error("boom"), t, "fallback")).toBe("boom");
  });

  it("returns the fallback for a non-error value", () => {
    expect(registryErrorMessage("nope", t, "fallback")).toBe("fallback");
    expect(registryErrorMessage(undefined, t, "fallback")).toBe("fallback");
  });
});

describe("regerrors locale shard", () => {
  it("has exactly one message per known code in both languages", () => {
    const codes = [...REGISTRY_ERROR_CODES].sort();
    expect(Object.keys(en).sort()).toEqual(codes);
    expect(Object.keys(zh).sort()).toEqual(codes);
  });
});
