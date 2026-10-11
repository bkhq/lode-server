import { describe, expect, it } from "vitest";
import { validatePackageName, validatePackageSlug } from "./-list-slug";

describe("validatePackageSlug", () => {
  it("accepts lowercase letters, digits and '-'", () => {
    expect(validatePackageSlug("a")).toBeUndefined();
    expect(validatePackageSlug("my-app-2")).toBeUndefined();
    expect(validatePackageSlug("0day")).toBeUndefined();
    expect(validatePackageSlug("trailing-")).toBeUndefined();
  });

  it("rejects an empty slug", () => {
    expect(validatePackageSlug("")).toBe("empty");
  });

  it("rejects a leading '-'", () => {
    expect(validatePackageSlug("-app")).toBe("leadingDash");
    expect(validatePackageSlug("-")).toBe("leadingDash");
  });

  it("rejects uppercase letters", () => {
    expect(validatePackageSlug("MyApp")).toBe("uppercase");
    expect(validatePackageSlug("appX")).toBe("uppercase");
  });

  it("rejects any other character", () => {
    expect(validatePackageSlug("my_app")).toBe("illegalChar");
    expect(validatePackageSlug("my.app")).toBe("illegalChar");
    expect(validatePackageSlug("my app")).toBe("illegalChar");
    expect(validatePackageSlug(" app")).toBe("illegalChar");
    expect(validatePackageSlug("a/b")).toBe("illegalChar");
    expect(validatePackageSlug("café")).toBe("illegalChar");
  });

  it("reports an illegal character ahead of uppercase", () => {
    expect(validatePackageSlug("My_App")).toBe("illegalChar");
  });

  it("allows 128 characters and rejects 129", () => {
    expect(validatePackageSlug("a".repeat(128))).toBeUndefined();
    expect(validatePackageSlug("a".repeat(129))).toBe("tooLong");
  });
});

describe("validatePackageName", () => {
  it("accepts free text of 1 to 100 characters", () => {
    expect(validatePackageName("A")).toBeUndefined();
    expect(validatePackageName("My App (beta)")).toBeUndefined();
    expect(validatePackageName("a".repeat(100))).toBeUndefined();
  });

  it("rejects an empty or blank name", () => {
    expect(validatePackageName("")).toBe("empty");
    expect(validatePackageName("   ")).toBe("empty");
  });

  it("measures the trimmed name", () => {
    expect(validatePackageName(`  ${"a".repeat(100)}  `)).toBeUndefined();
  });

  it("rejects more than 100 characters", () => {
    expect(validatePackageName("a".repeat(101))).toBe("tooLong");
  });

  it("counts code points, not UTF-16 units", () => {
    expect(validatePackageName("\u{1F4E6}".repeat(100))).toBeUndefined();
    expect(validatePackageName("\u{1F4E6}".repeat(101))).toBe("tooLong");
  });

  it("rejects a control character", () => {
    expect(validatePackageName("my\u0000app")).toBe("controlChar");
    expect(validatePackageName("line\nbreak")).toBe("controlChar");
  });
});
