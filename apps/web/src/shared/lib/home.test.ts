import { describe, expect, it } from "vitest";
import { showsHome } from "./home";

describe("showsHome", () => {
  it("is never shown when off", () => {
    for (const root of [true, false]) {
      for (const base of ["", "/app"])
        expect(showsHome("off", root, base)).toBe(false);
    }
  });

  it("base mode shows it under the prefix and not at the origin root", () => {
    expect(showsHome("base", false, "/app")).toBe(true);
    expect(showsHome("base", true, "/app")).toBe(false);
  });

  it("root mode shows it at the origin root and not under the prefix", () => {
    expect(showsHome("root", true, "/app")).toBe(true);
    expect(showsHome("root", false, "/app")).toBe(false);
  });

  it("without a BASE_PATH both modes show it at /", () => {
    expect(showsHome("base", false, "")).toBe(true);
    expect(showsHome("root", false, "")).toBe(true);
  });
});
