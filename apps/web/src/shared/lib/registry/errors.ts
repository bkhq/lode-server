import { errorMessage } from "@/shared/lib/errors";
import { HttpError } from "@/shared/lib/http";

/** Registry error codes with a message in the `regerrors` locale namespace. */
export const REGISTRY_ERROR_CODES = [
  "INVALID_PUBLIC_KEY",
  "KEY_EXISTS",
  "PACKAGE_EXISTS",
  "PACKAGE_QUOTA_EXCEEDED",
  "STORAGE_QUOTA_EXCEEDED",
  "ASSET_TOO_LARGE",
  "INVALID_GRANT",
  "VERSION_EXISTS",
  "VERSION_RETIRED",
  "VERSION_NOT_DRAFT",
  "VERSION_EMPTY",
  "VERSION_NOT_PUBLISHED",
  "VERSION_NOT_YANKED",
  "VERSION_IN_CHANNEL",
  "VERSION_BUSY",
  "NAMESPACE_SUSPENDED",
  "SIGNATURE_REQUIRED",
  "INVALID_SIGNATURE",
] as const;

export type RegistryErrorCode = typeof REGISTRY_ERROR_CODES[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(REGISTRY_ERROR_CODES);

/**
 * Resolve a user-facing message for a failed registry call: the localized
 * message of a known registry error code, otherwise whatever `errorMessage`
 * makes of it. `t` must have the `regerrors` namespace available.
 */
export function registryErrorMessage(err: unknown, t: (key: string) => string, fallback: string): string {
  if (err instanceof HttpError && err.code && KNOWN_CODES.has(err.code))
    return t(`regerrors:${err.code}`);
  return errorMessage(err, fallback);
}
