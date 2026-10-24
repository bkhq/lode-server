import { describe, expect, it } from "vitest";
import { describeGrants, GRANT_LEVELS, grantCount, isAllGrant } from "./grants";

describe("gRANT_LEVELS", () => {
  it("lists the levels from weakest to strongest", () => {
    expect(GRANT_LEVELS).toEqual(["read", "write", "admin"]);
  });
});

describe("isAllGrant", () => {
  it("is true for the all-packages form", () => {
    expect(isAllGrant({ all: "write" })).toBe(true);
  });

  it("is false for a list, empty or not", () => {
    expect(isAllGrant([])).toBe(false);
    expect(isAllGrant([
      { package: "abcd1234/app", access: "read" },
    ])).toBe(false);
  });
});

describe("grantCount", () => {
  it("is 0 for an empty list", () => {
    expect(grantCount([])).toBe(0);
  });

  it("counts the listed packages", () => {
    expect(grantCount([
      { package: "abcd1234/app", access: "read" },
      { package: "abcd1234/cli", access: "admin" },
    ])).toBe(2);
  });

  it("counts the all-packages grant as one", () => {
    expect(grantCount({ all: "read" })).toBe(1);
  });
});

describe("describeGrants", () => {
  it("describes an empty list as none", () => {
    expect(describeGrants([])).toEqual({ kind: "none" });
  });

  it("describes the all-packages form with its level", () => {
    expect(describeGrants({ all: "admin" })).toEqual({ kind: "all", access: "admin" });
  });

  it("describes a list with its items in order", () => {
    expect(describeGrants([
      { package: "abcd1234/cli", access: "write" },
      { package: "abcd1234/app", access: "read" },
    ])).toEqual({
      kind: "packages",
      items: [
        { package: "abcd1234/cli", access: "write" },
        { package: "abcd1234/app", access: "read" },
      ],
    });
  });
});
