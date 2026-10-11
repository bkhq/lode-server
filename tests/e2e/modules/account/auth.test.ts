import { describe, expect, it } from "bun:test";
import { ApiClient } from "../../lib/api";
import { loginAs } from "../../lib/oidc";

describe("auth flow (live API + dex)", () => {
  it("/api/health returns 200 ok", async () => {
    const c = new ApiClient();
    const res = await c.json<{ status: string }>("/api/health");
    expect(res.status).toBe("ok");
  });

  it("/api/account/me returns 401 without a session", async () => {
    const c = new ApiClient();
    const res = await c.raw("/api/account/me");
    expect(res.status).toBe(401);
  });

  it("login as admin@example.com sets session cookie and /me returns the admin user", async () => {
    const c = await loginAs("admin@example.com", "admin");
    expect(c.cookies.has("session_id")).toBe(true);

    const me = await c.json<{ data: { email: string; role: string; name: string } }>("/api/account/me");
    expect(me.data.email).toBe("admin@example.com");
    // DEFAULT_ADMIN matches → first matching login is promoted to admin.
    expect(me.data.role).toBe("admin");
  });

  it("login as user@example.com creates a regular user (not admin)", async () => {
    const c = await loginAs("user@example.com", "admin");
    const me = await c.json<{ data: { email: string; role: string } }>("/api/account/me");
    expect(me.data.email).toBe("user@example.com");
    expect(me.data.role).toBe("user");
  });

  it("logout clears the session cookie", async () => {
    const c = await loginAs("admin@example.com", "admin");
    expect(c.cookies.has("session_id")).toBe(true);

    const res = await c.raw("/api/account/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    // Subsequent /me must 401 again.
    const me = await c.raw("/api/account/me");
    expect(me.status).toBe(401);
  });
});
