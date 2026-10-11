import type { GrantLevel, Grants, PackageGrant } from "./types";

/** Weakest to strongest: each level includes the ones before it. */
export const GRANT_LEVELS = ["read", "write", "admin"] as const satisfies readonly GrantLevel[];

export type GrantSummary
  = | { readonly kind: "none" }
    | { readonly kind: "all"; readonly access: GrantLevel }
    | { readonly kind: "packages"; readonly items: readonly PackageGrant[] };

export function isAllGrant(grants: Grants): grants is { readonly all: GrantLevel } {
  return !Array.isArray(grants);
}

/** Number of grants a token carries: the all-packages grant is one, 0 means the token reaches no package. */
export function grantCount(grants: Grants): number {
  return isAllGrant(grants) ? 1 : grants.length;
}

export function describeGrants(grants: Grants): GrantSummary {
  if (isAllGrant(grants))
    return { kind: "all", access: grants.all };
  if (grants.length === 0)
    return { kind: "none" };
  return { kind: "packages", items: grants };
}
