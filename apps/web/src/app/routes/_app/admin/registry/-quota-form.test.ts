import type { QuotaFormValues } from "./-quota-form";
import { describe, expect, it } from "vitest";
import { fromOverride, MAX_ASSET_BYTES_CEILING, toOverride } from "./-quota-form";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function form(patch: Partial<QuotaFormValues> = {}): QuotaFormValues {
  return {
    maxPackages: "",
    maxStorage: { value: "", unit: "GiB" },
    maxAsset: { value: "", unit: "MiB" },
    ...patch,
  };
}

describe("toOverride", () => {
  it("turns empty fields into null (platform default)", () => {
    expect(toOverride(form())).toEqual({
      ok: true,
      override: { max_packages: null, max_storage_bytes: null, max_asset_bytes: null },
    });
  });

  it("treats whitespace as empty", () => {
    expect(toOverride(form({ maxPackages: "  ", maxStorage: { value: " ", unit: "MiB" } }))).toEqual({
      ok: true,
      override: { max_packages: null, max_storage_bytes: null, max_asset_bytes: null },
    });
  });

  it("converts units to bytes", () => {
    expect(toOverride(form({
      maxPackages: "25",
      maxStorage: { value: "3", unit: "GiB" },
      maxAsset: { value: "200", unit: "MiB" },
    }))).toEqual({
      ok: true,
      override: { max_packages: 25, max_storage_bytes: 3 * GIB, max_asset_bytes: 200 * MIB },
    });
  });

  it("passes a byte count through unchanged", () => {
    expect(toOverride(form({ maxStorage: { value: "1000", unit: "B" } }))).toMatchObject({
      ok: true,
      override: { max_storage_bytes: 1000 },
    });
  });

  it("accepts zero packages and zero storage", () => {
    expect(toOverride(form({ maxPackages: "0", maxStorage: { value: "0", unit: "MiB" } }))).toMatchObject({
      ok: true,
      override: { max_packages: 0, max_storage_bytes: 0 },
    });
  });

  it("rejects negatives", () => {
    expect(toOverride(form({
      maxPackages: "-1",
      maxStorage: { value: "-2", unit: "GiB" },
      maxAsset: { value: "-3", unit: "MiB" },
    }))).toEqual({
      ok: false,
      errors: { maxPackages: "invalid", maxStorage: "invalid", maxAsset: "invalid" },
    });
  });

  it("rejects non-integers and non-numbers", () => {
    expect(toOverride(form({ maxPackages: "1.5" }))).toEqual({ ok: false, errors: { maxPackages: "invalid" } });
    expect(toOverride(form({ maxStorage: { value: "0.5", unit: "GiB" } }))).toEqual({ ok: false, errors: { maxStorage: "invalid" } });
    expect(toOverride(form({ maxAsset: { value: "abc", unit: "MiB" } }))).toEqual({ ok: false, errors: { maxAsset: "invalid" } });
    expect(toOverride(form({ maxPackages: "1e3" }))).toEqual({ ok: false, errors: { maxPackages: "invalid" } });
  });

  it("rejects a value too large to send exactly", () => {
    expect(toOverride(form({ maxStorage: { value: "99999999999", unit: "GiB" } }))).toEqual({
      ok: false,
      errors: { maxStorage: "invalid" },
    });
  });

  it("rejects a zero asset limit", () => {
    expect(toOverride(form({ maxAsset: { value: "0", unit: "MiB" } }))).toEqual({ ok: false, errors: { maxAsset: "invalid" } });
  });

  it("accepts an asset limit at the ceiling and rejects one above it", () => {
    expect(toOverride(form({ maxAsset: { value: "500", unit: "MiB" } }))).toMatchObject({
      ok: true,
      override: { max_asset_bytes: MAX_ASSET_BYTES_CEILING },
    });
    expect(toOverride(form({ maxAsset: { value: "501", unit: "MiB" } }))).toEqual({ ok: false, errors: { maxAsset: "assetTooLarge" } });
    expect(toOverride(form({ maxAsset: { value: "1", unit: "GiB" } }))).toEqual({ ok: false, errors: { maxAsset: "assetTooLarge" } });
  });

  it("reports only the fields that are wrong", () => {
    expect(toOverride(form({ maxPackages: "10", maxStorage: { value: "x", unit: "GiB" } }))).toEqual({
      ok: false,
      errors: { maxStorage: "invalid" },
    });
  });
});

describe("fromOverride", () => {
  it("leaves fields empty for null limits, with the default units", () => {
    expect(fromOverride({ max_packages: null, max_storage_bytes: null, max_asset_bytes: null })).toEqual(form());
  });

  it("picks the largest unit that divides evenly", () => {
    expect(fromOverride({ max_packages: 7, max_storage_bytes: 2 * GIB, max_asset_bytes: 300 * MIB })).toEqual({
      maxPackages: "7",
      maxStorage: { value: "2", unit: "GiB" },
      maxAsset: { value: "300", unit: "MiB" },
    });
    expect(fromOverride({ max_packages: null, max_storage_bytes: 1536 * MIB, max_asset_bytes: null }).maxStorage)
      .toEqual({ value: "1536", unit: "MiB" });
  });

  it("falls back to bytes when no unit divides evenly", () => {
    expect(fromOverride({ max_packages: null, max_storage_bytes: MIB + 1, max_asset_bytes: null }).maxStorage)
      .toEqual({ value: String(MIB + 1), unit: "B" });
  });

  it("keeps a zero limit as zero, not as empty", () => {
    const values = fromOverride({ max_packages: 0, max_storage_bytes: 0, max_asset_bytes: null });
    expect(values.maxPackages).toBe("0");
    expect(values.maxStorage).toEqual({ value: "0", unit: "GiB" });
  });

  it("round-trips through toOverride", () => {
    const override = { max_packages: 3, max_storage_bytes: 5 * GIB, max_asset_bytes: 64 * MIB };
    expect(toOverride(fromOverride(override))).toEqual({ ok: true, override });
  });
});
