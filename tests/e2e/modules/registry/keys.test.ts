import type { Envelope } from "./helpers";
import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";
import { createPackage, createToken, deletePackage, generateSigningKey, packagePath, refusal, registerKey, withToken } from "./helpers";

interface KeyView { id: string; key_id: string; alg: string; public_key: string; revoked_at: string | null }

describe("/api/registry/packages/:ns/:pkg/keys — a package's signing keys", () => {
  it("registers a key under the id lode derives, lists it, and keeps a revoked id taken", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const keys = `${packagePath(pkg)}/keys`;
    const key = await generateSigningKey();

    // lode's `trusted_keys` form is accepted; the id in front is informational.
    const registered = await registerKey(user, pkg, `0000000000000000:${key.publicKey}`);
    expect(registered.key_id).toBe(key.keyId);

    const again = await user.raw(keys, { method: "POST", body: { public_key: key.publicKey, name: "again" } });
    expect(await refusal(again)).toEqual({ status: 409, code: "KEY_EXISTS" });

    const listed = (await user.json<Envelope<KeyView[]>>(keys)).data.find(k => k.id === registered.id);
    expect(listed).toMatchObject({ key_id: key.keyId, alg: "ed25519", public_key: key.publicKey, revoked_at: null });

    const revoked = await user.json<Envelope<KeyView>>(`${keys}/${registered.id}`, { method: "DELETE" });
    expect(revoked.data.revoked_at).not.toBeNull();
    // Revocation is final: the key cannot come back.
    const back = await user.raw(keys, { method: "POST", body: { public_key: key.publicKey, name: "back" } });
    expect(await refusal(back)).toEqual({ status: 409, code: "KEY_EXISTS" });

    // The same key is free on another package.
    const other = await createPackage(user);
    expect((await registerKey(user, other, key.publicKey)).key_id).toBe(key.keyId);
    await deletePackage(user, other);
    await deletePackage(user, pkg);
  });

  it("refuses anything that is not a 32-byte ed25519 key", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const keys = `${packagePath(pkg)}/keys`;
    for (const public_key of ["not base64 !!", "AAAA", `ecdsa-p256:${"A".repeat(44)}`]) {
      const res = await user.raw(keys, { method: "POST", body: { public_key, name: "bad" } });
      expect(await refusal(res)).toEqual({ status: 400, code: "INVALID_PUBLIC_KEY" });
    }
    const empty = await user.raw(keys, { method: "POST", body: { public_key: "", name: "bad" } });
    expect(empty.status).toBe(422);
    await deletePackage(user, pkg);
  });

  it("belongs to its package; a token lists with a read grant, registers with a write grant and never revokes", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const other = await createPackage(user, { visibility: "private" });
    const ref = `${pkg.namespace}/${pkg.slug}`;
    const keys = `${packagePath(pkg)}/keys`;
    const key = await registerKey(user, pkg, (await generateSigningKey()).publicKey);
    expect((await user.json<Envelope<KeyView[]>>(`${packagePath(other)}/keys`)).data).toEqual([]);

    const post = async (token: string, path: string) => await withToken(token, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_key: (await generateSigningKey()).publicKey, name: "ci" }),
    });

    const reader = await createToken(user, [{ package: ref, access: "read" }]);
    expect((await withToken(reader.token, keys)).status).toBe(200);
    expect((await post(reader.token, keys)).status).toBe(403);

    const writer = await createToken(user, [{ package: ref, access: "write" }]);
    expect((await withToken(writer.token, keys)).status).toBe(200);
    expect((await post(writer.token, keys)).status).toBe(201);
    // Its grant names one package: the other one is private and does not exist to it.
    expect((await post(writer.token, `${packagePath(other)}/keys`)).status).toBe(404);
    expect((await withToken(writer.token, `${keys}/${key.id}`, { method: "DELETE" })).status).toBe(403);

    await user.json(`/api/registry/tokens/${reader.id}`, { method: "DELETE" });
    await user.json(`/api/registry/tokens/${writer.id}`, { method: "DELETE" });
    await deletePackage(user, other);
    await deletePackage(user, pkg);
  });
});
