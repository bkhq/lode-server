import { describe, expect, it } from "bun:test";
import { ApiClient } from "../../lib/api";
import { getClient } from "../../lib/oidc";

interface User {
  id: string;
  email: string;
  username: string;
  name: string;
  role: "admin" | "user";
  status: "active" | "disabled";
}

describe("/api/account/users", () => {
  it("admin can list users; user list grows after a second login", async () => {
    // First admin login bootstraps the admin account.
    const admin = await getClient("admin@example.com", "admin");
    const before = await admin.json<{ data: User[]; meta: { total: number } }>("/api/account/users");
    expect(before.meta.total).toBeGreaterThanOrEqual(1);

    // Logging in a second user via OIDC adds them to the directory.
    await getClient("user@example.com", "admin");

    const after = await admin.json<{ data: User[]; meta: { total: number } }>("/api/account/users");
    expect(after.meta.total).toBeGreaterThanOrEqual(2);
    const emails = after.data.map(u => u.email);
    expect(emails).toContain("admin@example.com");
    expect(emails).toContain("user@example.com");
  });

  it("non-admin cannot list users (403)", async () => {
    const user = await getClient("user@example.com", "admin");
    const res = await user.raw("/api/account/users");
    expect(res.status).toBe(403);
  });

  it("authenticated non-admin can hit /account/visible-users (assignment picker)", async () => {
    const user = await getClient("user@example.com", "admin");
    const res = await user.json<{ data: { id: string; name: string }[] }>("/api/account/visible-users");
    expect(Array.isArray(res.data)).toBe(true);
  });

  it("admin can update a user's status", async () => {
    const admin = await getClient("admin@example.com", "admin");
    const list = await admin.json<{ data: User[] }>("/api/account/users");
    const target = list.data.find(u => u.role === "user");
    if (!target)
      throw new Error("expected at least one regular user; run the user-list test first");

    const res = await admin.json<{ data: { status: string } }>(`/api/account/users/${target.id}`, {
      method: "PATCH",
      body: { status: "disabled" },
    });
    expect(res.data.status).toBe("disabled");

    // Restore to leave the suite in a sane state for downstream tests.
    await admin.json(`/api/account/users/${target.id}`, {
      method: "PATCH",
      body: { status: "active" },
    });
  });

  it("/api/account/me reflects the OIDC profile (name/username/email)", async () => {
    const c = await getClient("admin@example.com", "admin");
    const me = await c.json<{ data: User }>("/api/account/me");
    expect(me.data.email).toBe("admin@example.com");
    expect(me.data.name.length).toBeGreaterThan(0);
    expect(me.data.username.length).toBeGreaterThan(0);
  });
});

describe("/api/account/me/preferences", () => {
  it("PUT writes a preference; GET reads it back", async () => {
    const c = await getClient("admin@example.com", "admin");
    await c.raw("/api/account/me/preferences/theme", {
      method: "PUT",
      body: { value: "dark" },
    });
    const res = await c.json<{ data: { value: string } }>("/api/account/me/preferences/theme");
    expect(res.data.value).toBe("dark");
  });
});

describe("/api/account/auth/logout-url", () => {
  it("returns null when the IdP does not advertise end_session_endpoint", async () => {
    // dex (v2.41) doesn't publish end_session_endpoint in OIDC discovery,
    // so the API reports null. We're testing the contract, not dex.
    const c = new ApiClient();
    const res = await c.json<{ data: { url: string | null } }>("/api/account/auth/logout-url");
    expect(res.data.url).toBeNull();
  });
});
