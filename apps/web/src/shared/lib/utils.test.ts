import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps the last conflicting Tailwind utility", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("filters falsy values while keeping valid classes", () => {
    expect(cn("font-semibold", false && "hidden", undefined, "text-sm")).toBe("font-semibold text-sm");
  });
});
