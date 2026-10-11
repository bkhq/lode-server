import type { ApiClient } from "../../lib/api";
import type { Envelope, PackageView, TokenView, VersionView } from "./helpers";
import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";
import { createDraft, createPackage, createToken, deletePackage, feed, namespaceOf, packagePath, putAsset, refusal, release, setChannel, text, withToken } from "./helpers";

interface Owner { id: string; username: string; name: string }
interface AdminNamespace { slug: string; status: string; owner: Owner; packages: number; storage_bytes: number }
interface AdminPackage extends PackageView { owner: Owner; storage_bytes: number }
interface Limits { max_packages: number | null; max_storage_bytes: number | null; max_asset_bytes: number | null }
interface UserQuota { user_id: string; override: Limits; limits: Limits; usage: { packages: number; storage_bytes: number } }

async function userId(client: ApiClient): Promise<string> {
  return (await client.json<Envelope<{ id: string }>>("/api/account/me")).data.id;
}

describe("/api/registry/admin — platform administration", () => {
  it("is for the administrator's session only", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");
    const adminToken = await createToken(admin, { all: "admin" });
    const id = await userId(user);

    const routes = [
      ["GET", "/api/registry/admin/namespaces"],
      ["POST", `/api/registry/admin/namespaces/${await namespaceOf(user)}/suspend`],
      ["POST", `/api/registry/admin/namespaces/${await namespaceOf(user)}/restore`],
      ["GET", "/api/registry/admin/packages"],
      ["GET", `/api/registry/admin/users/${id}/quota`],
      ["PUT", `/api/registry/admin/users/${id}/quota`],
      ["GET", "/api/registry/admin/tokens"],
      ["DELETE", `/api/registry/admin/tokens/${adminToken.id}`],
    ] as const;
    for (const [method, path] of routes) {
      const body = method === "PUT" ? { max_packages: 1 } : undefined;
      expect((await fetch(`${user.base}${path}`, { method })).status).toBeOneOf([401, 403]);
      expect((await user.raw(path, { method, body })).status).toBe(403);
      // Not even the administrator's own token.
      expect((await withToken(adminToken.token, path, { method, ...(body && { body: JSON.stringify(body) }) })).status).toBe(403);
    }
    await admin.json(`/api/registry/tokens/${adminToken.id}`, { method: "DELETE" });
  });

  it("lists every namespace and package with owner and storage, and acts on any package through the ordinary routes", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");
    const pkg = await createPackage(user, { visibility: "private" });
    const bytes = text("twelve bytes");
    await release(user, pkg, "1.0.0", { name: "app.bin", bytes });
    await release(user, pkg, "2.0.0", { name: "app.bin", bytes });

    const packages = (await admin.json<Envelope<AdminPackage[]>>("/api/registry/admin/packages")).data;
    const listed = packages.find(p => p.id === pkg.id);
    expect(listed).toMatchObject({ namespace: pkg.namespace, slug: pkg.slug, visibility: "private", storage_bytes: 2 * bytes.length });
    expect(listed!.owner).toMatchObject({ id: await userId(user), username: expect.any(String) });

    const namespaces = (await admin.json<Envelope<AdminNamespace[]>>("/api/registry/admin/namespaces")).data;
    const mine = namespaces.find(n => n.slug === pkg.namespace)!;
    const own = packages.filter(p => p.namespace === pkg.namespace);
    expect(mine).toMatchObject({ status: "active", packages: own.length, storage_bytes: own.reduce((sum, p) => sum + p.storage_bytes, 0) });
    expect(mine.owner.id).toBe(await userId(user));

    // Takedown, as the owner would do it: roll the pointer back, yank, delete.
    expect((await setChannel(admin, pkg, "stable", "1.0.0")).status).toBe(200);
    const yanked = await admin.json<Envelope<VersionView>>(`${packagePath(pkg)}/versions/2.0.0/yank`, { method: "POST" });
    expect(yanked.data.status).toBe("yanked");
    expect((await admin.raw(`${packagePath(pkg)}/versions/2.0.0`, { method: "DELETE" })).status).toBe(200);
    await deletePackage(admin, pkg);
    expect((await user.raw(packagePath(pkg))).status).toBe(404);
  });

  it("overrides a user's quota, which then bounds packages, asset size and storage", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");
    const quotaPath = `/api/registry/admin/users/${await userId(user)}/quota`;
    const pkg = await createPackage(user);
    await createDraft(user, pkg, "1.0.0");

    try {
      const before = (await admin.json<Envelope<UserQuota>>(quotaPath)).data;
      expect(before.override).toEqual({ max_packages: null, max_storage_bytes: null, max_asset_bytes: null });
      expect(before.limits).toEqual({ max_packages: 50, max_storage_bytes: 10 * 1024 ** 3, max_asset_bytes: 500 * 1024 ** 2 });

      const held = before.usage.packages;
      const set = await admin.json<Envelope<UserQuota>>(quotaPath, {
        method: "PUT",
        body: { max_packages: held, max_storage_bytes: before.usage.storage_bytes + 10, max_asset_bytes: 8 },
      });
      expect(set.data.limits).toEqual({ max_packages: held, max_storage_bytes: before.usage.storage_bytes + 10, max_asset_bytes: 8 });
      // The user sees the limits that now apply to them.
      expect((await user.json<Envelope<{ limits: Limits }>>("/api/registry/quota")).data.limits).toEqual(set.data.limits);

      const another = await user.raw("/api/registry/packages", { method: "POST", body: { slug: "one-too-many", name: "x" } });
      expect(await refusal(another)).toEqual({ status: 409, code: "PACKAGE_QUOTA_EXCEEDED" });
      expect(await refusal(await putAsset(user, pkg, "1.0.0", "big.bin", text("nine byte")))).toEqual({ status: 413, code: "ASSET_TOO_LARGE" });
      expect((await putAsset(user, pkg, "1.0.0", "a.bin", text("eight by"))).status).toBe(201);
      // 8 of the 10 bytes are taken: another 8 do not fit.
      expect(await refusal(await putAsset(user, pkg, "1.0.0", "b.bin", text("eight by")))).toEqual({ status: 409, code: "STORAGE_QUOTA_EXCEEDED" });

      // A limit left out goes back to the platform default; the ceiling holds.
      const partial = await admin.json<Envelope<UserQuota>>(quotaPath, { method: "PUT", body: { max_packages: 60 } });
      expect(partial.data.override).toEqual({ max_packages: 60, max_storage_bytes: null, max_asset_bytes: null });
      expect((await admin.raw(quotaPath, { method: "PUT", body: { max_asset_bytes: 500 * 1024 ** 2 + 1 } })).status).toBe(422);
      expect((await admin.raw(quotaPath, { method: "PUT", body: { max_packages: -1 } })).status).toBe(422);
      expect((await admin.raw("/api/registry/admin/users/does-not-exist/quota")).status).toBe(404);
    }
    finally {
      const cleared = await admin.json<Envelope<UserQuota>>(quotaPath, { method: "PUT", body: {} });
      expect(cleared.data.override).toEqual({ max_packages: null, max_storage_bytes: null, max_asset_bytes: null });
      await deletePackage(user, pkg);
    }
  });

  it("suspends a namespace: its feed is gone, its owner is read-only, its tokens are refused", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");
    const pkg = await createPackage(user);
    await release(user, pkg, "1.0.0", { name: "app.bin", bytes: text("one") });
    const token = await createToken(user, { all: "admin" });
    const manifest = `/${pkg.namespace}/${pkg.slug}/manifest.json`;
    expect((await feed(manifest)).status).toBe(200);

    try {
      const suspended = await admin.json<Envelope<{ slug: string; status: string }>>(`/api/registry/admin/namespaces/${pkg.namespace}/suspend`, { method: "POST" });
      expect(suspended.data).toMatchObject({ slug: pkg.namespace, status: "suspended" });

      expect((await feed(manifest)).status).toBe(404);
      expect((await feed(`/${pkg.namespace}/${pkg.slug}/1.0.0/app.bin`)).status).toBe(404);
      // The owner still reads, and changes nothing.
      expect((await user.raw(packagePath(pkg))).status).toBe(200);
      expect(await refusal(await user.raw(packagePath(pkg), { method: "PATCH", body: { description: "x" } }))).toEqual({ status: 403, code: "NAMESPACE_SUSPENDED" });
      expect(await refusal(await user.raw(`${packagePath(pkg)}/versions`, { method: "POST", body: { version: "2.0.0" } }))).toEqual({ status: 403, code: "NAMESPACE_SUSPENDED" });
      expect(await refusal(await user.raw("/api/registry/packages", { method: "POST", body: { slug: "while-suspended", name: "x" } }))).toEqual({ status: 403, code: "NAMESPACE_SUSPENDED" });
      expect(await refusal(await withToken(token.token, packagePath(pkg)))).toEqual({ status: 403, code: "NAMESPACE_SUSPENDED" });
      expect(await refusal(await withToken(token.token, "/api/registry/packages"))).toEqual({ status: 403, code: "NAMESPACE_SUSPENDED" });
      // The administrator still acts on it.
      expect((await admin.raw(packagePath(pkg), { method: "PATCH", body: { description: "under review" } })).status).toBe(200);
    }
    finally {
      const restored = await admin.json<Envelope<{ status: string }>>(`/api/registry/admin/namespaces/${pkg.namespace}/restore`, { method: "POST" });
      expect(restored.data.status).toBe("active");
    }

    expect((await feed(manifest)).status).toBe(200);
    expect((await withToken(token.token, packagePath(pkg))).status).toBe(200);
    expect((await admin.raw("/api/registry/admin/namespaces/zzzzzzzz/suspend", { method: "POST" })).status).toBe(404);

    await user.json(`/api/registry/tokens/${token.id}`, { method: "DELETE" });
    await deletePackage(user, pkg);
  });

  it("lists and revokes any user's tokens", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");
    const pkg = await createPackage(user);
    const token = await createToken(user, [{ package: `${pkg.namespace}/${pkg.slug}`, access: "write" }]);
    const id = await userId(user);

    const theirs = await admin.json<Envelope<(TokenView & { user_id: string })[]>>(`/api/registry/admin/tokens?user_id=${id}`);
    expect(theirs.data.every(t => t.user_id === id)).toBe(true);
    expect(theirs.data.find(t => t.id === token.id)?.grants).toEqual([{ package: `${pkg.namespace}/${pkg.slug}`, access: "write" }]);
    const everyone = await admin.json<Envelope<TokenView[]>>("/api/registry/admin/tokens");
    expect(everyone.data.some(t => t.id === token.id)).toBe(true);
    expect(JSON.stringify(everyone)).not.toContain(token.token);

    expect((await withToken(token.token, packagePath(pkg))).status).toBe(200);
    expect((await admin.raw(`/api/registry/admin/tokens/${token.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await withToken(token.token, packagePath(pkg))).status).toBe(401);
    expect((await admin.raw(`/api/registry/admin/tokens/${token.id}`, { method: "DELETE" })).status).toBe(404);

    await deletePackage(user, pkg);
  });
});
