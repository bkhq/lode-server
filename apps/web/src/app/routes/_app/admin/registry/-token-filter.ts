import { useRouterState } from "@tanstack/react-router";

// The tokens tab keeps the chosen user in the `user_id` search parameter.
// Its route declares no search schema, so both ends go through a cast.

/** The `search` of a link to the tokens tab narrowed to one user. */
export function tokenUserSearch(userId: string): never {
  return { user_id: userId } as never;
}

/** The user the tokens tab is narrowed to, if any. */
export function useTokenUserFilter(): string | undefined {
  return useRouterState({
    select: (s) => {
      const value = (s.location.search as Record<string, unknown>).user_id;
      // The router parses a bare numeric parameter into a number.
      if (typeof value === "number")
        return String(value);
      return typeof value === "string" && value ? value : undefined;
    },
  });
}
