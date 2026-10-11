import type { Envelope, PackageView } from "./helpers";
import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";
import { createPackage, deletePackage, namespaceOf, packagePath, refusal, uniqueSlug } from "./helpers";

describe("/api/registry/packages — package CRUD", () => {
  it("creates a package from { slug, name }, reads, lists, updates and deletes it", async () => {
    const user = await getClient("user@example.com");
    const slug = uniqueSlug("crud");
    const pkg = await createPackage(user, { slug, name: "  Demo App  " });
    expect(pkg).toMatchObject({
      namespace: await namespaceOf(user),
      slug,
      name: "Demo App",
      visibility: "public",
      description: null,
      require_signature: false,
    });

    expect((await user.json<Envelope<PackageView>>(packagePath(pkg))).data.id).toBe(pkg.id);
    expect((await user.json<Envelope<PackageView[]>>("/api/registry/packages")).data.some(p => p.id === pkg.id)).toBe(true);

    const updated = await user.json<Envelope<PackageView>>(packagePath(pkg), {
      method: "PATCH",
      body: { name: "Renamed", visibility: "private", description: "hello", require_signature: true },
    });
    expect(updated.data).toMatchObject({ slug, name: "Renamed", visibility: "private", description: "hello", require_signature: true });

    // The slug is permanent, and an empty patch changes nothing.
    expect((await user.raw(packagePath(pkg), { method: "PATCH", body: { slug: "other" } })).status).toBe(422);
    expect((await user.raw(packagePath(pkg), { method: "PATCH", body: {} })).status).toBe(422);

    await deletePackage(user, pkg);
    expect((await user.raw(packagePath(pkg))).status).toBe(404);
  });

  it("validates the slug and keeps it unique within the namespace only", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");

    for (const slug of ["", "-lead", "Upper", "under_score", "dot.ted", "a".repeat(129)]) {
      const res = await user.raw("/api/registry/packages", { method: "POST", body: { slug, name: "x" } });
      expect(await refusal(res)).toEqual({ status: 422, code: "VALIDATION_ERROR" });
    }
    expect((await user.raw("/api/registry/packages", { method: "POST", body: { slug: uniqueSlug("noname") } })).status).toBe(422);

    const slug = uniqueSlug("same");
    const mine = await createPackage(user, { slug });
    const dup = await user.raw("/api/registry/packages", { method: "POST", body: { slug, name: "dup" } });
    expect(await refusal(dup)).toEqual({ status: 409, code: "PACKAGE_EXISTS" });
    // Another user may use the same slug: it lives in their namespace.
    const theirs = await createPackage(admin, { slug });
    expect(theirs.namespace).not.toBe(mine.namespace);

    await deletePackage(user, mine);
    await deletePackage(admin, theirs);
  });

  it("keeps users apart: public is readable, private is invisible, an administrator passes", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");

    // The administrator's packages, seen by an ordinary user.
    const open = await createPackage(admin, { visibility: "public" });
    const hidden = await createPackage(admin, { visibility: "private" });
    expect((await user.raw(packagePath(open))).status).toBe(200);
    expect((await user.raw(packagePath(open), { method: "PATCH", body: { description: "mine now" } })).status).toBe(403);
    expect((await user.raw(packagePath(open), { method: "DELETE" })).status).toBe(403);
    expect((await user.raw(`${packagePath(open)}/versions`, { method: "POST", body: { version: "1.0.0" } })).status).toBe(403);
    for (const [method, body] of [["GET", undefined], ["PATCH", { description: "x" }], ["DELETE", undefined]] as const)
      expect((await user.raw(packagePath(hidden), { method, body })).status).toBe(404);
    expect((await user.json<Envelope<PackageView[]>>("/api/registry/packages")).data.some(p => p.id === open.id || p.id === hidden.id)).toBe(false);
    await deletePackage(admin, open);
    await deletePackage(admin, hidden);

    // An ordinary user's private package, managed by the administrator
    // through the same routes.
    const pkg = await createPackage(user, { visibility: "private" });
    expect((await admin.raw(packagePath(pkg))).status).toBe(200);
    const patched = await admin.json<Envelope<PackageView>>(packagePath(pkg), { method: "PATCH", body: { visibility: "public" } });
    expect(patched.data.visibility).toBe("public");
    await deletePackage(admin, pkg);
    expect((await user.raw(packagePath(pkg))).status).toBe(404);
  });

  it("reports quota and usage", async () => {
    const user = await getClient("user@example.com");
    const quota = await user.json<Envelope<{ limits: Record<string, number>; usage: Record<string, number> }>>("/api/registry/quota");
    expect(quota.data.limits).toEqual({ max_packages: 50, max_storage_bytes: 10 * 1024 ** 3, max_asset_bytes: 500 * 1024 ** 2 });
    expect(quota.data.usage.packages).toBeGreaterThanOrEqual(0);
    expect(quota.data.usage.storage_bytes).toBeGreaterThanOrEqual(0);
  });
});
