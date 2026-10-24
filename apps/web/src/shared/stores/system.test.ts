import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSystemPollingForTests, useSystemStore } from "./system";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  // Reset store between tests; zustand keeps a singleton across describes.
  useSystemStore.setState({ status: "loading", dbError: null });
  // Clear module-level polling latches (pollSuspended is a process-
  // lifetime latch in prod and would otherwise leak across tests).
  __resetSystemPollingForTests();
});

afterEach(() => {
  useSystemStore.getState().stopPolling();
});

describe("useSystemStore.fetchStatus", () => {
  it("maps initialized=false → uninitialized", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      data: { initialized: false, locked: false, status: "uninitialized" },
    }));
    await useSystemStore.getState().fetchStatus();
    expect(useSystemStore.getState().status).toBe("uninitialized");
    expect(useSystemStore.getState().dbError).toBeNull();
  });

  it("maps initialized=true + locked → locked", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      data: { initialized: true, locked: true, status: "locked" },
    }));
    await useSystemStore.getState().fetchStatus();
    expect(useSystemStore.getState().status).toBe("locked");
  });

  it("maps initialized=true + unlocked → unlocked", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      data: { initialized: true, locked: false, status: "unlocked" },
    }));
    await useSystemStore.getState().fetchStatus();
    expect(useSystemStore.getState().status).toBe("unlocked");
  });

  it("maps status=disabled → unlocked (encryption-off mode)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      data: { initialized: true, locked: false, status: "disabled" },
    }));
    await useSystemStore.getState().fetchStatus();
    expect(useSystemStore.getState().status).toBe("unlocked");
  });

  it("captures dbError as a separate state", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      data: {
        initialized: true,
        locked: false,
        status: "unlocked",
        dbError: "disk full",
      },
    }));
    await useSystemStore.getState().fetchStatus();
    expect(useSystemStore.getState().status).toBe("db-error");
    expect(useSystemStore.getState().dbError).toBe("disk full");
  });

  it("falls into error on non-2xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 500 }));
    await useSystemStore.getState().fetchStatus();
    expect(useSystemStore.getState().status).toBe("error");
  });

  it("falls into error on network rejection", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await useSystemStore.getState().fetchStatus();
    expect(useSystemStore.getState().status).toBe("error");
  });

  it("falls into error on success:false envelope", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, data: null }));
    await useSystemStore.getState().fetchStatus();
    expect(useSystemStore.getState().status).toBe("error");
  });
});

describe("useSystemStore polling", () => {
  it("startPolling is idempotent — calling twice does not stack timers", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(jsonResponse({
        success: true,
        data: { initialized: true, locked: false, status: "unlocked" },
      }));
      const store = useSystemStore.getState();
      store.startPolling();
      store.startPolling();
      // Advance just past one poll interval.
      vi.advanceTimersByTime(31_000);
      // Drain any microtasks from awaited fetches.
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it("suspends polling after observing the disabled (encryption-off) state", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(jsonResponse({
        success: true,
        data: { initialized: true, locked: false, status: "disabled" },
      }));
      const store = useSystemStore.getState();
      store.startPolling();
      // Resolve the first poll → status is disabled, polling self-suspends.
      await vi.advanceTimersByTimeAsync(31_000);
      const callsAfterFirst = fetchMock.mock.calls.length;
      // No further polls regardless of how much time passes.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    }
    finally {
      vi.useRealTimers();
    }
  });

  it("stopPolling halts further fetches", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(jsonResponse({
        success: true,
        data: { initialized: true, locked: false, status: "unlocked" },
      }));
      const store = useSystemStore.getState();
      store.startPolling();
      store.stopPolling();
      vi.advanceTimersByTime(60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(0);
    }
    finally {
      vi.useRealTimers();
    }
  });
});

describe("useSystemStore homePage", () => {
  const status = (extra: Record<string, unknown>) => jsonResponse({
    success: true,
    data: {
      initialized: true,
      locked: false,
      status: "unlocked",
      ...extra,
    },
  });

  it("is read from the status response and falls back to off", async () => {
    useSystemStore.setState({ homePage: "off" });
    fetchMock.mockResolvedValueOnce(status({ homePage: "root" }));
    await useSystemStore.getState().fetchStatus();
    expect(useSystemStore.getState().homePage).toBe("root");

    fetchMock.mockResolvedValueOnce(status({}));
    await useSystemStore.getState().fetchStatus();
    expect(useSystemStore.getState().homePage).toBe("off");
  });
});
