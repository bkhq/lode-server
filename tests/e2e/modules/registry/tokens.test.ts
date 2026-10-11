import type { Envelope, PackageView, TokenView } from "./helpers";
import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";
import { createDraft, createPackage, createToken, deletePackage, packagePath, refusal, release, text, uploadAsset, withToken } from "./helpers";

function json(body: unknown): RequestInit {
  return { body: JSON.stringify(body) };
}

describe("/api/registry/tokens — tokens and package grants", () => {
  it("a grant names <namespace>/<package slug>; the levels read < write < admin decide what the token may do", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const other = await createPackage(user);
    const name = `${pkg.namespace}/${pkg.slug}`;

    const read = await createToken(user, [{ package: name, access: "read" }]);
    const write = await createToken(user, [{ package: name, access: "write" }]);
    const admin = await createToken(user, [{ package: name, access: "admin" }]);
    expect(read.token.startsWith("pat_")).toBe(true);
    expect(read.grants).toEqual([{ package: name, access: "read" }]);

    // read: metadata of the granted package only.
    expect((await withToken(read.token, packagePath(pkg))).status).toBe(200);
    expect((await withToken(read.token, `${packagePath(pkg)}/versions`)).status).toBe(200);
    const listed = await (await withToken(read.token, "/api/registry/packages")).json() as Envelope<PackageView[]>;
    expect(listed.data.map(p => p.id)).toEqual([pkg.id]);
    expect((await withToken(read.token, packagePath(other))).status).toBe(403);
    expect((await withToken(read.token, `${packagePath(pkg)}/versions`, { method: "POST", ...json({ version: "1.0.0" }) })).status).toBe(403);

    // write: the release routes, not the settings and not yank.
    await release(write.token, pkg, "1.0.0", { name: "app.bin", bytes: text("one") });
    await release(write.token, pkg, "2.0.0", { name: "app.bin", bytes: text("two") });
    expect((await withToken(write.token, packagePath(pkg), { method: "PATCH", ...json({ description: "x" }) })).status).toBe(403);
    expect((await withToken(write.token, `${packagePath(pkg)}/versions/1.0.0/yank`, { method: "POST" })).status).toBe(403);
    expect((await withToken(write.token, `${packagePath(other)}/versions`, { method: "POST", ...json({ version: "1.0.0" }) })).status).toBe(403);
    // A draft goes with a write grant; a published version never goes with a token.
    await createDraft(write.token, pkg, "3.0.0-draft");
    expect((await withToken(write.token, `${packagePath(pkg)}/versions/3.0.0-draft`, { method: "DELETE" })).status).toBe(200);
    expect((await withToken(admin.token, `${packagePath(pkg)}/versions/1.0.0`, { method: "DELETE" })).status).toBe(403);

    // admin: settings, yank and restore — still not deletion.
    expect((await withToken(admin.token, packagePath(pkg), { method: "PATCH", ...json({ description: "by token" }) })).status).toBe(200);
    expect((await withToken(admin.token, `${packagePath(pkg)}/versions/1.0.0/yank`, { method: "POST" })).status).toBe(200);
    expect((await withToken(admin.token, `${packagePath(pkg)}/versions/1.0.0/restore`, { method: "POST" })).status).toBe(200);
    expect((await withToken(admin.token, packagePath(pkg), { method: "DELETE" })).status).toBe(403);

    // Session only, whatever the grants.
    for (const [method, path, body] of [
      ["POST", "/api/registry/packages", { slug: "by-token", name: "x" }],
      ["GET", "/api/registry/tokens", undefined],
      ["POST", "/api/registry/tokens", { name: "x", grants: { all: "read" } }],
      ["DELETE", `/api/registry/tokens/${read.id}`, undefined],
      ["DELETE", `${packagePath(pkg)}/keys/none`, undefined],
      ["GET", "/api/registry/quota", undefined],
      ["GET", "/api/registry/admin/packages", undefined],
    ] as const)
      expect((await withToken(admin.token, path, { method, ...(body && json(body)) })).status).toBe(403);

    for (const token of [read, write, admin])
      await user.json(`/api/registry/tokens/${token.id}`, { method: "DELETE" });
    await deletePackage(user, pkg);
    await deletePackage(user, other);
  });

  it("grants can be replaced without reissuing the secret, and a revoked token stops working", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const name = `${pkg.namespace}/${pkg.slug}`;
    const created = await createToken(user, [{ package: name, access: "read" }]);
    const draft = () => withToken(created.token, `${packagePath(pkg)}/versions`, { method: "POST", ...json({ version: `1.0.${Date.now()}` }) });

    expect((await draft()).status).toBe(403);
    const replaced = await user.json<Envelope<TokenView>>(`/api/registry/tokens/${created.id}`, { method: "PUT", body: { grants: { all: "write" } } });
    expect(replaced.data.grants).toEqual({ all: "write" });
    expect((await draft()).status).toBe(201);
    // "All my packages" includes one created afterwards.
    const later = await createPackage(user);
    expect((await withToken(created.token, packagePath(later))).status).toBe(200);

    // No grant left: the token reaches nothing.
    await user.json(`/api/registry/tokens/${created.id}`, { method: "PUT", body: { grants: [] } });
    expect((await withToken(created.token, packagePath(pkg))).status).toBe(403);

    const list = await user.json<Envelope<TokenView[]>>("/api/registry/tokens");
    expect(list.data.find(t => t.id === created.id)?.grants).toEqual([]);
    expect(JSON.stringify(list)).not.toContain(created.token);

    await user.json(`/api/registry/tokens/${created.id}`, { method: "DELETE" });
    expect((await withToken(created.token, packagePath(pkg))).status).toBe(401);
    expect((await user.raw(`/api/registry/tokens/${created.id}`, { method: "DELETE" })).status).toBe(404);
    await deletePackage(user, pkg);
    await deletePackage(user, later);
  });

  it("a grant cannot name a package that is missing or someone else's, and the two answer alike", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");
    const theirs = await createPackage(admin, { visibility: "public" });

    for (const name of [`${theirs.namespace}/${theirs.slug}`, `${theirs.namespace}/does-not-exist`, "no-slash", "a/b/c"]) {
      const res = await user.raw("/api/registry/tokens", { method: "POST", body: { name: "x", grants: [{ package: name, access: "read" }] } });
      expect(await refusal(res)).toEqual({ status: 422, code: "INVALID_GRANT" });
    }
    const unknownLevel = await user.raw("/api/registry/tokens", { method: "POST", body: { name: "x", grants: { all: "owner" } } });
    expect(unknownLevel.status).toBe(422);

    // An "all my packages" grant of an ordinary user stops at their namespace.
    const all = await createToken(user, { all: "admin" });
    expect((await withToken(all.token, packagePath(theirs))).status).toBe(403);
    await user.json(`/api/registry/tokens/${all.id}`, { method: "DELETE" });
    await deletePackage(admin, theirs);
  });

  it("a write-granted token uploads into a draft and a read-granted one cannot", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const name = `${pkg.namespace}/${pkg.slug}`;
    const read = await createToken(user, [{ package: name, access: "read" }]);
    const write = await createToken(user, [{ package: name, access: "write" }]);
    await createDraft(write.token, pkg, "1.0.0");

    const bytes = text("payload");
    const refused = await withToken(read.token, `${packagePath(pkg)}/versions/1.0.0/assets/app.bin?sha256=${"0".repeat(64)}`, { method: "PUT", body: bytes as Uint8Array<ArrayBuffer> });
    expect(refused.status).toBe(403);
    expect((await uploadAsset(write.token, pkg, "1.0.0", "app.bin", bytes)).size).toBe(bytes.length);

    for (const token of [read, write])
      await user.json(`/api/registry/tokens/${token.id}`, { method: "DELETE" });
    await deletePackage(user, pkg);
  });
});
