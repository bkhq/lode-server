import { describe, expect, it } from "vitest";
import { formatBytes, usagePercent } from "./format";

describe("formatBytes", () => {
  it("renders zero as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("treats negative and non-finite input as zero", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("keeps bytes and KiB whole", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("2 KiB");
  });

  it("uses one decimal from MiB up", () => {
    expect(formatBytes(1024 ** 2)).toBe("1.0 MiB");
    expect(formatBytes(1.5 * 1024 ** 2)).toBe("1.5 MiB");
    expect(formatBytes(500 * 1024 ** 2)).toBe("500.0 MiB");
    expect(formatBytes(10 * 1024 ** 3)).toBe("10.0 GiB");
  });

  it("moves to the next unit when rounding reaches 1024", () => {
    expect(formatBytes(1024 ** 2 - 1)).toBe("1.0 MiB");
    expect(formatBytes(1024 ** 3 - 1)).toBe("1.0 GiB");
  });

  it("stays in GiB above a terabyte", () => {
    expect(formatBytes(2048 * 1024 ** 3)).toBe("2048.0 GiB");
  });
});

describe("usagePercent", () => {
  it("is the share of the limit in use", () => {
    expect(usagePercent(25, 100)).toBe(25);
    expect(usagePercent(1, 3)).toBeCloseTo(33.333, 2);
  });

  it("is 0 when the limit is 0", () => {
    expect(usagePercent(0, 0)).toBe(0);
    expect(usagePercent(10, 0)).toBe(0);
  });

  it("clamps to 0..100", () => {
    expect(usagePercent(150, 100)).toBe(100);
    expect(usagePercent(-5, 100)).toBe(0);
  });
});
