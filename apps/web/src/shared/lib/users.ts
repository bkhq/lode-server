/**
 * Resolves a user id to its display name via the given lookup map,
 * falling back to the id itself when the user isn't present. Mirrors
 * the repeated `userMap.get(id)?.name ?? id` pattern.
 */
export function displayName<T extends { readonly name: string }>(
  users: Map<string, T>,
  id: string,
): string {
  return users.get(id)?.name ?? id;
}
