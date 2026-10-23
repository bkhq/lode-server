export interface VersionCount {
  readonly version: string | null;
  readonly count: number;
}

/** Online instances per reported version, most common first, unknown versions last. */
export function versionCounts(instances: readonly { readonly version: string | null; readonly online: boolean }[]): VersionCount[] {
  const counts = new Map<string | null, number>();
  for (const i of instances) {
    if (i.online)
      counts.set(i.version, (counts.get(i.version) ?? 0) + 1);
  }
  return [...counts]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => Number(a.version === null) - Number(b.version === null) || b.count - a.count);
}
