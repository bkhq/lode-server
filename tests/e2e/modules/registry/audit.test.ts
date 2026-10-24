import type { ApiClient } from "../../lib/api";
import type { Envelope } from "./helpers";
import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";
import { createPackage, createToken, deletePackage, release, text } from "./helpers";

interface Event {
  action: string;
  actorId: string;
  resourceType: string;
  resourceId: string;
  resourceName: string;
  /** JSON text. */
  detail: string | null;
}

function detailOf(event: Event): Record<string, unknown> {
  return JSON.parse(event.detail ?? "{}") as Record<string, unknown>;
}

async function events(admin: ApiClient, query: string): Promise<Event[]> {
  return (await admin.json<Envelope<Event[]>>(`/api/audit?${query}`)).data;
}

describe("registry audit entries", () => {
  it("records who did what to whose package, and with which token", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");
    const me = (await user.json<Envelope<{ id: string }>>("/api/account/me")).data.id;
    const adminId = (await admin.json<Envelope<{ id: string }>>("/api/account/me")).data.id;

    const pkg = await createPackage(user);
    const name = `${pkg.namespace}/${pkg.slug}`;
    const ci = await createToken(user, [
      { package: name, access: "write" },
    ]);
    await release(ci.token, pkg, "1.0.0", {
      name: "app.bin",
      bytes: text("one"),
    });
    // An administrator acting on the user's package.
    await admin.json(`/api/registry/packages/${name}`, {
      method: "PATCH",
      body: { description: "reviewed" },
    });
    await deletePackage(user, pkg);

    const onPackage = await events(admin, `resource_id=${pkg.id}`);
    expect(onPackage.map(e => e.action).toSorted()).toEqual(["registry.package.created", "registry.package.deleted", "registry.package.updated"]);
    const created = onPackage.find(e => e.action === "registry.package.created")!;
    expect(created).toMatchObject({ actorId: me, resourceType: "package", resourceName: name });
    // The acting administrator, and the owner the package belongs to.
    const updated = onPackage.find(e => e.action === "registry.package.updated")!;
    expect(updated.actorId).toBe(adminId);
    expect(detailOf(updated)).toMatchObject({
      owner_user_id: me,
      changes: { description: "reviewed" },
    });

    // Release steps made with a token carry its id next to the user.
    for (const [action, resourceName] of [
      ["registry.version.created", `${name}@1.0.0`],
      ["registry.asset.uploaded", `${name}@1.0.0/app.bin`],
      ["registry.version.published", `${name}@1.0.0`],
    ] as const) {
      const entry = (await events(admin, `action=${action}`)).find(e => e.resourceName === resourceName);
      expect(entry).toBeDefined();
      expect(entry!.actorId).toBe(me);
      expect(detailOf(entry!)).toMatchObject({ owner_user_id: me, token_id: ci.id });
    }

    const minted = (await events(admin, `action=registry.token.created&resource_id=${ci.id}`))[0];
    expect(minted).toMatchObject({ actorId: me, resourceType: "api_token" });
    expect(JSON.stringify(minted)).not.toContain(ci.token);
    await user.json(`/api/registry/tokens/${ci.id}`, { method: "DELETE" });
    expect((await events(admin, `action=registry.token.revoked&resource_id=${ci.id}`)).length).toBe(1);
  });
});
