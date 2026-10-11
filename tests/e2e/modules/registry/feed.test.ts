import type { ApiClient } from "../../lib/api";
import type { PackageView } from "./helpers";
import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";
import { createDraft, createPackage, createToken, deletePackage, feed, FEED_BASE, manifestOf, packagePath, release, sha256Hex, text, uploadAsset } from "./helpers";

const NOT_FOUND = { success: false, error: { code: "NOT_FOUND", message: "Not found" } };

async function expectNotFound(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual(NOT_FOUND);
}

function feedPath(pkg: PackageView, rest: string): string {
  return `/${pkg.namespace}/${pkg.slug}/${rest}`;
}

describe("/r — the read feed lode polls", () => {
  it("serves the lode/v1 manifest of a public package anonymously, with an ETag", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const one = text("version one");
    const two = text("version two");
    await createDraft(user, pkg, "1.0.0", "notes of 1.0.0");
    await uploadAsset(user, pkg, "1.0.0", "app-linux-x64.tar.gz", one);
    await uploadAsset(user, pkg, "1.0.0", "app-darwin-arm64.tar.gz", one, { run: "./app serve", exec: "./app" });
    await user.json(`${packagePath(pkg)}/versions/1.0.0/publish`, { method: "POST", body: { channel: "stable" } });
    await release(user, pkg, "2.0.0-rc.1", { name: "app-linux-x64.tar.gz", bytes: two }, "beta");
    // A draft never shows.
    await createDraft(user, pkg, "3.0.0");
    await uploadAsset(user, pkg, "3.0.0", "app-linux-x64.tar.gz", text("unreleased"));

    const res = await feed(feedPath(pkg, "manifest.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const base = `${FEED_BASE}/${pkg.namespace}/${pkg.slug}`;
    expect(await res.json()).toEqual({
      schema: "lode/v1",
      // The package slug: what the operator sets as `[global].app`.
      name: pkg.slug,
      channels: { beta: { latest: "2.0.0-rc.1" }, stable: { latest: "1.0.0" } },
      versions: {
        "1.0.0": {
          notes: "notes of 1.0.0",
          assets: [
            { name: "app-darwin-arm64.tar.gz", url: `${base}/1.0.0/app-darwin-arm64.tar.gz`, sha256: await sha256Hex(one), size: one.length, run: "./app serve", exec: "./app" },
            { name: "app-linux-x64.tar.gz", url: `${base}/1.0.0/app-linux-x64.tar.gz`, sha256: await sha256Hex(one), size: one.length },
          ],
        },
        "2.0.0-rc.1": {
          assets: [{ name: "app-linux-x64.tar.gz", url: `${base}/2.0.0-rc.1/app-linux-x64.tar.gz`, sha256: await sha256Hex(two), size: two.length }],
        },
      },
    });

    // Revalidation: unchanged is a 304, a new release changes the tag.
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const unchanged = await feed(feedPath(pkg, "manifest.json"), undefined, { "If-None-Match": etag });
    expect(unchanged.status).toBe(304);
    await user.json(`${packagePath(pkg)}/versions/3.0.0/publish`, { method: "POST", body: { channel: "stable" } });
    const changed = await feed(feedPath(pkg, "manifest.json"), undefined, { "If-None-Match": etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);

    await deletePackage(user, pkg);
    await expectNotFound(await feed(feedPath(pkg, "manifest.json")));
  });

  it("downloads the assets of published versions only", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const bytes = crypto.getRandomValues(new Uint8Array(200_000));
    await release(user, pkg, "1.0.0", { name: "app.bin", bytes });
    await release(user, pkg, "2.0.0", { name: "app.bin", bytes: text("two") });
    await createDraft(user, pkg, "3.0.0");
    await uploadAsset(user, pkg, "3.0.0", "app.bin", text("draft"));

    const url = (await manifestOf(pkg)).versions["1.0.0"]!.assets[0]!.url;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));

    // A draft's asset, an unknown asset, an unknown version, an unknown package.
    await expectNotFound(await feed(feedPath(pkg, "3.0.0/app.bin")));
    await expectNotFound(await feed(feedPath(pkg, "1.0.0/other.bin")));
    await expectNotFound(await feed(feedPath(pkg, "9.9.9/app.bin")));
    await expectNotFound(await feed(`/${pkg.namespace}/does-not-exist/1.0.0/app.bin`));
    await expectNotFound(await feed("/zzzzzzzz/does-not-exist/manifest.json"));

    // A yanked version leaves the manifest and stops downloading.
    await user.json(`${packagePath(pkg)}/versions/1.0.0/yank`, { method: "POST" });
    expect(Object.keys((await manifestOf(pkg)).versions)).toEqual(["2.0.0"]);
    await expectNotFound(await fetch(url));
    await user.json(`${packagePath(pkg)}/versions/1.0.0/restore`, { method: "POST" });
    expect((await fetch(url)).status).toBe(200);

    await deletePackage(user, pkg);
  });

  it("serves a private package only to a token with a read grant on it", async () => {
    const user = await getClient("user@example.com");
    const admin: ApiClient = await getClient("admin@example.com");
    const pkg = await createPackage(user, { visibility: "private" });
    const other = await createPackage(user, { visibility: "private" });
    const bytes = text("private bytes");
    await release(user, pkg, "1.0.0", { name: "app.bin", bytes });

    const reader = await createToken(user, [{ package: `${pkg.namespace}/${pkg.slug}`, access: "read" }]);
    const elsewhere = await createToken(user, [{ package: `${other.namespace}/${other.slug}`, access: "admin" }]);
    const stranger = await createToken(admin, { all: "admin" });

    for (const path of ["manifest.json", "1.0.0/app.bin"]) {
      // Anonymous, a session cookie, a token granted on another package,
      // another user's token, a made-up token: all the 404 of an unknown package.
      await expectNotFound(await feed(feedPath(pkg, path)));
      await expectNotFound(await feed(feedPath(pkg, path), undefined, { Cookie: user.cookies.header() }));
      await expectNotFound(await feed(feedPath(pkg, path), elsewhere.token));
      await expectNotFound(await feed(feedPath(pkg, path), stranger.token));
      await expectNotFound(await feed(feedPath(pkg, path), "pat_made_up"));

      const res = await feed(feedPath(pkg, path), reader.token);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("etag")).toBeNull();
    }
    const manifest = await manifestOf(pkg, reader.token);
    expect(manifest.name).toBe(pkg.slug);
    const download = await fetch(manifest.versions["1.0.0"]!.assets[0]!.url, { headers: { Authorization: `Bearer ${reader.token}` } });
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);

    // Revoked, the token reads nothing; made public, the package needs none.
    await user.json(`/api/registry/tokens/${reader.id}`, { method: "DELETE" });
    await expectNotFound(await feed(feedPath(pkg, "manifest.json"), reader.token));
    await user.json(packagePath(pkg), { method: "PATCH", body: { visibility: "public" } });
    expect((await feed(feedPath(pkg, "manifest.json"))).status).toBe(200);

    await user.json(`/api/registry/tokens/${elsewhere.id}`, { method: "DELETE" });
    await admin.json(`/api/registry/tokens/${stranger.id}`, { method: "DELETE" });
    await deletePackage(user, pkg);
    await deletePackage(user, other);
  });

  it("is read only", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    await release(user, pkg, "1.0.0", { name: "app.bin", bytes: text("one") });
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await fetch(`${FEED_BASE}${feedPath(pkg, "manifest.json")}`, { method });
      expect(res.status).toBe(404);
    }
    await deletePackage(user, pkg);
  });
});
