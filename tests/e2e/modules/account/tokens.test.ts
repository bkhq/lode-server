import { describe, expect, it } from "bun:test";
import { API_BASE } from "../../lib/api";
import { getClient } from "../../lib/oidc";

interface CreatedToken { id: string; token: string; scopes: string[] }

// A token client sends only the bearer header: no cookie, no CSRF header,
// no Origin — the way another service calls the API.
function withToken(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
}

describe("/api/account/me/tokens — personal API tokens", () => {
  it("a token works within its scopes, is refused outside them, and stops working once revoked", async () => {
    const user = await getClient("user@example.com");

    const scopes = await user.json<{ data: { name: string }[] }>("/api/account/token-scopes");
    expect(scopes.data.map(s => s.name)).toContain("account:read");

    const created = await user.json<{ data: CreatedToken }>("/api/account/me/tokens", {
      method: "POST",
      body: { name: `e2e-${Date.now()}`, scopes: ["account:read"], expiresInDays: 1 },
    });
    const { token, id } = created.data;
    expect(token.startsWith("pat_")).toBe(true);

    // Covered by account:read, and the token acts as its user.
    const me = await withToken(token, "/api/account/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { data: { email: string } }).data.email).toBe("user@example.com");
    expect((await withToken(token, "/api/account/me/groups")).status).toBe(200);

    // Not covered: a write, and token management itself.
    expect((await withToken(token, "/api/account/me/preferences/e2e", { method: "PUT", body: JSON.stringify({ value: "nope" }) })).status).toBe(403);
    expect((await withToken(token, "/api/account/me/tokens")).status).toBe(403);
    expect((await withToken(token, "/api/settings")).status).toBe(403);

    // The list never shows the secret.
    const list = await user.json<{ data: { id: string }[] }>("/api/account/me/tokens");
    expect(list.data.some(t => t.id === id)).toBe(true);
    expect(JSON.stringify(list)).not.toContain(token);

    await user.json(`/api/account/me/tokens/${id}`, { method: "DELETE" });
    expect((await withToken(token, "/api/account/me")).status).toBe(401);
  });
});
