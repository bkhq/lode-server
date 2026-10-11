import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Tuple {
  id: string;
  namespace: string;
  objectId: string;
  relation: string;
  subjectNamespace: string;
  subjectId: string;
  subjectRelation: string | null;
}

describe("/api/policy/tuples CRUD + check", () => {
  it("creates, lists, checks, and deletes a tuple", async () => {
    const admin = await getClient("admin@example.com", "admin");
    await getClient("user@example.com", "admin");

    const users = await admin.json<{ data: { id: string; email: string }[] }>("/api/account/users");
    const userId = users.data.find(u => u.email === "user@example.com")?.id;
    if (!userId)
      throw new Error("expected user@example.com in directory");

    const docId = `e2e-rg-${Date.now()}`;

    // Create: viewer relation on a fictional document for the user.
    const created = await admin.json<{ data: Tuple }>("/api/policy/tuples", {
      method: "POST",
      body: {
        namespace: "resource_group",
        objectId: docId,
        relation: "viewer",
        subjectNamespace: "user",
        subjectId: userId,
      },
    });
    expect(created.data.objectId).toBe(docId);
    expect(created.data.relation).toBe("viewer");
    const tupleId = created.data.id;

    // List: filter by object.
    const listed = await admin.json<{ data: Tuple[] }>(
      `/api/policy/tuples?namespace=resource_group&objectId=${docId}`,
    );
    expect(listed.data.find(t => t.id === tupleId)).toBeDefined();

    // Check: user should now have viewer access on the document.
    const check = await admin.json<{ data: { allowed: boolean } }>("/api/policy/check", {
      method: "POST",
      body: {
        namespace: "resource_group",
        objectId: docId,
        relation: "viewer",
        subjectNamespace: "user",
        subjectId: userId,
      },
    });
    expect(check.data.allowed).toBe(true);

    // Delete.
    await admin.raw(`/api/policy/tuples/${tupleId}`, { method: "DELETE" });
    const after = await admin.json<{ data: { allowed: boolean } }>("/api/policy/check", {
      method: "POST",
      body: {
        namespace: "resource_group",
        objectId: docId,
        relation: "viewer",
        subjectNamespace: "user",
        subjectId: userId,
      },
    });
    expect(after.data.allowed).toBe(false);
  });

  it("non-admin cannot create policy tuples (403)", async () => {
    const user = await getClient("user@example.com", "admin");
    const res = await user.raw("/api/policy/tuples", {
      method: "POST",
      body: {
        namespace: "resource_group",
        objectId: "x",
        relation: "viewer",
        subjectNamespace: "user",
        subjectId: "y",
      },
    });
    expect(res.status).toBe(403);
  });
});
