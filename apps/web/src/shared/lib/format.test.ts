import { describe, expect, it } from "vitest";
import { getInitials } from "./format";

describe("getInitials", () => {
  it("takes the first letter of the first two words, upper-cased", () => {
    expect(getInitials("maria van der berg")).toBe("MV");
    expect(getInitials("Nikos")).toBe("N");
  });
});
