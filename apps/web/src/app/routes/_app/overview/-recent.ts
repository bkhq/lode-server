import type { RegistryPackage, Version } from "@/shared/lib/registry/types";

// The registry has no cross-package version feed, so the overview loads the
// version list of the most recently updated packages and merges them here.

export interface PackageVersions {
  readonly package: RegistryPackage;
  readonly versions: readonly Version[];
}

/** `at` is the instant the entry is ordered by: `published_at`, else `created_at`. */
export interface RecentVersion {
  readonly package: RegistryPackage;
  readonly version: Version;
  readonly at: string;
}

// Unparseable timestamps sort last. `Array.prototype.sort` is stable, so
// equal instants keep their input order.
function newestFirst(a: string, b: string): number {
  return (Date.parse(b) || 0) - (Date.parse(a) || 0);
}

/** The `n` most recently updated packages, newest first. */
export function pickRecentPackages(packages: readonly RegistryPackage[], n: number): RegistryPackage[] {
  return [...packages].sort((a, b) => newestFirst(a.updated_at, b.updated_at)).slice(0, Math.max(0, n));
}

/** The `n` newest versions across `entries`, newest first. */
export function recentVersions(entries: readonly PackageVersions[], n: number): RecentVersion[] {
  return entries
    .flatMap(entry => entry.versions.map((version): RecentVersion => ({
      package: entry.package,
      version,
      at: version.published_at ?? version.created_at,
    })))
    .sort((a, b) => newestFirst(a.at, b.at))
    .slice(0, Math.max(0, n));
}
