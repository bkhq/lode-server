import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpError, onHttpEvent, SystemLockedError } from "./http";

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
});

afterEach(() => {
  fetchMock.mockReset();
});

describe("http()", () => {
  describe("csrf header injection", () => {
    it("injects X-Requested-With on mutating methods", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await http("/foo", { method: "POST", body: JSON.stringify({}) });
      const init = fetchMock.mock.calls[0]![1]!;
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("does not inject X-Requested-With on GET", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await http("/foo");
      const init = fetchMock.mock.calls[0]![1]!;
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Requested-With"]).toBeUndefined();
    });

    it("does not set Content-Type when body is FormData", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await http("/foo", { method: "POST", body: new FormData() });
      const init = fetchMock.mock.calls[0]![1]!;
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBeUndefined();
      expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
    });

    it("preserves caller-provided headers", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      await http("/foo", { method: "POST", headers: { "X-Custom": "hello" } });
      const init = fetchMock.mock.calls[0]![1]!;
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Custom"]).toBe("hello");
      expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
    });
  });

  describe("error handling", () => {
    it("returns parsed JSON on 2xx", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { id: "abc" } }));
      const result = await http<{ data: { id: string } }>("/foo");
      expect(result.data.id).toBe("abc");
    });

    it("emits 'unauthorized' and throws HttpError on 401", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
      const events: string[] = [];
      const off = onHttpEvent(t => events.push(t));
      try {
        await expect(http("/foo")).rejects.toThrow(HttpError);
        expect(events).toContain("unauthorized");
      }
      finally {
        off();
      }
    });

    it("throws SystemLockedError when error.code === SYSTEM_LOCKED", async () => {
      fetchMock.mockResolvedValue(jsonResponse(
        { error: { code: "SYSTEM_LOCKED", message: "locked" } },
        { status: 503 },
      ));
      const events: string[] = [];
      const off = onHttpEvent(t => events.push(t));
      try {
        await expect(http("/foo")).rejects.toThrow(SystemLockedError);
        expect(events).toContain("system-locked");
      }
      finally {
        off();
      }
    });

    it("propagates server error.code through HttpError.code", async () => {
      fetchMock.mockResolvedValue(jsonResponse(
        { error: { code: "VALIDATION_ERROR", message: "bad" } },
        { status: 422 },
      ));
      try {
        await http("/foo");
        expect.unreachable("should have thrown");
      }
      catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        const e = err as HttpError;
        expect(e.status).toBe(422);
        expect(e.code).toBe("VALIDATION_ERROR");
        expect(e.message).toBe("bad");
      }
    });

    it("falls back to status-derived message when body is malformed", async () => {
      fetchMock.mockResolvedValue(new Response("not json", { status: 500 }));
      try {
        await http("/foo");
        expect.unreachable("should have thrown");
      }
      catch (err) {
        const e = err as HttpError;
        expect(e.status).toBe(500);
        expect(e.message).toBe("HTTP 500");
      }
    });
  });

  describe("listener cleanup", () => {
    it("onHttpEvent returns an unsubscribe that detaches the listener", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, { status: 401 }));
      const seen: string[] = [];
      const off = onHttpEvent(t => seen.push(t));
      off();
      await expect(http("/foo")).rejects.toThrow(HttpError);
      expect(seen).toEqual([]);
    });
  });
});
