// Pure logic of the token grant editor: the form state, its conversion to
// and from the wire `Grants`, and the expiry presets.

import type { GrantLevel, Grants, PackageGrant, RegistryPackage } from "@/shared/lib/registry/types";
import { isAllGrant } from "@/shared/lib/registry/grants";

export type RowLevel = GrantLevel | "none";

/** `perPackage` is keyed by `<namespace>/<slug>`; a missing key reads as "none". */
export interface GrantFormState {
  readonly all: boolean;
  readonly allLevel: GrantLevel;
  readonly perPackage: Readonly<Record<string, RowLevel>>;
}

type PackageRef = Pick<RegistryPackage, "namespace" | "slug">;

export function packageKey(pkg: PackageRef): string {
  return `${pkg.namespace}/${pkg.slug}`;
}

export function emptyGrantForm(): GrantFormState {
  return { all: false, allLevel: "read", perPackage: {} };
}

/** The all-packages switch wins over the rows; "none" rows are left out. */
export function toWire(state: GrantFormState): Grants {
  if (state.all)
    return { all: state.allLevel };
  const grants: PackageGrant[] = [];
  for (const [pkg, access] of Object.entries(state.perPackage)) {
    if (access !== "none")
      grants.push({ package: pkg, access });
  }
  return grants;
}

/** One row per owned package; a grant naming any other package is dropped. */
export function fromWire(grants: Grants, ownedPackages: readonly PackageRef[]): GrantFormState {
  const all = isAllGrant(grants);
  const granted = new Map(all ? [] : grants.map(g => [g.package, g.access]));
  const perPackage: Record<string, RowLevel> = {};
  for (const pkg of ownedPackages) {
    const key = packageKey(pkg);
    perPackage[key] = granted.get(key) ?? "none";
  }
  return { all, allLevel: all ? grants.all : "read", perPackage };
}

/** True when the token would reach no package. */
export function isEmpty(state: GrantFormState): boolean {
  return !state.all && Object.values(state.perPackage).every(level => level === "none");
}

export const EXPIRY_PRESETS = ["30d", "90d", "365d", "never"] as const;

export type ExpiryPreset = typeof EXPIRY_PRESETS[number];

const DAY_MS = 24 * 60 * 60 * 1000;

const EXPIRY_DAYS: Readonly<Record<ExpiryPreset, number | null>> = {
  "30d": 30,
  "90d": 90,
  "365d": 365,
  "never": null,
};

/** The `expires_at` of a create request: ISO 8601 with an offset, or null for no expiry. */
export function expiresAt(preset: ExpiryPreset, now: Date): string | null {
  const days = EXPIRY_DAYS[preset];
  return days === null ? null : new Date(now.getTime() + days * DAY_MS).toISOString();
}

export function isExpired(expiresAt: string | null, now: number): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= now;
}
