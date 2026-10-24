import type { Subprocess } from "bun";
import type { ApiClient } from "../../lib/api";
import type { Manifest, PackageView } from "./helpers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { API_BASE } from "../../lib/api";
import { getClient } from "../../lib/oidc";
import { createDraft, createPackage, createToken, deletePackage, FEED_BASE, manifestOf, packagePath, publish, registerKey, setChannel, text, uniqueSlug, uploadAsset, withToken } from "./helpers";

// The registry driven by the real lode client (v0.3.0): the `lode` supervisor
// bootstraps and auto-updates from the live read feed, `lode-cli` generates
// the publisher key and signs the assets. Nothing here re-implements what
// lode does; every scenario asserts on lode's own exit status, its log output
// and the files it installs.
//
// The binary is static, so it runs directly on this host and reaches the API
// on loopback (lode allows plain http there). It is looked for in this order:
//
//   1. `E2E_LODE_BIN` — path to a `lode` binary;
//   2. `tests/e2e/.cache/lode-v0.3.0/lode` — left by an earlier run;
//   3. extracted from the local image `bkhq/lode:v0.3.0-mini`
//      (`docker pull docker.io/bkhq/lode:v0.3.0-mini` once) into that cache path.
//
// With none of them the suite is skipped, with a message, and does not fail.

const CACHE_DIR = resolve(import.meta.dir, "../../.cache");
const LODE_DIR = join(CACHE_DIR, "lode-v0.3.0");
const LODE_IMAGE = "bkhq/lode:v0.3.0-mini";
const SIGN_SCRIPT = resolve(import.meta.dir, "../../../../scripts/sign-manifest.sh");

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
function extractFromImage(image: string, target: string): boolean {
  if (!docker("image", "inspect", image))
    return false;
  const container = `ai-agent-lode-server-e2e-${process.pid}`;
  if (!docker("create", "--label", "ai-agent=true", "--name", container, image))
    return false;
  try {
    mkdirSync(dirname(target), { recursive: true });
    return docker("cp", `${container}:/usr/bin/lode`, target);
  }
  finally {
    docker("rm", "-f", container);
  }
}

/** Path of a runnable `lode`, or undefined when there is none on this host. */
function locateLode(): string | undefined {
  const fromEnv = process.env.E2E_LODE_BIN;
  if (fromEnv) {
    return runs(fromEnv)
      ? resolve(fromEnv)
      : undefined;
  }
  const cached = join(LODE_DIR, "lode");
  if (runs(cached) || (extractFromImage(LODE_IMAGE, cached) && runs(cached)))
    return cached;
  return undefined;
}

const LODE = locateLode();
// CI pulls the image: a missing binary there is a broken pipeline, not a skip.
if (!LODE && process.env.CI)
  throw new Error(`[registry/lode] no lode binary: the image ${LODE_IMAGE} is not available to docker`);
if (!LODE)
  console.warn(`[registry/lode] SKIPPED: no lode binary. Set E2E_LODE_BIN, or make the image ${LODE_IMAGE} available to docker.`);

/** `[major, minor, patch]` of the located lode, from `lode --version`. */
function versionOf(bin: string): number[] {
  const out = Bun.spawnSync([bin, "--version"], { stdout: "pipe" }).stdout.toString();
  return (/(\d+)\.(\d+)\.(\d+)/.exec(out) ?? []).slice(1).map(Number);
}

// Delegated signing (`lode-cli delegate` / `revoke`, sub-key verification) came with lode 0.1.0.
const [major = 0, minor = 0] = LODE
  ? versionOf(LODE)
  : [];
const DELEGATION = major > 0 || minor >= 1;
if (LODE && !DELEGATION)
  console.warn("[registry/lode] delegated signing case SKIPPED: it needs lode 0.1.0 or later; set E2E_LODE_BIN to one.");

// `lode-cli` is the same binary under another name.
const LODE_CLI = join(LODE_DIR, "lode-cli");
// Re-pointed when it links to another binary than the one located.
if (LODE && !(existsSync(LODE_CLI) && realpathSync(LODE_CLI) === realpathSync(LODE))) {
  mkdirSync(LODE_DIR, { recursive: true });
  rmSync(LODE_CLI, { force: true });
  symlinkSync(LODE, LODE_CLI);
}

const ASSET = "demo.sh";

/** The packaged "app": a script that records which version ran, then stays up like a service. */
function app(version: string): Uint8Array {
  return text(`#!/bin/sh\necho "${version}" >> "$LODE_DIR/ran"\nexec sleep 600\n`);
}

// eslint-disable-next-line no-control-regex
const RE_ANSI = /\x1B\[[0-9;]*m/g;

function cli(args: string[], env: Record<string, string> = {}): { exitCode: number; output: string } {
  const result = Bun.spawnSync([LODE_CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...env,
    },
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`.replace(RE_ANSI, ""),
  };
}

function field(output: string, name: string): string {
  const match = new RegExp(`^${name}:\\s+(\\S+)`, "m").exec(output);
  if (!match?.[1])
    throw new Error(`no "${name}:" line in lode-cli output:\n${output}`);
  return match[1];
}

interface OperatorConfig {
  readonly pkg: PackageView;
  readonly requireSignature: "off" | "enforce";
  readonly trustedKeys?: readonly string[];
  /** `[trust].require_manifest`; left out of the file when unset. */
  readonly requireManifest?: "signed" | "fresh";
  /** `[trust].revocation_url`; left out of the file when unset. */
  readonly revocationUrl?: string;
  /** `[http].headers`; `${VAR}` is expanded by lode from its environment. */
  readonly headers?: readonly string[];
  readonly env?: Record<string, string>;
}

/** One operator host: a data dir with a `lode.toml`, and the `lode` supervisor run against it. */
class Operator {
  readonly dir: string;
  private proc: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  private log = "";
  private drained: Promise<unknown> = Promise.resolve();

  constructor(root: string, private readonly config: OperatorConfig) {
    this.dir = mkdtempSync(join(root, "operator-"));
    const { pkg } = config;
    writeFileSync(join(this.dir, "lode.toml"), [
      "[global]",
      // The package slug is the manifest `name`.
      `app = "${pkg.slug}"`,
      `dir = "${this.dir}"`,
      // The supervisor reports an update check that changes nothing at debug level only.
      "log_level = \"debug\"",
      "[update]",
      `manifest = "${FEED_BASE}/${pkg.namespace}/${pkg.slug}/manifest.json"`,
      `asset = "${ASSET}"`,
      "channel = \"stable\"",
      "policy = \"auto\"",
      "check_interval = 1",
      "[http]",
      `headers = ${JSON.stringify(config.headers ?? [])}`,
      "[trust]",
      `require_signature = "${config.requireSignature}"`,
      `trusted_keys = ${JSON.stringify(config.trustedKeys ?? [])}`,
      ...(config.requireManifest
        ? [`require_manifest = "${config.requireManifest}"`]
        : []),
      ...(config.revocationUrl
        ? [`revocation_url = "${config.revocationUrl}"`]
        : []),
      "[command]",
      `run = "./${ASSET}"`,
      "[supervise]",
      "health_grace = 1",
      "stop_timeout = 2",
      "",
    ].join("\n"));
  }

  /** Start bare `lode`: bootstrap when nothing is installed, then supervise and poll. */
  start(): void {
    const proc = Bun.spawn([
      LODE!,
      "--config",
      join(this.dir, "lode.toml"),
    ], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...this.config.env,
      },
    });
    this.proc = proc;
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream)
        this.log += decoder.decode(chunk, { stream: true });
    };
    this.drained = Promise.all([
      drain(proc.stdout),
      drain(proc.stderr),
    ]);
  }

  /** What lode has printed so far, colour codes removed. */
  get output(): string {
    return this.log.replace(RE_ANSI, "");
  }

  get current(): string | undefined {
    try {
      return readlinkSync(join(this.dir, "current")).replace("versions/", "");
    }
    catch {
      return undefined;
    }
  }

  installed(version: string): Uint8Array | undefined {
    const file = join(this.dir, "versions", version, ASSET);
    return existsSync(file)
      ? new Uint8Array(readFileSync(file))
      : undefined;
  }

  /** The versions the app was launched as, in order. */
  get ran(): string[] {
    const file = join(this.dir, "ran");
    return existsSync(file)
      ? readFileSync(file, "utf-8").trim().split("\n")
      : [];
  }

  async waitFor(what: string, ready: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
      if (Date.now() > deadline)
        throw new Error(`lode: timed out waiting for ${what}. Output so far:\n${this.output}`);
      await Bun.sleep(100);
    }
  }

  /** Wait for lode to exit by itself (a failed bootstrap). */
  async exited(timeoutMs = 20_000): Promise<number> {
    const code = await Promise.race([
      this.proc!.exited,
      Bun.sleep(timeoutMs).then(() => undefined),
    ]);
    if (code === undefined)
      throw new Error(`lode: still running after ${timeoutMs} ms. Output so far:\n${this.output}`);
    await this.drained;
    return code;
  }

  /** SIGTERM, as a container runtime stops it; lode stops the child and exits. */
  async stop(): Promise<number | undefined> {
    const proc = this.proc;
    if (!proc)
      return undefined;
    this.proc = undefined;
    if (proc.exitCode === null)
      proc.kill("SIGTERM");
    const code = await proc.exited;
    await this.drained;
    return code;
  }
}

describe.skipIf(!LODE)("registry driven by the real lode client", () => {
  let user: ApiClient;
  let work: string;
  const operators: Operator[] = [];
  const packages: PackageView[] = [];

  function operator(config: OperatorConfig): Operator {
    const op = new Operator(work, config);
    operators.push(op);
    return op;
  }

  async function newPackage(input: Parameters<typeof createPackage>[1] = {}): Promise<PackageView> {
    const pkg = await createPackage(user, {
      slug: uniqueSlug("lode"),
      ...input,
    });
    packages.push(pkg);
    return pkg;
  }

  beforeAll(async () => {
    user = await getClient("user@example.com");
    mkdirSync(CACHE_DIR, { recursive: true });
    // Per-run scratch: operator data dirs and the publisher's private key.
    work = mkdtempSync(join(CACHE_DIR, "registry-lode-"));
  });

  afterEach(async () => {
    for (const op of operators.splice(0))
      await op.stop();
  });

  afterAll(async () => {
    for (const pkg of packages)
      await deletePackage(user, pkg);
    rmSync(work, { recursive: true, force: true });
  });

  it("signed package under require_signature = enforce: bootstrap installs v1, auto-update moves to v2", async () => {
    // Publisher side: a key from `lode-cli keygen`, registered with the registry.
    const keygen = cli([
      "keygen",
      "--out",
      join(work, "publisher"),
    ]);
    expect(keygen.exitCode).toBe(0);
    const keyId = field(keygen.output, "key_id");
    const trustedKey = field(keygen.output, "trustedKeys");
    const pkg = await newPackage({ require_signature: true });
    expect((await registerKey(user, pkg, trustedKey)).key_id).toBe(keyId);
    // CI publishes with a token granted `write` on this one package.
    const ci = (await createToken(user, [
      { package: `${pkg.namespace}/${pkg.slug}`, access: "write" },
    ])).token;

    // `lode-cli sign` signs the app — the package slug — and the basename of the file it is given.
    async function publishSigned(version: string): Promise<Uint8Array> {
      const dir = join(work, `build-${version}`);
      mkdirSync(dir);
      const bytes = app(version);
      writeFileSync(join(dir, ASSET), bytes);
      const signed = cli([
        "sign",
        join(dir, ASSET),
        "--app",
        pkg.slug,
        "--version",
        version,
        "--key",
        join(work, "publisher.key"),
      ]);
      expect(signed.exitCode).toBe(0);
      expect(field(signed.output, "key_id")).toBe(keyId);

      await createDraft(ci, pkg, version);
      const asset = await uploadAsset(ci, pkg, version, ASSET, bytes, {
        sha256: field(signed.output, "sha256"),
        sig: field(signed.output, "sig"),
      });
      expect(asset.key_id).toBe(keyId);
      await publish(ci, pkg, version);
      return bytes;
    }

    const v1 = await publishSigned("1.0.0");
    const op = operator({
      pkg,
      requireSignature: "enforce",
      trustedKeys: [trustedKey],
    });
    op.start();
    await op.waitFor("bootstrap of 1.0.0", () => op.ran.length === 1);
    expect(op.output).toContain("bootstrapped initial version version=\"1.0.0\"");
    expect(op.current).toBe("1.0.0");
    expect(op.installed("1.0.0")).toEqual(v1);

    const v2 = await publishSigned("2.0.0");
    await op.waitFor("auto-update to 2.0.0", () => op.ran.length === 2);
    expect(op.output).toContain("applying update target from=\"1.0.0\" to=\"2.0.0\"");
    expect(op.ran).toEqual(["1.0.0", "2.0.0"]);
    expect(op.current).toBe("2.0.0");
    expect(op.installed("2.0.0")).toEqual(v2);
    expect(op.output).not.toContain("ERROR");

    // The same feed is refused by an operator who trusts a different key:
    // the signature the registry serves is what enforce checks.
    const other = cli(["keygen"]);
    const stranger = operator({
      pkg,
      requireSignature: "enforce",
      trustedKeys: [
        field(other.output, "trustedKeys"),
      ],
    });
    stranger.start();
    expect(await stranger.exited()).toBe(1);
    expect(stranger.output).toContain("verify: artifact signature did not match any trusted key");
    expect(stranger.current).toBeUndefined();
  }, 60_000);

  async function publishUnsigned(ci: string, pkg: PackageView, version: string): Promise<Uint8Array> {
    const bytes = app(version);
    await createDraft(ci, pkg, version);
    const asset = await uploadAsset(ci, pkg, version, ASSET, bytes);
    expect(asset.sig).toBeNull();
    await publish(ci, pkg, version);
    return bytes;
  }

  /** An unsigned public package with 1.0.0 published, and an operator host that bootstrapped it and then followed `stable` to 2.0.0. */
  async function hostOnV2(): Promise<{ pkg: PackageView; ci: string; op: Operator }> {
    const pkg = await newPackage();
    const ci = (await createToken(user, [
      { package: `${pkg.namespace}/${pkg.slug}`, access: "write" },
    ])).token;

    const v1 = await publishUnsigned(ci, pkg, "1.0.0");
    const op = operator({ pkg, requireSignature: "off" });
    op.start();
    await op.waitFor("bootstrap of 1.0.0", () => op.ran.length === 1);
    expect(op.output).toContain("bootstrapped initial version version=\"1.0.0\"");
    expect(op.current).toBe("1.0.0");
    expect(op.installed("1.0.0")).toEqual(v1);

    const v2 = await publishUnsigned(ci, pkg, "2.0.0");
    await op.waitFor("auto-update to 2.0.0", () => op.ran.length === 2);
    expect(op.output).toContain("applying update target from=\"1.0.0\" to=\"2.0.0\"");
    expect(op.current).toBe("2.0.0");
    expect(op.installed("2.0.0")).toEqual(v2);
    return { pkg, ci, op };
  }

  it("publisher-signed manifest: a host on require_manifest = fresh updates only from a signed manifest", async () => {
    const keygen = cli([
      "keygen",
      "--out",
      join(work, "manifest-signer"),
    ]);
    expect(keygen.exitCode).toBe(0);
    const trustedKey = field(keygen.output, "trustedKeys");
    const pkg = await newPackage();
    const ref = `${pkg.namespace}/${pkg.slug}`;
    await registerKey(user, pkg, trustedKey);
    const ci = (await createToken(user, [
      { package: ref, access: "write" },
    ])).token;

    // What a publisher's CI runs after each release step: scripts/sign-manifest.sh.
    function signManifest(...expect: string[]): { exitCode: number; output: string } {
      const result = Bun.spawnSync([
        "bash",
        SIGN_SCRIPT,
        "--registry",
        API_BASE,
        "--package",
        ref,
        "--expires-in",
        "1h",
        ...expect.flatMap(pair => ["--expect", pair]),
      ], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${LODE_DIR}${delimiter}${process.env.PATH ?? ""}`,
          LODE_REGISTRY_TOKEN: ci,
          LODE_SIGNING_KEY: readFileSync(join(work, "manifest-signer.key"), "utf-8").trim(),
        },
      });
      return { exitCode: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
    }
    const signatureState = async () => (await user.json<{ data: { status: string } | null }>(`${packagePath(pkg)}/manifest-signature`)).data?.status;

    const host = () => operator({
      pkg,
      requireSignature: "off",
      trustedKeys: [trustedKey],
      requireManifest: "fresh",
    });
    async function refused(): Promise<void> {
      const op = host();
      op.start();
      expect(await op.exited()).toBe(1);
      expect(op.output).toContain("require_manifest=fresh but the manifest has no signature");
      expect(op.current).toBeUndefined();
    }

    // Published, not signed yet: the manifest has no signature and the host installs nothing.
    await publishUnsigned(ci, pkg, "1.0.0");
    expect(await signatureState()).toBeUndefined();
    await refused();

    // A manifest this key has not signed is only signed against stated channels.
    expect(signManifest().exitCode).toBe(1);
    expect(signManifest("stable=9.9.9").exitCode).toBe(1);
    expect(await signatureState()).toBeUndefined();

    const signed = signManifest("stable=1.0.0");
    expect(signed.output).toContain("signed with key");
    expect(signed.exitCode).toBe(0);
    // The token is never printed.
    expect(signed.output).not.toContain(ci);
    expect(await signatureState()).toBe("live");
    expect(await manifestOf(pkg)).toMatchObject({
      key_id: field(keygen.output, "key_id"),
      sig: expect.any(String),
      expires: expect.any(Number),
      expires_sig: expect.any(String),
    });
    // Unchanged since: a renewal needs no expectation.
    expect(signManifest().exitCode).toBe(0);

    const op = host();
    op.start();
    await op.waitFor("bootstrap of 1.0.0", () => op.ran.length === 1);
    expect(op.current).toBe("1.0.0");
    await op.stop();

    // A release that has not been signed again: the manifest goes out
    // unsigned, never with the signature of the old catalog.
    await publishUnsigned(ci, pkg, "2.0.0");
    expect(await signatureState()).toBe("stale");
    expect((await manifestOf(pkg)) as Record<string, unknown>).not.toHaveProperty("sig");
    await refused();

    expect(signManifest().exitCode).toBe(1);
    expect(signManifest("stable=2.0.0").exitCode).toBe(0);
    const updated = host();
    updated.start();
    await updated.waitFor("bootstrap of 2.0.0", () => updated.ran.length === 1);
    expect(updated.current).toBe("2.0.0");
  }, 90_000);

  it.skipIf(!DELEGATION)("delegated signing: a host that trusts only the root installs what the sub-key signed, until the sub-key is revoked and the asset re-signed", async () => {
    const pkg = await newPackage({ require_signature: true });
    const ref = `${pkg.namespace}/${pkg.slug}`;
    const root = cli([
      "keygen",
      "--out",
      join(work, "root"),
    ]);
    const rootKey = field(root.output, "trustedKeys");
    await registerKey(user, pkg, rootKey);
    const ci = (await createToken(user, [
      { package: ref, access: "write" },
    ])).token;
    const api = (method: string, path: string, body: unknown) => withToken(ci, `${packagePath(pkg)}${path}`, {
      method,
      body: JSON.stringify(body),
    });
    const keyFile = (name: string) => readFileSync(join(work, `${name}.key`), "utf-8").trim();

    // The root, offline in practice, delegates to a CI sub-key.
    function delegateTo(sub: string): string {
      expect(cli([
        "keygen",
        "--out",
        join(work, sub),
      ]).exitCode).toBe(0);
      const out = join(work, `${sub}-delegation.json`);
      const delegated = cli([
        "delegate",
        "--key",
        join(work, "root.key"),
        "--sub",
        join(work, `${sub}.pub`),
        "--app",
        pkg.slug,
        "--valid-for",
        "1d",
        "--out",
        out,
      ]);
      expect(delegated.exitCode).toBe(0);
      return out;
    }
    const first = delegateTo("sub1");
    expect((await api("PUT", "/delegation", JSON.parse(readFileSync(first, "utf-8")))).status).toBe(200);

    // `lode-cli publish` signs with the sub-key; registering it answers KEY_EXISTS and publishing goes on.
    const build = join(work, "delegated-build");
    mkdirSync(build);
    const v1 = app("1.0.0");
    writeFileSync(join(build, ASSET), v1);
    const { LODE_REGISTRY_TOKEN: _token, LODE_SIGNING_KEY: _key, ...inherited } = process.env;
    const published = Bun.spawnSync([
      LODE_CLI,
      "publish",
      "--registry",
      API_BASE,
      "--package",
      ref,
      "--version",
      "1.0.0",
      "--key-env",
      "LODE_SIGNING_KEY",
      join(build, ASSET),
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...inherited,
        NO_COLOR: "1",
        LODE_REGISTRY_TOKEN: ci,
        LODE_SIGNING_KEY: keyFile("sub1"),
      },
    });
    expect(`${published.stdout}${published.stderr}`).toContain("signing key already registered");
    expect(published.exitCode).toBe(0);
    const manifest = await manifestOf(pkg) as Manifest & { delegation?: { key: string } };
    const subId = manifest.versions["1.0.0"]!.assets[0]!.key_id!;
    expect(manifest.delegation?.key).toContain(subId);

    // The sub-key signs the manifest too. A lode with manifest commits signs a new commit
    // (`lode-cli channel` onto the same version); an older one signs the generated manifest
    // with scripts/sign-manifest.sh. A commit carries no expiry, so its hosts require a
    // signed manifest.
    const committed = manifest.generation !== undefined;
    const signManifest = (key: string) => {
      const command = committed
        ? [
            LODE_CLI,
            "channel",
            "--registry",
            API_BASE,
            "--package",
            ref,
            "--channel",
            "stable",
            "--version",
            "1.0.0",
            "--key-env",
            "LODE_SIGNING_KEY",
          ]
        : [
            "bash",
            SIGN_SCRIPT,
            "--registry",
            API_BASE,
            "--package",
            ref,
            "--expires-in",
            "1h",
            "--expect",
            "stable=1.0.0",
          ];
      const signed = Bun.spawnSync(command, {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${LODE_DIR}${delimiter}${process.env.PATH ?? ""}`,
          LODE_REGISTRY_TOKEN: ci,
          LODE_SIGNING_KEY: keyFile(key),
        },
      });
      expect(signed.exitCode).toBe(0);
    };
    signManifest("sub1");

    const revocationUrl = `${FEED_BASE}/${ref}/revocations.json`;
    const host = () => operator({
      pkg,
      requireSignature: "enforce",
      trustedKeys: [rootKey],
      requireManifest: committed ? "signed" : "fresh",
      revocationUrl,
    });
    const op = host();
    op.start();
    await op.waitFor("bootstrap of 1.0.0", () => op.ran.length === 1);
    expect(op.installed("1.0.0")).toEqual(v1);
    await op.stop();

    // The root revokes the sub-key; the registry stops serving its delegation, so a new host refuses the asset.
    const list = join(work, "revocations.json");
    expect(cli([
      "revoke",
      "--key",
      join(work, "root.key"),
      "--list",
      list,
      "--add",
      subId,
    ]).exitCode).toBe(0);
    expect((await api("PUT", "/revocations", JSON.parse(readFileSync(list, "utf-8")))).status).toBe(200);
    expect(await (await fetch(revocationUrl)).json()).toEqual(JSON.parse(readFileSync(list, "utf-8")));
    expect((await manifestOf(pkg) as { delegation?: unknown }).delegation).toBeUndefined();
    const refused = host();
    refused.start();
    expect(await refused.exited()).toBe(1);
    expect(refused.current).toBeUndefined();

    // A new sub-key re-signs the asset and the manifest; hosts install again.
    const second = delegateTo("sub2");
    expect((await api("PUT", "/delegation", JSON.parse(readFileSync(second, "utf-8")))).status).toBe(200);
    const resigned = cli([
      "sign",
      join(build, ASSET),
      "--app",
      pkg.slug,
      "--version",
      "1.0.0",
      "--key",
      join(work, "sub2.key"),
    ]);
    expect((await api("PUT", `/versions/1.0.0/assets/${ASSET}/signature`, {
      sig: field(resigned.output, "sig"),
    })).status).toBe(200);
    signManifest("sub2");
    const again = host();
    again.start();
    await again.waitFor("bootstrap of 1.0.0", () => again.ran.length === 1);
    expect(again.installed("1.0.0")).toEqual(v1);
    expect(again.output).not.toContain("revocation list");
  }, 90_000);

  it("unsigned package under require_signature = off: bootstrap installs v1, auto-update moves to v2", async () => {
    const { op } = await hostOnV2();
    expect(op.ran).toEqual(["1.0.0", "2.0.0"]);
    expect(op.output).not.toContain("ERROR");
    // Stopped the way a container runtime does it: lode stops the app and exits.
    await op.stop();
    expect(op.output).toContain("termination signal received; stopping child");
  }, 60_000);

  it("rollback: a `latest` pointed back from v2 to v1 is not followed (downgrade floor)", async () => {
    const { pkg, ci, op } = await hostOnV2();

    expect((await setChannel(ci, pkg, "stable", "1.0.0")).status).toBe(200);
    expect((await manifestOf(pkg)).channels.stable).toEqual({ latest: "1.0.0" });

    // The supervisor sees the older pointer on its next poll and stays put.
    await op.waitFor("a poll that sees the rolled-back pointer", () => op.output.includes("update check: up to date latest=\"1.0.0\" current=\"2.0.0\""));
    await Bun.sleep(1500);
    expect(op.current).toBe("2.0.0");
    expect(op.ran).toEqual(["1.0.0", "2.0.0"]);
    await op.stop();

    // An explicit `lode-cli update` on that host is refused outright.
    const update = cli([
      "--config",
      join(op.dir, "lode.toml"),
      "update",
    ]);
    expect(update.exitCode).toBe(1);
    expect(update.output).toContain("refusing to follow the channel `latest` pointer onto \"1.0.0\": it is older than the installed \"2.0.0\"");
    expect(op.current).toBe("2.0.0");
  }, 60_000);

  it("private package: fetched with an Authorization header of a read-granted token, 404 without it", async () => {
    const pkg = await newPackage({ visibility: "private" });
    const bytes = app("1.0.0");
    await createDraft(user, pkg, "1.0.0");
    await uploadAsset(user, pkg, "1.0.0", ASSET, bytes);
    await publish(user, pkg, "1.0.0");
    const reader = (await createToken(user, [
      { package: `${pkg.namespace}/${pkg.slug}`, access: "read" },
    ])).token;

    // Without the header the feed answers 404 and lode gives up.
    const anonymous = operator({ pkg, requireSignature: "off" });
    anonymous.start();
    expect(await anonymous.exited()).toBe(1);
    expect(anonymous.output).toContain(`/r/${pkg.namespace}/${pkg.slug}/manifest.json: http status: 404`);
    expect(anonymous.current).toBeUndefined();

    // With it, the manifest and the same-host asset download both carry the token.
    const op = operator({
      pkg,
      requireSignature: "off",
      // lode expands the variable from its own environment.
      // eslint-disable-next-line no-template-curly-in-string
      headers: ["Authorization: Bearer ${LODE_E2E_TOKEN}"],
      env: { LODE_E2E_TOKEN: reader },
    });
    op.start();
    await op.waitFor("bootstrap of 1.0.0", () => op.ran.length === 1);
    expect(op.output).toContain("bootstrapped initial version version=\"1.0.0\"");
    expect(op.installed("1.0.0")).toEqual(bytes);
  }, 60_000);
});
