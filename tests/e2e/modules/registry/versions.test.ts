import type { Envelope, VersionView } from "./helpers";
import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";
import {
  createDraft,
  createPackage,
  deletePackage,
  generateSigningKey,
  manifestOf,
  packagePath,
  publish,
  putAsset,
  refusal,
  registerKey,
  release,
  send,
  setChannel,
  sha256Hex,
  text,
  uploadAsset,
} from "./helpers";

interface VersionList { versions: VersionView[]; channels: { name: string; version: string }[] }

describe("/api/registry/packages/:ns/:pkg/versions — drafts, uploads, publish", () => {
  it("draft → upload → publish, after which the assets are immutable", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const base = packagePath(pkg);

    const draft = await createDraft(user, pkg, "1.0.0", "first release");
    expect(draft).toMatchObject({ version: "1.0.0", status: "draft", notes: "first release", assets: [] });
    expect(await refusal(await user.raw(`${base}/versions`, { method: "POST", body: { version: "1.0.0" } }))).toEqual({ status: 409, code: "VERSION_EXISTS" });
    for (const version of ["", ".hidden", "-flag", "has space", "a/b"])
      expect((await user.raw(`${base}/versions`, { method: "POST", body: { version } })).status).toBe(422);

    // Nothing to publish yet.
    expect(await refusal(await user.raw(`${base}/versions/1.0.0/publish`, { method: "POST", body: { channel: "stable" } }))).toEqual({ status: 409, code: "VERSION_EMPTY" });

    // 201 for a new asset, 200 when the same name is uploaded again.
    const first = await putAsset(user, pkg, "1.0.0", "app-linux-x64.tar.gz", text("first bytes"));
    expect(first.status).toBe(201);
    const bytes = text("final bytes");
    const second = await putAsset(user, pkg, "1.0.0", "app-linux-x64.tar.gz", bytes, { run: "./app serve", exec: "./app" });
    expect(second.status).toBe(200);
    expect(((await second.json()) as Envelope<unknown>).data).toMatchObject({
      name: "app-linux-x64.tar.gz",
      size: bytes.length,
      sha256: await sha256Hex(bytes),
      sig: null,
      key_id: null,
      alg: null,
      run: "./app serve",
      exec: "./app",
    });
    await uploadAsset(user, pkg, "1.0.0", "extra.txt", text("extra"));
    expect((await user.json<Envelope<{ name: string }>>(`${base}/versions/1.0.0/assets/extra.txt`, { method: "DELETE" })).data.name).toBe("extra.txt");
    expect((await user.raw(`${base}/versions/1.0.0/assets/extra.txt`, { method: "DELETE" })).status).toBe(404);

    // A draft is not in the feed.
    expect((await manifestOf(pkg)).versions).toEqual({});

    const published = await publish(user, pkg, "1.0.0");
    expect(published.status).toBe("published");
    expect(published.assets.map(a => a.name)).toEqual(["app-linux-x64.tar.gz"]);

    const one = await user.json<Envelope<{ version: VersionView; channels: VersionList["channels"] }>>(`${base}/versions/1.0.0`);
    expect(one.data.version.status).toBe("published");
    expect(one.data.channels.map(c => [c.name, c.version])).toEqual([["stable", "1.0.0"]]);
    const all = await user.json<Envelope<VersionList>>(`${base}/versions`);
    expect(all.data.versions.map(v => v.version)).toEqual(["1.0.0"]);

    // Published: nothing about its assets changes any more.
    expect(await refusal(await putAsset(user, pkg, "1.0.0", "app-linux-x64.tar.gz", text("tampered")))).toEqual({ status: 409, code: "VERSION_NOT_DRAFT" });
    expect(await refusal(await putAsset(user, pkg, "1.0.0", "new.bin", text("late")))).toEqual({ status: 409, code: "VERSION_NOT_DRAFT" });
    expect(await refusal(await user.raw(`${base}/versions/1.0.0/assets/app-linux-x64.tar.gz`, { method: "DELETE" }))).toEqual({ status: 409, code: "VERSION_NOT_DRAFT" });
    expect(await refusal(await user.raw(`${base}/versions/1.0.0/publish`, { method: "POST", body: { channel: "stable" } }))).toEqual({ status: 409, code: "VERSION_NOT_DRAFT" });

    await deletePackage(user, pkg);
  });

  it("refuses an upload that does not match what it declares, and stores nothing", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const base = packagePath(pkg);
    await createDraft(user, pkg, "1.0.0");
    const bytes = text("some bytes");
    const sha256 = await sha256Hex(bytes);
    const url = (asset: string, query = `sha256=${sha256}`) => `${base}/versions/1.0.0/assets/${asset}?${query}`;

    // The digest: required, lowercase hex, and the one of the body.
    expect((await send(user, "PUT", `${base}/versions/1.0.0/assets/app.bin`, bytes as Uint8Array<ArrayBuffer>)).status).toBe(422);
    expect((await send(user, "PUT", url("app.bin", `sha256=${sha256.toUpperCase()}`), bytes as Uint8Array<ArrayBuffer>)).status).toBe(422);
    expect(await refusal(await putAsset(user, pkg, "1.0.0", "app.bin", bytes, { sha256: "0".repeat(64) }))).toEqual({ status: 422, code: "DIGEST_MISMATCH" });

    // The body: not empty, and of a declared length.
    expect((await send(user, "PUT", url("app.bin"), new Uint8Array(0))).status).toBe(422);
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    expect(await refusal(await send(user, "PUT", url("app.bin"), chunked))).toEqual({ status: 411, code: "LENGTH_REQUIRED" });

    // The names: lode's id rule for the asset, an existing draft for the version.
    expect((await send(user, "PUT", url(".hidden"), bytes as Uint8Array<ArrayBuffer>)).status).toBe(422);
    expect((await send(user, "PUT", url("app.bin", `sha256=${sha256}&run=%20`), bytes as Uint8Array<ArrayBuffer>)).status).toBe(422);
    expect((await send(user, "PUT", `${base}/versions/9.9.9/assets/app.bin?sha256=${sha256}`, bytes as Uint8Array<ArrayBuffer>)).status).toBe(404);

    // None of the refused uploads left an asset behind, and the connection
    // each refusal came back on still serves the next request.
    const version = await user.json<Envelope<{ version: VersionView }>>(`${base}/versions/1.0.0`);
    expect(version.data.version.assets).toEqual([]);

    await deletePackage(user, pkg);
  });

  it("verifies a signature against the package's active keys before storing it", async () => {
    const user = await getClient("user@example.com");
    const key = await generateSigningKey();
    const pkg = await createPackage(user, { require_signature: true });
    const registered = await registerKey(user, pkg, key.publicKey);
    await createDraft(user, pkg, "1.0.0");
    const bytes = text("signed bytes");
    const sha256 = await sha256Hex(bytes);

    // The signature names the package slug as the app, and the asset filename.
    const sig = await key.sign({ app: pkg.slug, name: "app.bin", version: "1.0.0", sha256, run: "./app serve" });
    const asset = await uploadAsset(user, pkg, "1.0.0", "app.bin", bytes, { sig, run: "./app serve" });
    expect(asset).toMatchObject({ sig, key_id: key.keyId, alg: "ed25519", run: "./app serve" });

    // Anything the signature binds, changed: the name, the version's digest, `run`, `exec`.
    expect(await refusal(await putAsset(user, pkg, "1.0.0", "other.bin", bytes, { sig, run: "./app serve" }))).toEqual({ status: 400, code: "INVALID_SIGNATURE" });
    expect(await refusal(await putAsset(user, pkg, "1.0.0", "app.bin", text("other bytes"), { sig, run: "./app serve" }))).toEqual({ status: 400, code: "INVALID_SIGNATURE" });
    expect(await refusal(await putAsset(user, pkg, "1.0.0", "app.bin", bytes, { sig, run: "./evil" }))).toEqual({ status: 400, code: "INVALID_SIGNATURE" });
    expect(await refusal(await putAsset(user, pkg, "1.0.0", "app.bin", bytes, { sig, run: "./app serve", exec: "./app" }))).toEqual({ status: 400, code: "INVALID_SIGNATURE" });
    // A signature by a key the owner never registered.
    const stranger = await generateSigningKey();
    const foreign = await stranger.sign({ app: pkg.slug, name: "app.bin", version: "1.0.0", sha256 });
    expect(await refusal(await putAsset(user, pkg, "1.0.0", "app.bin", bytes, { sig: foreign }))).toEqual({ status: 400, code: "INVALID_SIGNATURE" });
    // This package takes no unsigned asset.
    expect(await refusal(await putAsset(user, pkg, "1.0.0", "unsigned.bin", bytes))).toEqual({ status: 400, code: "SIGNATURE_REQUIRED" });

    // The manifest serves the signature as it was uploaded.
    await publish(user, pkg, "1.0.0");
    expect((await manifestOf(pkg)).versions["1.0.0"]?.assets).toEqual([
      { name: "app.bin", url: expect.stringContaining(`/r/${pkg.namespace}/${pkg.slug}/1.0.0/app.bin`), sha256, size: bytes.length, sig, key_id: key.keyId, alg: "ed25519", run: "./app serve" },
    ]);

    // A revoked key verifies nothing new.
    await user.json(`${packagePath(pkg)}/keys/${registered.id}`, { method: "DELETE" });
    await createDraft(user, pkg, "2.0.0");
    const later = await key.sign({ app: pkg.slug, name: "app.bin", version: "2.0.0", sha256 });
    expect(await refusal(await putAsset(user, pkg, "2.0.0", "app.bin", bytes, { sig: later }))).toEqual({ status: 400, code: "INVALID_SIGNATURE" });

    await deletePackage(user, pkg);
  });

  it("moves channel pointers, yanks and restores, and deletes versions no channel points at", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const base = packagePath(pkg);
    await release(user, pkg, "1.0.0", { name: "app.bin", bytes: text("one") });
    await release(user, pkg, "2.0.0", { name: "app.bin", bytes: text("two") });
    await createDraft(user, pkg, "3.0.0");

    // A pointer is created on first use and only takes a published version.
    const beta = await setChannel(user, pkg, "beta", "2.0.0");
    expect(((await beta.json()) as Envelope<{ name: string; version: string }>).data).toMatchObject({ name: "beta", version: "2.0.0" });
    expect(await refusal(await setChannel(user, pkg, "beta", "3.0.0"))).toEqual({ status: 409, code: "VERSION_NOT_PUBLISHED" });
    expect((await setChannel(user, pkg, "beta", "9.9.9")).status).toBe(404);
    expect((await setChannel(user, pkg, ".bad", "1.0.0")).status).toBe(422);

    // Roll `stable` back; 2.0.0 is still held by `beta`.
    expect((await setChannel(user, pkg, "stable", "1.0.0")).status).toBe(200);
    expect(await refusal(await user.raw(`${base}/versions/2.0.0/yank`, { method: "POST" }))).toEqual({ status: 409, code: "VERSION_IN_CHANNEL" });
    expect((await setChannel(user, pkg, "beta", "1.0.0")).status).toBe(200);

    const yanked = await user.json<Envelope<VersionView>>(`${base}/versions/2.0.0/yank`, { method: "POST" });
    expect(yanked.data.status).toBe("yanked");
    expect(Object.keys((await manifestOf(pkg)).versions)).toEqual(["1.0.0"]);
    expect(await refusal(await setChannel(user, pkg, "stable", "2.0.0"))).toEqual({ status: 409, code: "VERSION_NOT_PUBLISHED" });
    expect(await refusal(await user.raw(`${base}/versions/1.0.0/restore`, { method: "POST" }))).toEqual({ status: 409, code: "VERSION_NOT_YANKED" });
    const restored = await user.json<Envelope<VersionView>>(`${base}/versions/2.0.0/restore`, { method: "POST" });
    expect(restored.data.status).toBe("published");
    expect(Object.keys((await manifestOf(pkg)).versions).toSorted()).toEqual(["1.0.0", "2.0.0"]);

    // Deletion: a draft, a published version nothing points at — not one a channel holds.
    expect((await user.raw(`${base}/versions/3.0.0`, { method: "DELETE" })).status).toBe(200);
    expect(await refusal(await user.raw(`${base}/versions/1.0.0`, { method: "DELETE" }))).toEqual({ status: 409, code: "VERSION_IN_CHANNEL" });
    expect((await user.raw(`${base}/versions/2.0.0`, { method: "DELETE" })).status).toBe(200);
    expect((await user.raw(`${base}/versions/2.0.0`)).status).toBe(404);
    const left = await user.json<Envelope<VersionList>>(`${base}/versions`);
    expect(left.data.versions.map(v => v.version)).toEqual(["1.0.0"]);
    expect(left.data.channels.map(c => [c.name, c.version])).toEqual([["beta", "1.0.0"], ["stable", "1.0.0"]]);

    await deletePackage(user, pkg);
  });
});
