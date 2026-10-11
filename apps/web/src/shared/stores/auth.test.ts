import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemLockedError } from "@/shared/lib/http";

// Hoisted mock — must be set before importing the store so the module
// captures our stub instead of the real implementation.
const httpMock = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>();

vi.mock("@/shared/lib/http", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    BASE_PATH: "/app",
    http: (path: string, init?: RequestInit) => httpMock(path, init),
  };
});

const { useAuthStore } = await import("./auth");

const sampleUser = {
  id: "u_1",
  username: "alice",
  name: "Alice",
  email: "alice@example.com",
  role: "admin" as const,
  status: "active",
  lastLoginAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  groups: [],
};

beforeEach(() => {
  httpMock.mockReset();
  // Re-init store to a clean slate: explicit set then rely on store's
  // existing actions. zustand keeps a singleton across the test file.
  useAuthStore.setState({ user: null, loading: true });
});

describe("useAuthStore.fetchUser", () => {
  it("populates user and clears loading on 2xx", async () => {
    httpMock.mockResolvedValue({ success: true, data: sampleUser });
    await useAuthStore.getState().fetchUser();
    const state = useAuthStore.getState();
    expect(state.user?.id).toBe("u_1");
    expect(state.loading).toBe(false);
  });

  it("clears user and loading on generic failure", async () => {
    useAuthStore.setState({ user: sampleUser, loading: false });
    httpMock.mockRejectedValue(new Error("boom"));
    await useAuthStore.getState().fetchUser();
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("preserves existing user on SystemLockedError (system not ready)", async () => {
    useAuthStore.setState({ user: sampleUser, loading: true });
    httpMock.mockRejectedValue(new SystemLockedError());
    await useAuthStore.getState().fetchUser();
    const state = useAuthStore.getState();
    expect(state.user?.id).toBe("u_1");
    expect(state.loading).toBe(false);
  });
});

describe("useAuthStore.logout", () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = globalThis.window?.location ?? ({} as Location);
    Object.defineProperty(globalThis, "window", {
      value: { location: { href: "" } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: { location: originalLocation },
      writable: true,
      configurable: true,
    });
  });

  it("clears user and redirects to BASE_PATH/login", async () => {
    useAuthStore.setState({ user: sampleUser, loading: false });
    httpMock.mockResolvedValue({ success: true });
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();
    expect(globalThis.window.location.href).toBe("/app/login");
  });

  it("still clears user and redirects when logout endpoint throws", async () => {
    useAuthStore.setState({ user: sampleUser, loading: false });
    httpMock.mockRejectedValue(new Error("network"));
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();
    expect(globalThis.window.location.href).toBe("/app/login");
  });
});
