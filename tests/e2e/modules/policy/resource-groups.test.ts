// Resource-group CRUD + relation chain check.
//
// The policy module declares a `resource_group` namespace with a 4-level
// relation hierarchy (admin ⊃ manager ⊃ editor ⊃ viewer) plus a flat
// `member` relation. Granting a higher relation should imply lower ones,
// driven by the zanzibar engine's check / expand routines.

import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface ResourceGroup { id: string; name: string }
interface CheckResponse { data: { allowed: boolean } }

describe("/api/policy/resource-groups CRUD + check chain", () => {
  it("admin creates a resource-group, adds a user as `editor`, check returns true for editor + viewer", async () => {
    const admin = await getClient("admin@example.com", "admin");
    await getClient("user@example.com", "admin");
    const users = await admin.json<{ data: { id: string; email: string }[] }>("/api/account/users");
    const userId = users.data.find(u => u.email === "user@example.com")?.id;
    if (!userId)
      throw new Error("user@example.com missing from directory");

    // Create resource-group.
    const created = await admin.json<{ data: ResourceGroup }>("/api/policy/resource-groups", {
      method: "POST",
      body: { name: `e2e-rg-${Date.now()}` },
    });
    const rgId = created.data.id;
    expect(rgId.length).toBeGreaterThan(0);

    // Listed.
    const list = await admin.json<{ data: ResourceGroup[] }>("/api/policy/resource-groups");
    expect(list.data.find(g => g.id === rgId)).toBeDefined();

    // The dedicated /resource-groups/:id/members endpoint always grants the
    // flat `member` relation. To exercise the relation hierarchy we mint
    // `editor` directly via the policy tuple endpoint.
    await admin.raw("/api/policy/tuples", {
      method: "POST",
      body: {
        namespace: "resource_group",
        objectId: rgId,
        relation: "editor",
        subjectNamespace: "user",
        subjectId: userId,
      },
    });

    // Direct check: user has `editor`.
    const editorCheck = await admin.json<CheckResponse>("/api/policy/check", {
      method: "POST",
      body: {
        namespace: "resource_group",
        objectId: rgId,
        relation: "editor",
        subjectNamespace: "user",
        subjectId: userId,
      },
    });
    expect(editorCheck.data.allowed).toBe(true);

    // Implied: viewer = this | computed_userset(editor), so editor implies viewer.
    const viewerCheck = await admin.json<CheckResponse>("/api/policy/check", {
      method: "POST",
      body: {
        namespace: "resource_group",
        objectId: rgId,
        relation: "viewer",
        subjectNamespace: "user",
        subjectId: userId,
      },
    });
    expect(viewerCheck.data.allowed).toBe(true);

    // Anti-check: user does NOT have `manager` (no implication path up).
    const managerCheck = await admin.json<CheckResponse>("/api/policy/check", {
      method: "POST",
      body: {
        namespace: "resource_group",
        objectId: rgId,
        relation: "manager",
        subjectNamespace: "user",
        subjectId: userId,
      },
    });
    expect(managerCheck.data.allowed).toBe(false);

    // The /resource-groups/:id/members endpoint accepts only custom namespaces
    // (user / group / resource_group are reserved). The default config
    // registers no custom namespaces, so we don't exercise that endpoint
    // here — covered separately when a custom namespace lands.

    // Cleanup.
    await admin.raw(`/api/policy/resource-groups/${rgId}`, { method: "DELETE" });
  });

  it("non-admin cannot create resource-groups (403)", async () => {
    const user = await getClient("user@example.com", "admin");
    const res = await user.raw("/api/policy/resource-groups", {
      method: "POST",
      body: { name: "should-fail" },
    });
    expect(res.status).toBe(403);
  });
});
