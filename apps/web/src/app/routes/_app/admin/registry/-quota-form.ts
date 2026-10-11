import type { QuotaOverride } from "@/shared/lib/registry/types";

/** Largest per-asset limit the server accepts for an override. */
export const MAX_ASSET_BYTES_CEILING = 500 * 1024 * 1024;

const UNIT_BYTES = { B: 1, MiB: 1024 ** 2, GiB: 1024 ** 3 } as const;

/** `B` is not offered for input: it only shows a stored limit no larger unit divides evenly. */
export type SizeUnit = keyof typeof UNIT_BYTES;

export interface SizeValue {
  readonly value: string;
  readonly unit: SizeUnit;
}

/** The override as typed into the form: an empty value means "platform default". */
export interface QuotaFormValues {
  readonly maxPackages: string;
  readonly maxStorage: SizeValue;
  readonly maxAsset: SizeValue;
}

export type QuotaFormError = "invalid" | "assetTooLarge";

export type QuotaFormErrors = Partial<Record<keyof QuotaFormValues, QuotaFormError>>;

export type ToOverrideResult
  = | { readonly ok: true; readonly override: QuotaOverride }
    | { readonly ok: false; readonly errors: QuotaFormErrors };

const RE_DIGITS = /^\d+$/;

/** A non-negative whole number times `factor`: null when empty, undefined when it is not one. */
function parseLimit(raw: string, factor = 1): number | null | undefined {
  const text = raw.trim();
  if (!text)
    return null;
  if (!RE_DIGITS.test(text))
    return undefined;
  const n = Number(text) * factor;
  return Number.isSafeInteger(n) ? n : undefined;
}

export function toOverride(form: QuotaFormValues): ToOverrideResult {
  const packages = parseLimit(form.maxPackages);
  const storage = parseLimit(form.maxStorage.value, UNIT_BYTES[form.maxStorage.unit]);
  const asset = parseLimit(form.maxAsset.value, UNIT_BYTES[form.maxAsset.unit]);

  const errors: QuotaFormErrors = {
    ...(packages === undefined ? { maxPackages: "invalid" } : {}),
    ...(storage === undefined ? { maxStorage: "invalid" } : {}),
    // The asset limit has to be positive: no asset fits under a limit of zero.
    ...(asset === undefined || asset === 0
      ? { maxAsset: "invalid" }
      : asset !== null && asset > MAX_ASSET_BYTES_CEILING ? { maxAsset: "assetTooLarge" } : {}),
  };
  if (packages === undefined || storage === undefined || asset === undefined || Object.keys(errors).length > 0)
    return { ok: false, errors };

  return { ok: true, override: { max_packages: packages, max_storage_bytes: storage, max_asset_bytes: asset } };
}

function fromBytes(bytes: number | null, fallback: SizeUnit): SizeValue {
  if (bytes === null)
    return { value: "", unit: fallback };
  if (bytes === 0)
    return { value: "0", unit: fallback };
  const unit = (["GiB", "MiB"] as const).find(u => bytes % UNIT_BYTES[u] === 0) ?? "B";
  return { value: String(bytes / UNIT_BYTES[unit]), unit };
}

export function fromOverride(override: QuotaOverride): QuotaFormValues {
  return {
    maxPackages: override.max_packages === null ? "" : String(override.max_packages),
    maxStorage: fromBytes(override.max_storage_bytes, "GiB"),
    maxAsset: fromBytes(override.max_asset_bytes, "MiB"),
  };
}
