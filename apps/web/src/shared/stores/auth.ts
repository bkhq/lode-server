import { create } from "zustand";
import { BASE_PATH, http, HttpError, SystemLockedError } from "@/shared/lib/http";

type Role = "admin" | "user";

interface UserGroup {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

interface User {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly email: string;
  readonly avatar?: string;
  readonly role: Role;
  readonly status: string;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly groups: readonly UserGroup[];
}

/**
 * Discriminated outcome of {@link AuthState.fetchUser}. The caller needs
 * to tell "couldn't reach the server" (network / 5xx — show retry) apart
 * from "server says you're not logged in" (clean 401 — redirect to login)
 * apart from "system not ready yet". Returning this instead of probing
 * `/account/me` separately keeps it to a single request per mount.
 */
export type FetchUserResult
  = | { readonly kind: "ok" }
    | { readonly kind: "unauthorized" }
    | { readonly kind: "networkError" }
    | { readonly kind: "systemLocked" };

interface AuthState {
  readonly user: User | null;
  readonly loading: boolean;
  readonly fetchUser: () => Promise<FetchUserResult>;
  readonly logout: () => Promise<void>;
}

interface MeResponse {
  success: boolean;
  data: User;
}

export const useAuthStore = create<AuthState>(set => ({
  user: null,
  loading: true,
  fetchUser: async () => {
    try {
      set({ loading: true });
      const res = await http<MeResponse>("/account/me");
      set({ user: res.data, loading: false });
      return { kind: "ok" };
    }
    catch (err) {
      // Don't clear user on SYSTEM_LOCKED — system just isn't ready yet
      if (err instanceof SystemLockedError) {
        set({ loading: false });
        return { kind: "systemLocked" };
      }
      set({ user: null, loading: false });
      // A clean HTTP failure < 500 (notably 401) means the server
      // answered "not authenticated". Anything else (network failure,
      // 5xx) is "couldn't reach the server" and should offer a retry.
      if (err instanceof HttpError && err.status < 500)
        return { kind: "unauthorized" };
      return { kind: "networkError" };
    }
  },
  logout: async () => {
    try {
      await http("/account/auth/logout", { method: "POST" });
    }
    catch {
      // ignore
    }
    set({ user: null });
    window.location.href = `${BASE_PATH}/login`;
  },
}));
