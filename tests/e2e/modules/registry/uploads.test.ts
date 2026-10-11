import type { AssetView, Envelope, VersionView } from "./helpers";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { getClient } from "../../lib/oidc";
import { createDraft, createPackage, createToken, deletePackage, feed, manifestOf, packagePath, publish, refusal, send } from "./helpers";

// The server fixes the part size, so a multipart upload has to be larger
// than one part to be one. The asset is generated per run under
// tests/e2e/.cache/ and removed afterwards.
const PART_SIZE = 64 * 1024 * 1024;
const ASSET_SIZE = PART_SIZE + 1024 * 1024;
const CACHE_DIR = resolve(import.meta.dir, "../../.cache");

interface Started { uploadId: string; partSize: number; partCount: number }

async function digestOf(stream: ReadableStream<Uint8Array>): Promise<{ sha256: string; size: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  for await (const chunk of stream) {
    hasher.update(chunk);
    size += chunk.length;
  }
  return { sha256: hasher.digest("hex"), size };
}

describe("/api/registry/uploads — multipart upload", () => {
  let work: string;
  let file: string;
  let sha256: string;

  beforeAll(async () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    work = mkdtempSync(join(CACHE_DIR, "registry-upload-"));
    file = join(work, "big.bin");
    // 64 KiB of random bytes, repeated: cheap to make, and not all zeroes.
    const block = crypto.getRandomValues(new Uint8Array(64 * 1024));
    const writer = Bun.file(file).writer();
    for (let written = 0; written < ASSET_SIZE; written += block.length)
      writer.write(block);
    await writer.end();
    ({ sha256 } = await digestOf(Bun.file(file).stream()));
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("uploads an asset above 64 MiB in two parts with a write-granted token and serves the same bytes", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    const base = packagePath(pkg);
    const ci = await createToken(user, [{ package: `${pkg.namespace}/${pkg.slug}`, access: "write" }]);
    await createDraft(ci.token, pkg, "1.0.0");
    const before = (await user.json<Envelope<{ usage: { storage_bytes: number } }>>("/api/registry/quota")).data.usage.storage_bytes;

    // The start contract is the plan's, camelCase.
    const start = await send(ci.token, "POST", `${base}/versions/1.0.0/uploads`, JSON.stringify({ asset: "big.bin", size: ASSET_SIZE, sha256, run: "./big" }), { "Content-Type": "application/json" });
    expect(start.status).toBe(201);
    const started = ((await start.json()) as Envelope<Started>).data;
    expect(started).toEqual({ uploadId: expect.any(String), partSize: PART_SIZE, partCount: 2 });
    const upload = `/api/registry/uploads/${started.uploadId}`;

    // The declared size is reserved against the quota from the start.
    const reserved = (await user.json<Envelope<{ usage: { storage_bytes: number } }>>("/api/registry/quota")).data.usage.storage_bytes;
    expect(reserved - before).toBe(ASSET_SIZE);

    // Not complete without its parts; a part has to be exactly its size.
    expect(await refusal(await send(ci.token, "POST", `${upload}/complete`))).toEqual({ status: 409, code: "UPLOAD_INCOMPLETE" });
    expect(await refusal(await send(ci.token, "PUT", `${upload}/parts/2`, new Uint8Array(16)))).toEqual({ status: 422, code: "INVALID_PART_SIZE" });
    expect(await refusal(await send(ci.token, "PUT", `${upload}/parts/3`, new Uint8Array(16)))).toEqual({ status: 422, code: "INVALID_PART_NUMBER" });
    expect((await send(ci.token, "PUT", `${upload}/parts/0`, new Uint8Array(16))).status).toBe(422);

    // Last part first: the order does not matter.
    const second = await send(ci.token, "PUT", `${upload}/parts/2`, Bun.file(file).slice(PART_SIZE));
    expect(second.status).toBe(200);
    expect(((await second.json()) as Envelope<unknown>).data).toEqual({ part_number: 2, size: ASSET_SIZE - PART_SIZE });
    expect(await refusal(await send(ci.token, "POST", `${upload}/complete`))).toEqual({ status: 409, code: "UPLOAD_INCOMPLETE" });
    expect((await send(ci.token, "PUT", `${upload}/parts/1`, Bun.file(file).slice(0, PART_SIZE))).status).toBe(200);

    const complete = await send(ci.token, "POST", `${upload}/complete`);
    expect(complete.status).toBe(201);
    expect(((await complete.json()) as Envelope<AssetView>).data).toMatchObject({ name: "big.bin", size: ASSET_SIZE, sha256, run: "./big", sig: null });
    // The upload is gone once it became an asset, and the reservation became usage.
    expect((await send(ci.token, "POST", `${upload}/complete`)).status).toBe(404);
    const stored = (await user.json<Envelope<{ usage: { storage_bytes: number } }>>("/api/registry/quota")).data.usage.storage_bytes;
    expect(stored - before).toBe(ASSET_SIZE);

    await publish(ci.token, pkg, "1.0.0");
    const listed = (await manifestOf(pkg)).versions["1.0.0"]?.assets[0];
    expect(listed).toMatchObject({ name: "big.bin", size: ASSET_SIZE, sha256, run: "./big" });
    const download = await fetch(listed!.url);
    expect(download.status).toBe(200);
    // The Bun server sends a streamed body chunked, so the length is only
    // on the HEAD answer here; on Workers the GET carries it too.
    expect((await fetch(listed!.url, { method: "HEAD" })).headers.get("content-length")).toBe(String(ASSET_SIZE));
    expect(await digestOf(download.body!)).toEqual({ sha256, size: ASSET_SIZE });

    await user.json(`/api/registry/tokens/${ci.id}`, { method: "DELETE" });
    await deletePackage(user, pkg);
    const after = (await user.json<Envelope<{ usage: { storage_bytes: number } }>>("/api/registry/quota")).data.usage.storage_bytes;
    expect(after).toBe(before);
  }, 120_000);

  it("rejects assembled bytes that do not match the digest declared at start", async () => {
    const user = await getClient("user@example.com");
    const pkg = await createPackage(user);
    await createDraft(user, pkg, "1.0.0");

    const start = await send(user, "POST", `${packagePath(pkg)}/versions/1.0.0/uploads`, JSON.stringify({ asset: "big.bin", size: ASSET_SIZE, sha256: "0".repeat(64) }), { "Content-Type": "application/json" });
    const { uploadId } = ((await start.json()) as Envelope<Started>).data;
    const upload = `/api/registry/uploads/${uploadId}`;
    expect((await send(user, "PUT", `${upload}/parts/1`, Bun.file(file).slice(0, PART_SIZE))).status).toBe(200);
    expect((await send(user, "PUT", `${upload}/parts/2`, Bun.file(file).slice(PART_SIZE))).status).toBe(200);

    expect(await refusal(await send(user, "POST", `${upload}/complete`))).toEqual({ status: 422, code: "DIGEST_MISMATCH" });
    // The upload is gone and no asset appeared.
    expect((await send(user, "POST", `${upload}/complete`)).status).toBe(404);
    const version = await user.json<Envelope<{ version: VersionView }>>(`${packagePath(pkg)}/versions/1.0.0`);
    expect(version.data.version.assets).toEqual([]);
    expect((await feed(`/${pkg.namespace}/${pkg.slug}/1.0.0/big.bin`)).status).toBe(404);

    await deletePackage(user, pkg);
  }, 120_000);

  it("checks a start like an upload, aborts on request, and never shows an upload to an outsider", async () => {
    const user = await getClient("user@example.com");
    const admin = await getClient("admin@example.com");
    const pkg = await createPackage(user);
    const base = packagePath(pkg);
    await createDraft(user, pkg, "1.0.0");
    const start = (body: Record<string, unknown>, caller = user) =>
      send(caller, "POST", `${base}/versions/1.0.0/uploads`, JSON.stringify({ asset: "big.bin", size: ASSET_SIZE, sha256, ...body }), { "Content-Type": "application/json" });

    expect((await start({ sha256: sha256.toUpperCase() })).status).toBe(422);
    expect((await start({ size: 0 })).status).toBe(422);
    expect((await start({ asset: "-bad" })).status).toBe(422);
    expect(await refusal(await start({ size: 500 * 1024 * 1024 + 1 }))).toEqual({ status: 413, code: "ASSET_TOO_LARGE" });
    expect(await refusal(await start({ sig: "AAAA" }))).toEqual({ status: 400, code: "INVALID_SIGNATURE" });

    const first = ((await (await start({})).json()) as Envelope<Started>).data;
    // Starting the same asset again gives the earlier upload up.
    const second = ((await (await start({})).json()) as Envelope<Started>).data;
    expect(second.uploadId).not.toBe(first.uploadId);
    expect((await send(user, "DELETE", `/api/registry/uploads/${first.uploadId}`)).status).toBe(404);

    // Another user's token gets the same 404 as an unknown id, even though the package is public.
    const outsider = await createToken(admin, { all: "admin" });
    for (const id of [second.uploadId, "does-not-exist"]) {
      expect((await send(outsider.token, "DELETE", `/api/registry/uploads/${id}`)).status).toBe(404);
      expect((await send(outsider.token, "PUT", `/api/registry/uploads/${id}/parts/1`, new Uint8Array(16))).status).toBe(404);
      expect((await send(outsider.token, "POST", `/api/registry/uploads/${id}/complete`)).status).toBe(404);
    }
    await admin.json(`/api/registry/tokens/${outsider.id}`, { method: "DELETE" });

    const aborted = await send(user, "DELETE", `/api/registry/uploads/${second.uploadId}`);
    expect(aborted.status).toBe(200);
    expect((await send(user, "PUT", `/api/registry/uploads/${second.uploadId}/parts/1`, new Uint8Array(16))).status).toBe(404);

    await deletePackage(user, pkg);
  });
});
