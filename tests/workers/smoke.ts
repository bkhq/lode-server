#!/usr/bin/env bun
/**
 * Cloudflare Workers smoke test.
 *
 * Boots the app the way it actually runs on Cloudflare — one Durable
 * Object owning a SQLite database, R2 for blobs — and drives the paths
 * whose behaviour differs from Bun:
 *
 *   1. boot          — migrations run inside the Durable Object
 *   2. transactions  — `createDocument` wraps a multi-statement write, and
 *                      Durable Object transactions are async-callback based
 *                      (see `db/workers.ts`)
 *   3. R2 storage    — upload, then read the blob back through the API
 *   4. rate limiting — the platform key/value seam backs the limiter
 *
 * With `--oidc` it checks a deployment configured for OpenID Connect
 * instead. Such a deployment has no local password to log in with — the SPA
 * offers one login method or the other — so the authenticated cases are
 * replaced by ones that prove the provider wiring: the app reports an
 * OAuth-configured mode, and starting a login redirects to the issuer
 * carrying a PKCE challenge.
 *
 * With `--base-path /u` (and optionally `--home-page root`) it runs the
 * Worker mounted under that prefix, serving a SPA built for it from
 * apps/web/dist-smoke, and checks the paths the Worker has to serve itself
 * there: the shell and its assets under the prefix, and "/" — a redirect to
 * the app, or the home page when it lives at the origin root.
 *
 * Usage:
 *   bun tests/workers/smoke.ts                 # spawns `wrangler dev`
 *   bun tests/workers/smoke.ts --url https://… # runs against a deployment
 *   bun tests/workers/smoke.ts --url … --oidc  # OIDC deployment
 */
import type { Subprocess } from "bun";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

// Local runs use the fixture in apps/api/.dev.vars.example. A run against a
// real deployment passes freshly generated credentials instead, so a
// publicly reachable URL never carries a password that is committed here.
const USERNAME = process.env.SMOKE_USERNAME ?? "smoke";
const PASSWORD = process.env.SMOKE_PASSWORD ?? "smoke-test-password";
const PORT = 8787;

interface Case {
  name: string;
  run: () => Promise<void>;
}

class SmokeError extends Error {}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond)
    throw new SmokeError(msg);
}

let baseUrl = "";
let cookie = "";

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  // csrfGuard wants both an `X-Requested-With` header and a matching Origin
  // on state-changing requests; the SPA client sets the same pair.
  headers.set("Origin", new URL(baseUrl).origin);
  headers.set("X-Requested-With", "XMLHttpRequest");
  if (cookie)
    headers.set("Cookie", cookie);
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: "manual" });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0)
    cookie = setCookie.map(c => c.split(";")[0]).join("; ");
  return res;
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  }
  catch {
    throw new SmokeError(`expected JSON, got ${res.status}: ${text.slice(0, 300)}`);
  }
}

const cases: Case[] = [
  {
    name: "health endpoint responds",
    async run() {
      const res = await call("/api/health");
      assert(res.status === 200, `health returned ${res.status}`);
      const body = await json<{ status: string }>(res);
      assert(body.status === "ok", `health status was ${body.status}`);
    },
  },
  {
    name: "single-user login issues a session",
    async run() {
      const res = await call("/api/account/auth/login-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
      });
      if (res.status !== 200)
        throw new SmokeError(`login returned ${res.status}: ${await res.text()}`);
      assert(cookie !== "", "login did not set a session cookie");
    },
  },
  {
    name: "document create commits its transaction",
    async run() {
      const res = await call("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "smoke document",
          content: "written on workers",
          tags: ["smoke"],
        }),
      });
      if (res.status !== 201)
        throw new SmokeError(`create returned ${res.status}: ${await res.text()}`);
      const created = await json<{ data: { id: string; title: string } }>(res);
      const id = created.data.id;

      // Read it back: the transaction must have committed every statement,
      // including the tag rows written inside the same transaction.
      const read = await call(`/api/documents/${id}`);
      assert(read.status === 200, `read-back returned ${read.status}`);
      const doc = await json<{ data: { title: string; tags?: string[] } }>(read);
      assert(doc.data.title === "smoke document", "document title did not round-trip");
      assert(doc.data.tags?.includes("smoke") ?? false, "document tags did not round-trip");
    },
  },
  {
    name: "invalid document create rolls its transaction back",
    async run() {
      const before = await json<{ data: unknown[] }>(await call("/api/documents?limit=100"));
      const count = before.data.length;

      // `parentId` pointing at nothing is rejected after the handler has
      // begun writing, which is the rollback path.
      const res = await call("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "should not persist", parentId: "does-not-exist" }),
      });
      assert(res.status >= 400, `invalid create unexpectedly returned ${res.status}`);

      const after = await json<{ data: unknown[] }>(await call("/api/documents?limit=100"));
      assert(after.data.length === count, "a rejected create left a document behind");
    },
  },
  {
    name: "attachment upload round-trips through R2",
    async run() {
      const created = await json<{ data: { id: string } }>(
        await call("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "smoke attachment host" }),
        }),
      );
      const docId = created.data.id;

      const content = `workers smoke ${Date.now()}`;
      const form = new FormData();
      form.append("file", new Blob([content], { type: "text/plain" }), "smoke.txt");

      const res = await call(`/api/documents/${docId}/attachments`, { method: "POST", body: form });
      if (res.status !== 201 && res.status !== 200)
        throw new SmokeError(`upload returned ${res.status}: ${await res.text()}`);
      const uploaded = await json<{ data: { id: string; fileId?: string } }>(res);
      const ref = uploaded.data.id;

      // Reading it back pulls the blob out of R2 and streams it through the
      // Worker (the bucket binding cannot presign).
      const download = await call(`/api/files/${uploaded.data.fileId ?? ref}/content?ref=${ref}`);
      if (download.status !== 200)
        throw new SmokeError(`download returned ${download.status}: ${await download.text()}`);
      const got = await download.text();
      assert(got === content, "downloaded blob did not match the uploaded bytes");
    },
  },
  {
    // On Workers the Durable Object driver's run() returned nothing, and
    // the version check read `rowsAffected` off it — every edit threw.
    name: "editing a document commits, and a stale version is a conflict",
    async run() {
      const created = await json<{ data: { id: string; version: number } }>(
        await call("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "smoke edit" }),
        }),
      );
      const { id, version } = created.data;

      const edit = await call(`/api/documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "smoke edit v2", version }),
      });
      if (edit.status !== 200)
        throw new SmokeError(`edit returned ${edit.status}: ${await edit.text()}`);

      const stale = await call(`/api/documents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "smoke edit v3", version }),
      });
      assert(stale.status === 409, `a stale version returned ${stale.status}, expected 409`);
      await stale.text();
    },
  },
  {
    name: "deleting a document removes it",
    async run() {
      const created = await json<{ data: { id: string } }>(
        await call("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "smoke delete" }),
        }),
      );
      const { id } = created.data;

      const del = await call(`/api/documents/${id}`, { method: "DELETE" });
      if (del.status >= 300)
        throw new SmokeError(`delete returned ${del.status}: ${await del.text()}`);
      await del.text();

      const gone = await call(`/api/documents/${id}`);
      assert(gone.status === 404, `a deleted document still answers ${gone.status}`);
      await gone.text();
    },
  },
  {
    name: "the raw API reaches the Worker and carries no browser headers",
    async run() {
      const res = await fetch(`${baseUrl}/api/raw/health`);
      assert(res.status === 200, `raw health returned ${res.status}`);
      assert((res.headers.get("content-type") ?? "").includes("application/json"), "raw API answered with something other than JSON");
      assert(res.headers.get("content-security-policy") === null, "raw API carries a CSP");
      assert(res.headers.get("cross-origin-resource-policy") === null, "raw API restricts cross-origin readers");
    },
  },
  {
    // Runs last: it spends whatever creation budget the cases above left.
    name: "creation rate limit is enforced from the database",
    async run() {
      let limited: Response | undefined;
      for (let i = 0; i < 40; i++) {
        const res = await call("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `burst ${i}` }),
        });
        if (res.status === 429) {
          limited = res;
          break;
        }
        await res.text();
      }
      assert(limited !== undefined, "the creation limit never tripped");
      const body = await limited.json() as { error: { code: string } };
      assert(body.error.code === "RATE_LIMITED", `unexpected error code ${body.error.code}`);
      const retryAfter = Number(limited.headers.get("Retry-After"));
      assert(retryAfter > 0, "429 carried no usable Retry-After");
    },
  },
];

const oidcCases: Case[] = [
  {
    name: "health endpoint responds",
    async run() {
      const res = await call("/api/health");
      assert(res.status === 200, `health returned ${res.status}`);
    },
  },
  {
    name: "the raw API reaches the Worker and carries no browser headers",
    async run() {
      const res = await fetch(`${baseUrl}/api/raw/health`);
      assert(res.status === 200, `raw health returned ${res.status}`);
      assert((res.headers.get("content-type") ?? "").includes("application/json"), "raw API answered with something other than JSON");
      assert(res.headers.get("content-security-policy") === null, "raw API carries a CSP");
      assert(res.headers.get("cross-origin-resource-policy") === null, "raw API restricts cross-origin readers");
    },
  },
  {
    name: "the SPA is served from the asset pipeline",
    async run() {
      const res = await call("/");
      assert(res.status === 200, `index returned ${res.status}`);
      const body = await res.text();
      assert(body.includes("<!doctype html") || body.includes("<!DOCTYPE html"), "index was not HTML");
    },
  },
  {
    name: "login mode reports a configured OAuth provider",
    async run() {
      const res = await call("/api/account/auth/mode");
      assert(res.status === 200, `mode returned ${res.status}`);
      const body = await json<{ data: { mode: string; oauthConfigured: boolean } }>(res);
      assert(body.data.mode === "oauth", `mode was '${body.data.mode}', so the SPA would not offer OAuth`);
      // False here means discovery did not resolve the endpoints at boot.
      assert(body.data.oauthConfigured, "the provider's endpoints are not configured");
    },
  },
  {
    name: "starting a login redirects to the issuer with a PKCE challenge",
    async run() {
      const res = await call("/api/account/auth/login");
      assert(res.status === 302, `login returned ${res.status}, expected a redirect`);
      const location = res.headers.get("Location");
      assert(location !== null, "the redirect carried no Location");

      const target = new URL(location);
      const issuer = process.env.SMOKE_OAUTH_ISSUER;
      if (issuer)
        assert(target.host === new URL(issuer).host, `redirected to ${target.host}, not the issuer's host`);

      const clientId = process.env.SMOKE_OAUTH_CLIENT_ID;
      if (clientId)
        assert(target.searchParams.get("client_id") === clientId, "the redirect carried a different client_id");

      assert(target.searchParams.get("response_type") === "code", "response_type was not 'code'");
      assert(target.searchParams.get("code_challenge_method") === "S256", "PKCE is not in use: no S256 challenge method");
      assert((target.searchParams.get("code_challenge") ?? "").length > 0, "PKCE is not in use: the challenge is empty");
      assert(
        target.searchParams.get("redirect_uri") === `${baseUrl}/api/account/auth/callback`,
        `redirect_uri was ${target.searchParams.get("redirect_uri")}, which the provider must have registered`,
      );
    },
  },
];

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1
    ? undefined
    : process.argv[i + 1];
}

// Cases for a deployment mounted under a base path. `baseUrl` already ends
// with the prefix, so `origin` is what the browser would call "/".
const homePage = argValue("--home-page") ?? "off";
const baseCases: Case[] = [
  {
    name: "the API answers under the prefix",
    async run() {
      const res = await fetch(`${baseUrl}/api/health`);
      assert(res.status === 200, `health under the prefix returned ${res.status}`);
      await res.text();
    },
  },
  {
    name: "the SPA shell is served under the prefix, with prefixed asset URLs",
    async run() {
      const prefix = new URL(baseUrl).pathname;
      const res = await fetch(`${baseUrl}/`);
      const html = await res.text();
      assert(res.status === 200 && html.includes("id=\"root\""), `the shell under the prefix returned ${res.status}`);
      assert(html.includes(`${prefix}/assets/`), `the shell does not reference ${prefix}/assets/`);
    },
  },
  {
    name: "a prefixed asset is served from the build root",
    async run() {
      const html = await (await fetch(`${baseUrl}/`)).text();
      const src = /src="([^"]+\.js)"/.exec(html)?.[1];
      assert(src, "no script tag in the shell");
      const res = await fetch(new URL(src, new URL(baseUrl).origin));
      assert(res.status === 200, `${src} returned ${res.status}`);
      assert((res.headers.get("content-type") ?? "").includes("javascript"), `${src} was served as ${res.headers.get("content-type")}`);
      await res.arrayBuffer();
    },
  },
  {
    name: "a client route under the prefix gets the SPA shell",
    async run() {
      const res = await fetch(`${baseUrl}/overview`);
      assert(res.status === 200 && (await res.text()).includes("id=\"root\""), "a client route did not return the shell");
    },
  },
  {
    name: homePage === "root"
      ? "the origin root is the SPA's home page"
      : "the origin root sends the visitor to the app",
    async run() {
      const origin = new URL(baseUrl).origin;
      const prefix = new URL(baseUrl).pathname;
      const res = await fetch(`${origin}/`, { redirect: "manual" });
      const body = await res.text();
      if (homePage === "root")
        assert(res.status === 200 && body.includes("id=\"root\""), "the origin root did not return the SPA shell");
      else
        assert(body.includes(`url=${prefix}/`), `the origin root does not point at ${prefix}/: ${body.slice(0, 120)}`);
    },
  },
];

async function waitForBoot(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok)
        return;
    }
    catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new SmokeError(`app did not become healthy within ${timeoutMs}ms`);
}

async function main(): Promise<void> {
  const urlArg = process.argv.indexOf("--url");
  let dev: Subprocess | undefined;

  const basePath = argValue("--base-path")?.replace(/\/+$/, "");
  const apiDir = new URL("../../apps/api/", import.meta.url).pathname;
  const smokeConfig = `${apiDir}wrangler.smoke.toml`;

  if (urlArg !== -1) {
    baseUrl = process.argv[urlArg + 1]?.replace(/\/+$/, "") ?? "";
    assert(baseUrl !== "", "--url needs a value");
  }
  else {
    baseUrl = `http://127.0.0.1:${PORT}${basePath ?? ""}`;
    // wrangler keeps the Durable Object's SQLite between runs. Start clean so
    // the run is deterministic: a regenerated baseline migration would
    // collide with the old schema, and the rate-limit case needs a fresh
    // creation budget.
    rmSync(new URL("../../apps/api/.wrangler/state", import.meta.url).pathname, {
      recursive: true,
      force: true,
    });
    const args = [
      "dev",
      "--port",
      String(PORT),
      "--ip",
      "127.0.0.1",
    ];
    if (basePath) {
      // The deploy workflow rewrites these two lines the same way: assets
      // from the prefix-aware build, and the Worker first for "/" and the
      // prefix.
      const toml = readFileSync(`${apiDir}wrangler.toml`, "utf-8")
        .replace("directory = \"../web/dist\"", "directory = \"../web/dist-smoke\"")
        .replace(/^run_worker_first = .*$/m, `run_worker_first = ["/", "${basePath}/*"]`);
      assert(toml.includes("dist-smoke") && toml.includes(`"${basePath}/*"`), "could not derive the base-path wrangler config");
      writeFileSync(smokeConfig, toml);
      args.push("-c", "wrangler.smoke.toml", "--var", `BASE_PATH:${basePath}`, "--var", `HOME_PAGE:${homePage}`);
    }
    dev = Bun.spawn(
      ["./node_modules/.bin/wrangler", ...args],
      {
        cwd: new URL("../../apps/api", import.meta.url).pathname,
        env: {
          ...process.env,
          CI: "1",
          WRANGLER_SEND_METRICS: "false",
        },
        stdout: process.env.WORKERS_SMOKE_DEBUG ? "inherit" : "pipe",
        stderr: process.env.WORKERS_SMOKE_DEBUG ? "inherit" : "pipe",
      },
    );
  }

  const suite = process.argv.includes("--oidc")
    ? oidcCases
    : basePath ? baseCases : cases;

  let failures = 0;
  try {
    await waitForBoot(120_000);
    for (const c of suite) {
      try {
        await c.run();
        console.log(`  ok    ${c.name}`);
      }
      catch (err) {
        failures++;
        console.error(`  FAIL  ${c.name}`);
        console.error(`        ${err instanceof Error
          ? err.message
          : String(err)}`);
      }
    }
  }
  finally {
    dev?.kill();
    rmSync(smokeConfig, { force: true });
  }

  console.log(`\n${suite.length - failures}/${suite.length} passed`);
  process.exit(failures === 0
    ? 0
    : 1);
}

await main();
