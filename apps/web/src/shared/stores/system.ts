import type { HomePageMode } from "@/shared/lib/home";
import { create } from "zustand";
import { http } from "@/shared/lib/http";

export type SystemStatus = "loading" | "uninitialized" | "locked" | "unlocked" | "db-error" | "error";

const POLL_INTERVAL = 30_000;

interface SystemState {
  readonly status: SystemStatus;
  readonly dbError: string | null;
  readonly homePage: HomePageMode;
  readonly fetchStatus: () => Promise<void>;
  readonly startPolling: () => void;
  readonly stopPolling: () => void;
}

interface StatusResponse {
  success: boolean;
  data: { initialized: boolean; locked: boolean; status: string; dbError?: string | null; homePage?: HomePageMode };
}

// Reference-counted polling. React 19 StrictMode mounts → unmounts → mounts
// the root once in dev, and the previous module-global `pollTimer` got
// stopped by the cleanup function while a second mount was already running
// — leaving the app un-polled in production after route churn. Refcount
// the subscribers so the timer is alive iff at least one consumer still
// wants updates, and idempotent across nested mounts.
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRefCount = 0;
// `disabled` (DB_ENCRYPTION=false) is fixed for the whole process lifetime,
// so once we observe it the status can never change — keep polling off for
// the rest of the session instead of re-asking every 30s.
let pollSuspended = false;

export const useSystemStore = create<SystemState>((set, get) => ({
  status: "loading",
  dbError: null,
  homePage: "off",
  fetchStatus: async () => {
    try {
      const json = await http<StatusResponse>("/encryption/status");
      if (!json.success || !json.data) {
        set({ status: "error", dbError: null });
        return;
      }

      set({ homePage: json.data.homePage ?? "off" });

      if (json.data.dbError) {
        set({ status: "db-error", dbError: json.data.dbError });
        return;
      }

      if (json.data.status === "disabled") {
        set({ status: "unlocked", dbError: null });
        pollSuspended = true;
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }
      else {
        // Explicit status change away from `disabled` — the only place
        // the process-lifetime suspend latch is ever cleared. In practice
        // `disabled` is fixed for the session so this never flips back,
        // but keeping the invariant explicit makes the semantics provable
        // ("polling is suspended iff the last observed status was
        // disabled") rather than an emergent side effect of refcounting.
        pollSuspended = false;
        if (!json.data.initialized) {
          set({ status: "uninitialized", dbError: null });
        }
        else if (json.data.locked) {
          set({ status: "locked", dbError: null });
        }
        else {
          set({ status: "unlocked", dbError: null });
        }
      }
    }
    catch {
      set({ status: "error", dbError: null });
    }
  },
  startPolling: () => {
    pollRefCount += 1;
    if (pollSuspended || pollTimer)
      return;
    pollTimer = setInterval(() => void get().fetchStatus(), POLL_INTERVAL);
  },
  stopPolling: () => {
    if (pollRefCount > 0)
      pollRefCount -= 1;
    // NOTE: deliberately do NOT reset `pollSuspended` here. It is a
    // process-lifetime latch (set once `disabled` is observed). Clearing
    // it at refcount 0 made a disabled deployment resume polling
    // `/encryption/status` after the only consumer unmounted/remounted
    // (StrictMode / route churn). It is only ever cleared on an explicit
    // status change away from `disabled` (see `fetchStatus`).
    if (pollRefCount === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
}));

/**
 * Test-only: clear the module-level polling latches. `pollSuspended` is a
 * deliberate process-lifetime latch in production (see `stopPolling`), so
 * it does not self-reset between tests the way it did before — vitest
 * shares module state across a file, so a prior `disabled`-status test
 * would otherwise leak the suspend latch into later tests.
 */
export function __resetSystemPollingForTests(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollRefCount = 0;
  pollSuspended = false;
}
