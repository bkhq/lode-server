import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { registryKeys } from "@/shared/lib/registry/queries";

/**
 * Refetch what a change to a package can touch: `packages()` covers the
 * list, every package and its versions; storage and package counts move the
 * quota; the administrator's package list carries the same rows.
 */
export function useInvalidatePackages(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: registryKeys.packages() }),
      queryClient.invalidateQueries({ queryKey: registryKeys.quota() }),
      queryClient.invalidateQueries({ queryKey: registryKeys.adminPackages() }),
    ]);
  }, [queryClient]);
}
