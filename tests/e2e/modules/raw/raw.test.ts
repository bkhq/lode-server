import { describe, expect, it } from "bun:test";
import { API_BASE } from "../../lib/api";

// Plain fetch, not ApiClient: the client adds the Origin header the `/api`
// CSRF guard wants, and a service integrating with the raw API sends no such
// thing. This is how an outside caller actually arrives.
async function call(path: string): Promise<Response> {
  return await fetch(`${API_BASE}${path}`);
}

const BROWSER_SECURITY_HEADERS = [
  "content-security-policy",
  "x-frame-options",
  "cross-origin-resource-policy",
  "cross-origin-opener-policy",
  "strict-transport-security",
];

describe("/api/raw (live, encrypted, unlocked)", () => {
  it("answers health as JSON without browser security headers", async () => {
    const res = await call("/api/raw/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok" });
    for (const header of BROWSER_SECURITY_HEADERS)
      expect(res.headers.get(header)).toBeNull();
  });

  it("keeps the security headers on the rest of /api", async () => {
    const res = await call("/api/health");
    expect(res.headers.get("content-security-policy")).not.toBeNull();
  });

  it("answers an unknown path with a JSON 404", async () => {
    const res = await call("/api/raw/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("echoes a request id", async () => {
    const res = await call("/api/raw/health");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});
