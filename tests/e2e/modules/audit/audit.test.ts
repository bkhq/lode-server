import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Event { id: string; action: string; actorId: string; resourceType: string }

describe("/api/audit", () => {
  it("admin can list audit events; events grow after actions are performed", async () => {
    const admin = await getClient("admin@example.com", "admin");

    const before = await admin.json<{ data: Event[]; meta: { total: number } }>("/api/audit");
    const startTotal = before.meta.total;

    // Perform an audited action: create + delete a group.
    const created = await admin.json<{ data: { id: string } }>("/api/account/groups", {
      method: "POST",
      body: { name: `audit-fixture-${Date.now()}` },
    });
    await admin.raw(`/api/account/groups/${created.data.id}`, { method: "DELETE" });

    const after = await admin.json<{ data: Event[]; meta: { total: number } }>("/api/audit");
    expect(after.meta.total).toBeGreaterThan(startTotal);

    // The most recent event should be the group deletion.
    const recent = after.data[0];
    expect(recent).toBeDefined();
    expect(recent!.actorId).not.toBe("");
  });

  it("non-admin cannot list audit events (403)", async () => {
    const user = await getClient("user@example.com", "admin");
    const res = await user.raw("/api/audit");
    expect(res.status).toBe(403);
  });
});
