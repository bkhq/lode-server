import { describe, expect, it } from "vitest";
import { safeRedirect } from "./-safe-redirect";

const ORIGIN = "https://registry.example.com";
const FALLBACK = "/overview";

describe("safeRedirect", () => {
  it("keeps a path on this site, with its query and hash", () => {
    expect(safeRedirect("/packages/ns/pkg?tab=keys#top", ORIGIN, FALLBACK)).toBe("/packages/ns/pkg?tab=keys#top");
  });

  it("falls back when there is nothing to continue to", () => {
    expect(safeRedirect(undefined, ORIGIN, FALLBACK)).toBe(FALLBACK);
    expect(safeRedirect("", ORIGIN, FALLBACK)).toBe(FALLBACK);
  });

  it("refuses every spelling of another host", () => {
    for (const url of [
      "//evil.example",
      "/\\evil.example",
      "/\\/evil.example",
      "\\\\evil.example",
      "https://evil.example/",
      "javascript:alert(1)",
      "/\t/evil.example",
    ]) {
      expect(`${url} -> ${safeRedirect(url, ORIGIN, FALLBACK)}`).toBe(`${url} -> ${FALLBACK}`);
    }
  });
});
