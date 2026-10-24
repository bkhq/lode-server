import type { ApiClient } from "../../lib/api";
import type { Envelope, PackageView, VersionView } from "./helpers";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import process from "node:process";
import { API_BASE } from "../../lib/api";
import { getClient } from "../../lib/oidc";
import { createDraft, createPackage, createToken, deletePackage, manifestOf, packagePath, registerKey, sha256Hex, text } from "./helpers";

// `scripts/publish.sh` — what a publisher's CI runs — driven as a subprocess
// against the live API: draft, upload (single request and multipart), publish.
// Every case asserts on the script's exit status and output, and on what the
// management API and the read feed show afterwards.

const SCRIPT = resolve(import.meta.dir, "../../../../scripts/publish.sh");
const CACHE_DIR = resolve(import.meta.dir, "../../.cache");
// Resolved once: one case runs the script with a PATH that has no lode-cli on it.
const BASH = Bun.which("bash") ?? "bash";

// One asset just above the single-request limit, so the script has to take
// the multipart path: two parts at the server's 64 MiB part size.
const SINGLE_REQUEST_MAX = 95 * 1024 * 1024;
const BIG_SIZE = SINGLE_REQUEST_MAX + 1024 * 1024;

// The signing case needs `lode-cli`; it is looked for the way lode.test.ts
// does it: `E2E_LODE_BIN`, the cached binary of an earlier run, or the local
// image `bkhq/lode:v0.1.0-mini`. With none of them that one case is skipped.
const LODE_DIR = join(CACHE_DIR, "lode-v0.1.0");
const LODE_IMAGE = "bkhq/lode:v0.1.0-mini";

function runs(bin: string): boolean {
  try {
    return Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  }
  catch {
    return false;
  }
}

function docker(...args: string[]): boolean {
  try {
    return Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  }
  catch {
    return false;
  }
}

/** Copy `/usr/bin/lode` out of the image; the container is created, never started, and removed. */
function extractFromImage(target: string): boolean {
  if (!docker("image", "inspect", LODE_IMAGE))
    return false;
  const container = `ai-agent-lode-server-e2e-publish-${process.pid}`;
  if (!docker("create", "--label", "ai-agent=true", "--name", container, LODE_IMAGE))
    return false;
  try {
    mkdirSync(LODE_DIR, { recursive: true });
    return docker("cp", `${container}:/usr/bin/lode`, target);
  }
  finally {
    docker("rm", "-f", container);
  }
}

function locateLode(): string | undefined {
  const fromEnv = process.env.E2E_LODE_BIN;
  if (fromEnv)
    return runs(fromEnv) ? resolve(fromEnv) : undefined;
  const cached = join(LODE_DIR, "lode");
  if (runs(cached) || (extractFromImage(cached) && runs(cached)))
    return cached;
  return undefined;
}

const LODE = locateLode();
// CI pulls the image: a missing binary there is a broken pipeline, not a skip.
if (!LODE && process.env.CI)
  throw new Error(`[registry/publish] no lode binary: the image ${LODE_IMAGE} is not available to docker`);
if (!LODE)
  console.warn(`[registry/publish] signing case SKIPPED: no lode binary. Set E2E_LODE_BIN, or make the image ${LODE_IMAGE} available to docker.`);

// `lode-cli` is the same binary under another name; the script finds it on PATH.
const LODE_CLI = join(LODE_DIR, "lode-cli");
// Re-pointed when it links to another binary than the one located.
if (LODE && !(existsSync(LODE_CLI) && realpathSync(LODE_CLI) === realpathSync(LODE))) {
  mkdirSync(LODE_DIR, { recursive: true });
  rmSync(LODE_CLI, { force: true });
  symlinkSync(LODE, LODE_CLI);
}

async function digestOf(stream: ReadableStream<Uint8Array>): Promise<{ sha256: string; size: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0;
  for await (const chunk of stream) {
    hasher.update(chunk);
    size += chunk.length;
  }
  return { sha256: hasher.digest("hex"), size };
}

interface Run { exitCode: number; stdout: string; stderr: string; output: string }

/** Run the script the way a CI step does: arguments on the command line, secrets in the environment only. */
async function publishSh(args: string[], env: Record<string, string> = {}, shellFlags: string[] = []): Promise<Run> {
  // Whatever the developer's shell exports must not leak into the case.
  const { LODE_REGISTRY_TOKEN: _token, LODE_SIGNING_KEY: _key, ...inherited } = process.env;
  const proc = Bun.spawn([BASH, ...shellFlags, SCRIPT, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr, output: `${stdout}${stderr}` };
}

/** Run `lode-cli publish` the way a CI step does: arguments on the command line, secrets in the environment only. */
async function lodeCliPublish(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const { LODE_REGISTRY_TOKEN: _token, LODE_SIGNING_KEY: _key, ...inherited } = process.env;
  const proc = Bun.spawn([LODE_CLI, "publish", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, NO_COLOR: "1", ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr, output: `${stdout}${stderr}` };
}

describe("scripts/publish.sh against the live registry", () => {
  let user: ApiClient;
  let work: string;
  const packages: PackageView[] = [];

  async function newPackage(input: Parameters<typeof createPackage>[1] = {}): Promise<{ pkg: PackageView; ref: string; token: string }> {
    const pkg = await createPackage(user, input);
    packages.push(pkg);
    const ref = `${pkg.namespace}/${pkg.slug}`;
    // What a publisher stores as the CI secret: `write` on this one package.
    const { token } = await createToken(user, [{ package: ref, access: "write" }]);
    return { pkg, ref, token };
  }

  async function versionsOf(pkg: PackageView): Promise<VersionView[]> {
    return (await user.json<Envelope<{ versions: VersionView[] }>>(`${packagePath(pkg)}/versions`)).data.versions;
  }

  async function versionOf(pkg: PackageView, version: string): Promise<VersionView> {
    return (await user.json<Envelope<{ version: VersionView }>>(`${packagePath(pkg)}/versions/${version}`)).data.version;
  }

  function file(dir: string, name: string, bytes: Uint8Array): string {
    mkdirSync(join(work, dir), { recursive: true });
    const path = join(work, dir, name);
    writeFileSync(path, bytes);
    return path;
  }

  beforeAll(async () => {
    user = await getClient("user@example.com");
    mkdirSync(CACHE_DIR, { recursive: true });
    // Per-run scratch: the generated assets and the publisher's private key.
    work = mkdtempSync(join(CACHE_DIR, "registry-publish-"));
  });

  afterAll(async () => {
    for (const pkg of packages)
      await deletePackage(user, pkg);
    rmSync(work, { recursive: true, force: true });
  });

  it("releases a small asset and one above the single-request limit (multipart) to a channel", async () => {
    const { pkg, ref, token } = await newPackage();

    const small = text("#!/bin/sh\necho demo 1.0.0\n");
    const smallFile = file("release", "demo.sh", small);
    // Deterministic content: the same 64 KiB block throughout, stamped with
    // its index so no two blocks — and no two parts — are alike.
    const bigFile = join(work, "release", "demo-linux-x64.tar.gz");
    const block = new Uint8Array(64 * 1024);
    for (let i = 0; i < block.length; i++)
      block[i] = (i * 31 + 7) & 0xFF;
    const stamp = new DataView(block.buffer);
    const writer = Bun.file(bigFile).writer();
    for (let index = 0; index * block.length < BIG_SIZE; index++) {
      stamp.setUint32(0, index);
      writer.write(block.slice());
    }
    await writer.end();
    const big = await digestOf(Bun.file(bigFile).stream());
    expect(big.size).toBe(BIG_SIZE);

    const run = await publishSh(
      ["--registry", API_BASE, "--package", ref, "--version", "1.0.0", "--channel", "beta", "--notes", "First release", smallFile, bigFile],
      { LODE_REGISTRY_TOKEN: token },
    );
    expect(run.output).not.toContain(token);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    // The large asset went up in the parts the server asked for.
    expect(run.stdout).toContain("demo-linux-x64.tar.gz: part 2/2");
    expect(run.stdout).not.toContain("demo.sh: part");

    // Management API: published, both assets as sent, unsigned.
    const version = await versionOf(pkg, "1.0.0");
    expect(version).toMatchObject({ version: "1.0.0", status: "published", notes: "First release" });
    expect(version.assets.map(asset => ({ name: asset.name, size: asset.size, sha256: asset.sha256, sig: asset.sig })).toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "demo-linux-x64.tar.gz", size: BIG_SIZE, sha256: big.sha256, sig: null },
      { name: "demo.sh", size: small.length, sha256: await sha256Hex(small), sig: null },
    ]);

    // Read feed: the channel asked for points at the version, and only that channel.
    const manifest = await manifestOf(pkg);
    expect(manifest.channels).toEqual({ beta: { latest: "1.0.0" } });
    const listed = manifest.versions["1.0.0"]!.assets;
    expect(listed.find(asset => asset.name === "demo.sh")).toMatchObject({ size: small.length, sha256: await sha256Hex(small) });
    const bigListed = listed.find(asset => asset.name === "demo-linux-x64.tar.gz")!;
    expect(bigListed).toMatchObject({ size: BIG_SIZE, sha256: big.sha256 });
    const download = await fetch(bigListed.url);
    expect(download.status).toBe(200);
    expect(await digestOf(download.body!)).toEqual(big);

    // A published version is immutable: the same release again is refused, clearly.
    const again = await publishSh(["--registry", API_BASE, "--package", ref, "--version", "1.0.0", smallFile], { LODE_REGISTRY_TOKEN: token });
    expect(again.exitCode).not.toBe(0);
    expect(again.stderr).toContain("already published");
    expect(again.output).not.toContain(token);
    expect((await manifestOf(pkg)).channels).toEqual({ beta: { latest: "1.0.0" } });
  }, 180_000);

  it("continues into an existing draft, replacing a same-named asset, and defaults to the stable channel", async () => {
    const { pkg, ref, token } = await newPackage();
    // What a failed CI job leaves behind: the draft and a stale asset.
    await createDraft(token, pkg, "2.0.0");
    const stale = file("retry-stale", "demo.sh", text("stale\n"));
    const first = await publishSh(["--registry", API_BASE, "--package", ref, "--version", "2.0.0", stale, join(work, "retry-stale", "missing.bin")], { LODE_REGISTRY_TOKEN: token });
    // A file that does not exist stops the run before anything is sent.
    expect(first.exitCode).not.toBe(0);
    expect((await versionOf(pkg, "2.0.0")).assets).toEqual([]);

    const fresh = text("fresh\n");
    const run = await publishSh(["--registry", `${API_BASE}/`, "--package", ref, "--version", "2.0.0", file("retry", "demo.sh", fresh)], { LODE_REGISTRY_TOKEN: token });
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);

    const manifest = await manifestOf(pkg);
    expect(manifest.channels).toEqual({ stable: { latest: "2.0.0" } });
    expect(manifest.versions["2.0.0"]!.assets).toMatchObject([{ name: "demo.sh", size: fresh.length, sha256: await sha256Hex(fresh) }]);
  }, 60_000);

  it.skipIf(!LODE)("signs every asset with lode-cli when LODE_SIGNING_KEY is set", async () => {
    // Publisher side: a key from `lode-cli keygen`, its public half registered.
    const keygen = Bun.spawnSync([LODE_CLI, "keygen", "--out", join(work, "publisher")], { stdout: "pipe", stderr: "pipe" });
    expect(keygen.exitCode).toBe(0);
    const trustedKey = /^trustedKeys:\s+(\S+)/m.exec(keygen.stdout.toString())![1]!;
    // The seed is what a publisher stores as the LODE_SIGNING_KEY secret.
    const seed = readFileSync(join(work, "publisher.key"), "utf-8").trim();

    // The package refuses unsigned uploads, so an asset sent without `sig` would fail the run.
    const { pkg, ref, token } = await newPackage({ require_signature: true });
    const { key_id: keyId } = await registerKey(user, pkg, trustedKey);
    const bytes = text("#!/bin/sh\necho signed\n");
    const run = await publishSh(
      ["--registry", API_BASE, "--package", ref, "--version", "1.0.0", file("signed", "demo.sh", bytes), file("signed", "demo.txt", text("notes\n"))],
      { LODE_REGISTRY_TOKEN: token, LODE_SIGNING_KEY: seed, PATH: `${LODE_DIR}${delimiter}${process.env.PATH}` },
    );
    expect(run.output).not.toContain(token);
    expect(run.output).not.toContain(seed);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);

    const assets = (await manifestOf(pkg)).versions["1.0.0"]!.assets;
    expect(assets.map(asset => asset.name).toSorted()).toEqual(["demo.sh", "demo.txt"]);
    for (const asset of assets) {
      expect(asset.sig).toEqual(expect.any(String));
      expect(asset).toMatchObject({ key_id: keyId, alg: "ed25519" });
    }

    // The key is set but lode-cli is not installed: an error, not an unsigned upload.
    const bare = join(work, "bare-bin");
    mkdirSync(bare);
    for (const tool of ["bash", "env", "curl", "jq", "sha256sum", "dd", "wc", "tr", "cut", "awk", "mktemp", "rm", "basename"]) {
      const found = Bun.which(tool);
      if (found)
        symlinkSync(found, join(bare, tool));
    }
    const unsigned = await publishSh(
      ["--registry", API_BASE, "--package", ref, "--version", "2.0.0", file("signed", "demo.sh", bytes)],
      { LODE_REGISTRY_TOKEN: token, LODE_SIGNING_KEY: seed, PATH: bare },
    );
    expect(unsigned.exitCode).not.toBe(0);
    expect(unsigned.stderr).toContain("lode-cli");
    expect(unsigned.output).not.toContain(seed);
    expect((await versionsOf(pkg)).map(version => version.version)).toEqual(["1.0.0"]);
  }, 60_000);

  it.skipIf(!LODE)("derives the public key from the seed and registers it for the package", async () => {
    // Nothing is registered by hand and the pipeline holds the seed only.
    const keygen = Bun.spawnSync([LODE_CLI, "keygen", "--out", join(work, "pipeline")], { stdout: "pipe", stderr: "pipe" });
    expect(keygen.exitCode).toBe(0);
    const trustedKey = /^trustedKeys:\s+(\S+)/m.exec(keygen.stdout.toString())![1]!;
    const seed = readFileSync(join(work, "pipeline.key"), "utf-8").trim();

    const { pkg, ref, token } = await newPackage({ require_signature: true });
    const env = { LODE_REGISTRY_TOKEN: token, LODE_SIGNING_KEY: seed, PATH: `${LODE_DIR}${delimiter}${process.env.PATH}` };
    const first = await publishSh(["--registry", API_BASE, "--package", ref, "--version", "1.0.0", file("selfkey", "demo.sh", text("one\n"))], env);
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("registered signing key");
    expect(first.output).not.toContain(seed);

    // The next release finds the key in place.
    const second = await publishSh(["--registry", API_BASE, "--package", ref, "--version", "2.0.0", file("selfkey2", "demo.sh", text("two\n"))], env);
    expect(second.stderr).toBe("");
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("signing key already registered");

    const manifest = await manifestOf(pkg);
    const keyId = trustedKey.split(":")[0]!;
    for (const version of ["1.0.0", "2.0.0"])
      expect(manifest.versions[version]!.assets).toMatchObject([{ name: "demo.sh", key_id: keyId, alg: "ed25519" }]);
  }, 60_000);

  it("fails without creating anything when the token is missing or has no grant on the package, and never prints it", async () => {
    const { pkg, ref } = await newPackage();
    const { token: stranger } = await newPackage();
    const asset = file("refused", "demo.sh", text("refused\n"));
    const args = ["--registry", API_BASE, "--package", ref, "--version", "1.0.0", asset];

    const missing = await publishSh(args);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("LODE_REGISTRY_TOKEN");
    expect(missing.stdout).toBe("");

    // A valid token, granted on another package only. Traced with `bash -x`,
    // as a publisher debugging the step would: the token still must not show.
    const refused = await publishSh(args, { LODE_REGISTRY_TOKEN: stranger }, ["-x"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/HTTP 40[34]/);
    expect(refused.output).not.toContain(stranger);

    // The token is not accepted on the command line either.
    const asArgument = await publishSh([...args, "--token", stranger]);
    expect(asArgument.exitCode).not.toBe(0);
    expect(asArgument.output).not.toContain(stranger);

    expect(await versionsOf(pkg)).toEqual([]);
  }, 60_000);
  // The same releases through `lode-cli publish`, the command that does in
  // one binary what the script does with curl and jq. The API base is on
  // loopback, so plain http needs no flag.

  it.skipIf(!LODE)("lode-cli publish: a small asset and a multipart one, to a channel; a published version is refused", async () => {
    const { pkg, ref, token } = await newPackage();

    const small = text("#!/bin/sh\necho cli 1.0.0\n");
    const smallFile = file("cli-release", "demo.sh", small);
    const bigFile = join(work, "cli-release", "demo-linux-x64.tar.gz");
    const block = new Uint8Array(64 * 1024);
    for (let i = 0; i < block.length; i++)
      block[i] = (i * 17 + 3) & 0xFF;
    const stamp = new DataView(block.buffer);
    const writer = Bun.file(bigFile).writer();
    for (let index = 0; index * block.length < BIG_SIZE; index++) {
      stamp.setUint32(0, index);
      writer.write(block.slice());
    }
    await writer.end();
    const big = await digestOf(Bun.file(bigFile).stream());

    const run = await lodeCliPublish(
      ["--registry", API_BASE, "--package", ref, "--version", "1.0.0", "--channel", "beta", "--notes", "First release", smallFile, bigFile],
      { LODE_REGISTRY_TOKEN: token },
    );
    expect(run.output).not.toContain(token);
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);

    const version = await versionOf(pkg, "1.0.0");
    expect(version).toMatchObject({ version: "1.0.0", status: "published", notes: "First release" });
    expect(version.assets.map(asset => ({ name: asset.name, size: asset.size, sha256: asset.sha256, sig: asset.sig })).toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "demo-linux-x64.tar.gz", size: BIG_SIZE, sha256: big.sha256, sig: null },
      { name: "demo.sh", size: small.length, sha256: await sha256Hex(small), sig: null },
    ]);

    const manifest = await manifestOf(pkg);
    expect(manifest.channels).toEqual({ beta: { latest: "1.0.0" } });
    const bigListed = manifest.versions["1.0.0"]!.assets.find(asset => asset.name === "demo-linux-x64.tar.gz")!;
    const download = await fetch(bigListed.url);
    expect(download.status).toBe(200);
    expect(await digestOf(download.body!)).toEqual(big);

    const again = await lodeCliPublish(["--registry", API_BASE, "--package", ref, "--version", "1.0.0", smallFile], { LODE_REGISTRY_TOKEN: token });
    expect(again.exitCode).not.toBe(0);
    expect(again.output).not.toContain(token);
    expect((await manifestOf(pkg)).channels).toEqual({ beta: { latest: "1.0.0" } });
  }, 180_000);

  it.skipIf(!LODE)("lode-cli publish: continues into an existing draft and defaults to the stable channel", async () => {
    const { pkg, ref, token } = await newPackage();
    await createDraft(token, pkg, "2.0.0");

    const missing = await lodeCliPublish(["--registry", API_BASE, "--package", ref, "--version", "2.0.0", join(work, "cli-retry", "missing.bin")], { LODE_REGISTRY_TOKEN: token });
    expect(missing.exitCode).not.toBe(0);
    expect((await versionOf(pkg, "2.0.0")).assets).toEqual([]);

    const fresh = text("fresh from the cli\n");
    const run = await lodeCliPublish(["--registry", `${API_BASE}/`, "--package", ref, "--version", "2.0.0", file("cli-retry", "demo.sh", fresh)], { LODE_REGISTRY_TOKEN: token });
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);

    const manifest = await manifestOf(pkg);
    expect(manifest.channels).toEqual({ stable: { latest: "2.0.0" } });
    expect(manifest.versions["2.0.0"]!.assets).toMatchObject([{ name: "demo.sh", size: fresh.length, sha256: await sha256Hex(fresh) }]);
  }, 60_000);

  it.skipIf(!LODE)("lode-cli publish: signs with --key-env and registers the public key for the package itself", async () => {
    const keygen = Bun.spawnSync([LODE_CLI, "keygen", "--out", join(work, "cli-pipeline")], { stdout: "pipe", stderr: "pipe" });
    expect(keygen.exitCode).toBe(0);
    const trustedKey = /^trustedKeys:\s+(\S+)/m.exec(keygen.stdout.toString())![1]!;
    const seed = readFileSync(join(work, "cli-pipeline.key"), "utf-8").trim();

    // The package refuses unsigned uploads and no key is registered by hand.
    const { pkg, ref, token } = await newPackage({ require_signature: true });
    const env = { LODE_REGISTRY_TOKEN: token, LODE_SIGNING_KEY: seed };

    const unsigned = await lodeCliPublish(["--registry", API_BASE, "--package", ref, "--version", "0.9.0", file("cli-unsigned", "demo.sh", text("zero\n"))], { LODE_REGISTRY_TOKEN: token });
    expect(unsigned.exitCode).not.toBe(0);
    expect(unsigned.stderr).toContain("SIGNATURE_REQUIRED");

    for (const [version, body] of [["1.0.0", "one\n"], ["2.0.0", "two\n"]] as const) {
      const run = await lodeCliPublish(["--registry", API_BASE, "--package", ref, "--version", version, "--key-env", "LODE_SIGNING_KEY", file(`cli-signed-${version}`, "demo.sh", text(body))], env);
      expect(run.output).not.toContain(seed);
      expect(run.output).not.toContain(token);
      expect(run.stderr).toBe("");
      expect(run.exitCode).toBe(0);
    }

    const manifest = await manifestOf(pkg);
    // A lode with manifest commits signs the manifest too: one commit per release.
    if (manifest.generation !== undefined)
      expect(manifest.generation).toBe(2);
    const keyId = trustedKey.split(":")[0]!;
    for (const version of ["1.0.0", "2.0.0"]) {
      const assets = manifest.versions[version]!.assets;
      expect(assets).toMatchObject([{ name: "demo.sh", key_id: keyId, alg: "ed25519" }]);
      expect(assets[0]!.sig).toEqual(expect.any(String));
    }
    expect(Object.keys(manifest.versions).toSorted()).toEqual(["1.0.0", "2.0.0"]);
  }, 60_000);

  it.skipIf(!LODE)("lode-cli publish: fails without creating anything when the token is missing or has no grant, and never prints it", async () => {
    const { pkg, ref } = await newPackage();
    const { token: stranger } = await newPackage();
    const args = ["--registry", API_BASE, "--package", ref, "--version", "1.0.0", file("cli-refused", "demo.sh", text("refused\n"))];

    const missing = await lodeCliPublish(args);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("LODE_REGISTRY_TOKEN");

    const refused = await lodeCliPublish(args, { LODE_REGISTRY_TOKEN: stranger });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/40[34]/);
    expect(refused.output).not.toContain(stranger);

    expect(await versionsOf(pkg)).toEqual([]);
  }, 60_000);
});
