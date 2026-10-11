import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Group {
  id: string;
  name: string;
  description: string | null;
  memberCount?: number;
}
interface User { id: string; email: string }

describe("/api/account/groups CRUD", () => {
  it("admin can create / list / patch / delete a group and manage members", async () => {
    const admin = await getClient("admin@example.com", "admin");
    // Make sure user@example.com exists in the directory.
    await getClient("user@example.com", "admin");

    const users = await admin.json<{ data: User[] }>("/api/account/users");
    const target = users.data.find(u => u.email === "user@example.com");
    if (!target)
      throw new Error("user@example.com did not land in the directory");

    // Create.
    const created = await admin.json<{ data: Group }>("/api/account/groups", {
      method: "POST",
      body: { name: `e2e-group-${Date.now()}`, description: "e2e fixture group" },
    });
    const groupId = created.data.id;
    expect(groupId.length).toBe(8);

    // List.
    const list = await admin.json<{ data: Group[] }>("/api/account/groups");
    expect(list.data.find(g => g.id === groupId)).toBeDefined();

    // Patch description.
    const patched = await admin.json<{ data: Group }>(`/api/account/groups/${groupId}`, {
      method: "PATCH",
      body: { description: "updated description" },
    });
    expect(patched.data.description).toBe("updated description");

    // Add member.
    await admin.raw(`/api/account/groups/${groupId}/members`, {
      method: "POST",
      body: { userId: target.id },
    });
    const members = await admin.json<{ data: { id: string; email: string }[] }>(`/api/account/groups/${groupId}/members`);
    expect(members.data.find(m => m.id === target.id)).toBeDefined();

    // Member count reflects the addition.
    const refreshed = await admin.json<{ data: Group[] }>("/api/account/groups");
    const ours = refreshed.data.find(g => g.id === groupId);
    expect(ours?.memberCount).toBe(1);

    // Remove member.
    await admin.raw(`/api/account/groups/${groupId}/members/${target.id}`, { method: "DELETE" });
    const empty = await admin.json<{ data: unknown[] }>(`/api/account/groups/${groupId}/members`);
    expect(empty.data).toHaveLength(0);

    // Delete group.
    await admin.raw(`/api/account/groups/${groupId}`, { method: "DELETE" });
    const final = await admin.json<{ data: Group[] }>("/api/account/groups");
    expect(final.data.find(g => g.id === groupId)).toBeUndefined();
  });

  it("non-admin cannot create a group (403)", async () => {
    const user = await getClient("user@example.com", "admin");
    const res = await user.raw("/api/account/groups", {
      method: "POST",
      body: { name: "should-fail" },
    });
    expect(res.status).toBe(403);
  });
});
