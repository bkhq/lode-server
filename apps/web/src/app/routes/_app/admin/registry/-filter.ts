/** Case-insensitive substring match of `query` against any of `fields`; a blank query matches everything. */
export function matchesFilter(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle)
    return true;
  return fields.some(field => field != null && field.toLowerCase().includes(needle));
}

export function filterRows<T>(
  rows: readonly T[],
  query: string,
  fields: (row: T) => readonly (string | null | undefined)[],
): T[] {
  return rows.filter(row => matchesFilter(query, fields(row)));
}
