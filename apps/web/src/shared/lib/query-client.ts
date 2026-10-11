import { QueryClient } from "@tanstack/react-query";
import { HttpError } from "./http";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: "always",
      // Skip retries on client-error responses (401/403/404/422 etc). The
      // first 401 already triggers redirectToLogin via the http event bus;
      // a second attempt just wastes a round-trip and races the redirect.
      retry: (count, err) => {
        if (err instanceof HttpError && err.status >= 400 && err.status < 500)
          return false;
        return count < 1;
      },
    },
    mutations: {
      retry: (count, err) => {
        if (err instanceof HttpError && err.status >= 400 && err.status < 500)
          return false;
        return count < 1;
      },
    },
  },
});
