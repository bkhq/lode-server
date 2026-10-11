import type { Asset, Channel, Version } from "@/shared/lib/registry/types";

// Client-side mirror of the server's rules in
// `apps/api/src/modules/registry/validate.ts`, for live feedback in the
// forms. The server stays the authority.

/** Why a value was refused; the `package:validation.*` locale keys spell each one out. */
export type IdError = "empty" | "leading" | "charset" | "tooLong";

export const MAX_ID_LENGTH = 128;
export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_NOTES_LENGTH = 20000;

// lode's id rule: `[A-Za-z0-9._-]`, not starting with `.` or `-`. `\w` is
// ASCII-only without the `u` / `v` flag.
const RE_ID = /^\w[\w.-]*$/;

function idError(id: string): IdError | undefined {
  if (id === "")
    return "empty";
  if (id.startsWith(".") || id.startsWith("-"))
    return "leading";
  if (!RE_ID.test(id))
    return "charset";
  if (id.length > MAX_ID_LENGTH)
    return "tooLong";
  return undefined;
}

/** Why `version` cannot be a version id, or undefined when it can. */
export function versionError(version: string): IdError | undefined {
  return idError(version);
}

/** Why `name` cannot be a channel name, or undefined when it can. A channel follows the same id rule. */
export function channelNameError(name: string): IdError | undefined {
  return idError(name);
}

/** Why `name` cannot be a display name (1..100 characters once trimmed), or undefined when it can. */
export function displayNameError(name: string): "empty" | "tooLong" | undefined {
  const length = Array.from(name.trim()).length;
  if (length === 0)
    return "empty";
  if (length > MAX_DISPLAY_NAME_LENGTH)
    return "tooLong";
  return undefined;
}

/** The versions a channel may point at. */
export function publishedVersions(versions: readonly Version[]): Version[] {
  return versions.filter(v => v.status === "published");
}

/** Names of the channels pointing at `version`. */
export function channelsOf(version: string, channels: readonly Channel[]): string[] {
  return channels.filter(c => c.version === version).map(c => c.name);
}

export function totalSize(assets: readonly Asset[]): number {
  return assets.reduce((sum, a) => sum + a.size, 0);
}

export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}
