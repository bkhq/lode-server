import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";
import { createPackage, createToken, deletePackage, namespaceOf, refusal, withToken } from "./helpers";

describe("/api/registry/namespace — the system-assigned namespace", () => {
  it("is an 8-character id, stable per user and different between users", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");

    const mine = await namespaceOf(user);
    expect(mine).toMatch(/^[a-z][a-z0-9]{7}$/);
    expect(await namespaceOf(user)).toBe(mine);
    expect(await namespaceOf(admin)).not.toBe(mine);

    // A package lands in it, whatever the caller asks for.
    const pkg = await createPackage(user);
    expect(pkg.namespace).toBe(mine);
    await deletePackage(user, pkg);
  });

  it("cannot be claimed or renamed: there is no write route", async () => {
    const user = await getClient("user@example.com");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await user.raw("/api/registry/namespace", {
        method,
        body: { slug: "mine" },
      });
      expect(res.status).toBe(404);
    }
  });

  it("is session only: refused without a session and with a token", async () => {
    const user = await getClient("user@example.com");
    expect((await fetch(`${user.base}/api/registry/namespace`)).status).toBe(401);
    const { id, token } = await createToken(user, { all: "admin" });
    expect(await refusal(await withToken(token, "/api/registry/namespace"))).toEqual({ status: 403, code: "FORBIDDEN" });
    await user.json(`/api/registry/tokens/${id}`, { method: "DELETE" });
  });
});
