import { describe, expect, test } from "bun:test";
import { mimeMatchesContent, sniffKind } from "./mime-sniff";

function bytes(...vals: number[]): Uint8Array {
  return Uint8Array.from(vals);
}

describe("sniffKind", () => {
  test("recognises specific image subtypes by magic bytes", () => {
    expect(sniffKind(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))).toBe("png");
    expect(sniffKind(bytes(0xFF, 0xD8, 0xFF, 0xE0))).toBe("jpeg");
    expect(sniffKind(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("gif");
    expect(sniffKind(bytes(0x42, 0x4D, 0x00, 0x00))).toBe("bmp");
    expect(sniffKind(bytes(0x49, 0x49, 0x2A, 0x00))).toBe("tiff");
    // WebP: RIFF????WEBP — the offset-8 marker disambiguates from WAV/AVI.
    expect(sniffKind(bytes(0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50))).toBe("webp");
  });

  test("recognises PDF, ZIP, 7z magic bytes", () => {
    expect(sniffKind(bytes(0x25, 0x50, 0x44, 0x46, 0x2D, 0x31))).toBe("pdf");
    expect(sniffKind(bytes(0x50, 0x4B, 0x03, 0x04))).toBe("zip");
    expect(sniffKind(bytes(0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C))).toBe("7z");
  });

  test("RIFF prefix without WEBP marker is NOT classified as webp", () => {
    // Bare RIFF could be WAV / AVI — we sniff null so the upload path falls
    // through to the "no signature matched" rejection.
    expect(sniffKind(bytes(0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45))).toBeNull();
  });

  test("classifies plain ASCII as text", () => {
    expect(sniffKind(new TextEncoder().encode("hello, world\n"))).toBe("text");
    expect(sniffKind(new Uint8Array(0))).toBe("text");
  });

  test("returns null for unknown binary blobs (e.g. SVG/XML)", () => {
    // SVG: starts with `<svg` ASCII, currently classified as text — that is
    // intentional: we accept text/svg+xml only via the higher-level mimetype
    // check, never inline-render. The signature itself is text-y.
    expect(sniffKind(bytes(0x00, 0x01, 0x02, 0x03, 0x04))).toBeNull();
  });
});

describe("mimeMatchesContent", () => {
  test("png claimed as image/png passes", () => {
    expect(mimeMatchesContent("image/png", bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))).toBe(true);
  });

  test("png claimed as image/jpeg is REJECTED (subtype mismatch)", () => {
    // Subtype must match exactly so audit / quota rows record the right thing.
    expect(mimeMatchesContent("image/jpeg", bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))).toBe(false);
  });

  test("jpeg claimed as image/jpg (common alias) passes", () => {
    expect(mimeMatchesContent("image/jpg", bytes(0xFF, 0xD8, 0xFF, 0xE0))).toBe(true);
  });

  test("png claimed as application/pdf is rejected", () => {
    expect(mimeMatchesContent("application/pdf", bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))).toBe(false);
  });

  test("text claimed as text/csv passes", () => {
    expect(mimeMatchesContent("text/csv", new TextEncoder().encode("a,b,c\n1,2,3"))).toBe(true);
  });

  test("text claimed as image/svg+xml is rejected (must use text/*)", () => {
    expect(mimeMatchesContent("image/svg+xml", new TextEncoder().encode("<svg/>"))).toBe(false);
  });
});
