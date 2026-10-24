import { describe, expect, test } from "bun:test";
import { commandOverrideError, displayNameError, idError, MAX_DISPLAY_NAME_LENGTH, MAX_ID_LENGTH, packageSlugError } from "./validate";

// The accept / reject lists are the ones lode's own tests use
// (crates/lode-core/src/idval.rs), so the two validators cannot drift apart
// unnoticed.
describe("idError", () => {
  test("accepts real versions and names", () => {
    for (const id of [
      "1.5.0",
      "1.6.0-beta.2",
      "1.6.0-rc.1",
      "0.0.0-dev",
      "v1.5.0",
      "2024.1",
      "nightly",
      "vNext",
      "runtime",
      "bun",
    ])
      expect(idError("version", id)).toBeUndefined();
  });

  test("rejects traversal and funny bytes", () => {
    for (const id of [
      "",
      "..",
      ".",
      "../../etc",
      "/abs",
      "a/b",
      "a\\b",
      ".hidden",
      "-flag",
      "a\u0000b",
      "foo/../bar",
    ])
      expect(idError("version", id)).toBeString();
  });

  test("rejects anything outside the ASCII charset", () => {
    for (const id of [
      "a b",
      "café",
      "a b",
      "a:b",
      "a@b",
      "a+b",
      "你好",
    ])
      expect(idError("version", id)).toBeString();
  });

  test("the error names the kind and quotes the id", () => {
    const msg = idError("version", "../../etc")!;
    expect(msg).toContain("version");
    expect(msg).toContain("\"../../etc\"");
  });

  test("does not echo control characters raw", () => {
    expect(idError("version", "a\u0007b")).not.toContain("\u0007");
  });

  test("caps the length, which lode leaves unbounded", () => {
    expect(idError("version", "a".repeat(MAX_ID_LENGTH))).toBeUndefined();
    expect(idError("version", "a".repeat(MAX_ID_LENGTH + 1))).toBeString();
  });
});

describe("packageSlugError", () => {
  test("accepts an ordinary slug", () => {
    for (const slug of [
      "tool",
      "my-tool",
      "a",
      "2fast",
      "tool-42",
      "a--b",
      "a-",
      "a".repeat(MAX_ID_LENGTH),
    ])
      expect(packageSlugError(slug)).toBeUndefined();
  });

  test("allows only lowercase letters, digits and '-'", () => {
    for (const slug of [
      "Tool",
      "TOOL",
      "my_tool",
      "my.tool",
      "my-tool_2.0",
      "a b",
      "a/b",
      "..",
      "caf\u00E9",
      "a\u0000b",
    ])
      expect(packageSlugError(slug)).toBeString();
  });

  test("refuses an empty slug, a leading '-' and anything too long", () => {
    expect(packageSlugError("")).toContain("must not be empty");
    expect(packageSlugError("-tool")).toContain("must not start with '-'");
    expect(packageSlugError("a".repeat(MAX_ID_LENGTH + 1))).toContain("longer than");
  });

  test("does not echo control characters raw", () => {
    expect(packageSlugError("a\u0007b")).not.toContain("\u0007");
  });
});

describe("displayNameError", () => {
  test("accepts free text", () => {
    for (const name of [
      "Tool",
      "My Tool (v2)",
      "a",
      "\u5DE5\u5177",
      "caf\u00E9 \u{1F527}",
      "x".repeat(MAX_DISPLAY_NAME_LENGTH),
    ])
      expect(displayNameError(name)).toBeUndefined();
  });

  test("counts characters, not UTF-16 units", () => {
    expect(displayNameError("\u{1F527}".repeat(MAX_DISPLAY_NAME_LENGTH))).toBeUndefined();
    expect(displayNameError("\u{1F527}".repeat(MAX_DISPLAY_NAME_LENGTH + 1))).toBeString();
  });

  test("refuses an empty name, a long one and control characters", () => {
    expect(displayNameError("")).toBeString();
    expect(displayNameError("x".repeat(MAX_DISPLAY_NAME_LENGTH + 1))).toBeString();
    for (const name of [
      "a\nb",
      "a\tb",
      "a\u0000b",
      "a\u007Fb",
      "a\u0085b",
    ])
      expect(displayNameError(name)).toBeString();
    expect(displayNameError("a\u0007b")).not.toContain("\u0007");
  });
});

describe("commandOverrideError", () => {
  test("accepts an ordinary command", () => {
    expect(commandOverrideError("run", "bin/app --serve")).toBeUndefined();
    expect(commandOverrideError("exec", "app")).toBeUndefined();
    // Not whitespace and not a control character in lode's terms.
    expect(commandOverrideError("run", "﻿")).toBeUndefined();
  });

  test("rejects a blank value", () => {
    for (const value of ["", " ", "   ", " ", "　  "])
      expect(commandOverrideError("run", value)).toContain("must not be blank");
  });

  test("rejects control characters", () => {
    for (const value of [
      "a\nb",
      "a\tb",
      "a\rb",
      "a\u0000b",
      "a\u007Fb",
      "a\u0085b",
      "a\u009Fb",
      "\n",
    ])
      expect(commandOverrideError("exec", value)).toBeString();
    expect(commandOverrideError("exec", "a\u0007b")).not.toContain("\u0007");
  });
});
