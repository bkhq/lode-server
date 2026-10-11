import type { ActionExecutor } from "../types";
import { Buffer } from "node:buffer";
import { promises as dns } from "node:dns";
import { z } from "zod";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from "./spec";

// Validates the config persisted by the create-job route (already vetted
// by `validateActionConfig` against the action's `inputs[]`). Re-parsing
// at execute time catches a hand-edited DB row or a stale schema before
// the executor reaches `fetch`.
const httpRequestConfigSchema = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  timeoutMs: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).optional(),
  expectStatus: z.number().int().min(100).max(599).optional(),
}).passthrough();

type HttpRequestConfig = z.infer<typeof httpRequestConfigSchema>;

function parseConfig(config: Record<string, unknown>): HttpRequestConfig {
  return httpRequestConfigSchema.parse(config);
}

// Cap how much of the response body we read into the result string so
// a 100 MB endpoint can't blow up cron_job_logs.result. Body is only
// surfaced for debugging; status assertions use the prefix.
const MAX_BODY_PREVIEW_BYTES = 2048;
/** Hard cap on bytes read from the response — the preview only needs the head. */
const MAX_BODY_READ_BYTES = 64 * 1024;

// IPv4 literal regex; captured groups are the four octets.
const RE_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const RE_IPV6_BRACKETS = /^\[(.*)\]$/;
const RE_IPV4_MAPPED_HEX = /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

function isIpLiteral(host: string): boolean {
  const bare = stripIpv6Brackets(host.toLowerCase());
  if (RE_IPV4.test(bare))
    return true;
  // IPv6 literals always contain `:` (and `new URL().hostname` strips
  // the surrounding brackets).
  return bare.includes(":");
}

function stripIpv6Brackets(host: string): string {
  return host.match(RE_IPV6_BRACKETS)?.[1] ?? host;
}

function isPrivateIpv4(host: string): boolean {
  const m = host.match(RE_IPV4);
  if (!m)
    return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if ([a, b, Number(m[3]), Number(m[4])].some(n => !Number.isFinite(n) || n < 0 || n > 255))
    return false;
  if (a === 0)
    return true; // 0.0.0.0/8 — routes to loopback on Linux
  if (a === 10)
    return true;
  if (a === 100 && b >= 64 && b <= 127)
    return true; // 100.64.0.0/10 — RFC 6598 CGNAT
  if (a === 127)
    return true;
  if (a === 169 && b === 254)
    return true;
  if (a === 172 && b >= 16 && b <= 31)
    return true;
  if (a === 192 && b === 168)
    return true;
  return false;
}

function ipv4MappedToDotted(host: string): string | null {
  const dotted = host.startsWith("::ffff:") ? host.slice("::ffff:".length) : "";
  if (RE_IPV4.test(dotted))
    return dotted;

  const m = host.match(RE_IPV4_MAPPED_HEX);
  if (!m)
    return null;
  const hi = Number.parseInt(m[1]!, 16);
  const lo = Number.parseInt(m[2]!, 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi < 0 || hi > 0xFFFF || lo < 0 || lo > 0xFFFF)
    return null;
  return `${hi >> 8}.${hi & 0xFF}.${lo >> 8}.${lo & 0xFF}`;
}

/**
 * Reject loopback / private / link-local / unique-local destinations so a
 * compromised admin session cannot pivot from an `http-request` job into
 * cloud metadata (`169.254.169.254`) or internal services. Operators can
 * opt out per-deployment via `HTTP_ACTION_ALLOW_PRIVATE=true` for
 * legitimate sidecar pings.
 *
 * Hostnames that are not IP literals are not resolved here — DNS rebind
 * defence belongs in the network layer, not the application layer.
 */
export function isPrivateDestination(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname.toLowerCase());
  if (host === "localhost" || host === "::1" || host === "::" || host === "0.0.0.0")
    return true;
  if (RE_IPV4.test(host))
    return isPrivateIpv4(host);

  // IPv6 literals are enclosed in brackets in URLs, but `new URL().hostname`
  // strips them; the result still contains `:`. Reject the unique-local /
  // link-local prefixes by string match.
  if (host.includes(":")) {
    const mapped = ipv4MappedToDotted(host);
    if (mapped)
      return isPrivateIpv4(mapped);

    const firstGroup = Number.parseInt(host.split(":")[0] || "0", 16);
    if ((firstGroup & 0xFE00) === 0xFC00)
      return true;
    if ((firstGroup & 0xFFC0) === 0xFE80)
      return true;
  }
  return false;
}

/**
 * Issue one HTTP request against the configured URL. The returned
 * status string lands in `cron_job_logs.result` (on success) or in the
 * thrown `Error.message` → `cron_job_logs.error` (on failure / wrong
 * status).
 *
 * Use cases: external health pings, webhook fan-out, third-party API
 * keep-alives. NOT a replacement for a real HTTP monitoring tool —
 * there's no retry, no backoff, and no SLO bookkeeping. Pair with the
 * audit + run-history surface for visibility.
 */
/**
 * Read at most MAX_BODY_READ_BYTES of the body, then cancel the stream.
 * `res.text()` would buffer the whole response first; a large or
 * endless body must not be able to pin the executor's memory.
 */
async function readBodyPreview(res: Response): Promise<string> {
  if (!res.body)
    return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (total < MAX_BODY_READ_BYTES) {
      const { done, value } = await reader.read();
      if (done)
        break;
      chunks.push(value);
      total += value.byteLength;
    }
    if (total >= MAX_BODY_READ_BYTES) {
      truncated = true;
      await reader.cancel();
    }
  }
  catch {
    // Body read failures aren't fatal — status is the primary signal.
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
  if (text.length > MAX_BODY_PREVIEW_BYTES || truncated)
    return `${text.slice(0, MAX_BODY_PREVIEW_BYTES)}…(truncated)`;
  return text;
}

export const execute: ActionExecutor = async (ctx, config) => {
  const cfg = parseConfig(config);
  const method = (cfg.method ?? "GET").toUpperCase();
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expectStatus = cfg.expectStatus;

  // SSRF gate. `ctx.config.HTTP_ACTION_ALLOW_PRIVATE` lets operators opt
  // out for legitimate sidecar / loopback pings; default-deny keeps a
  // compromised admin session from reaching the cloud metadata endpoint
  // or internal-only services.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(cfg.url);
  }
  catch {
    throw new Error(`invalid URL: ${cfg.url}`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${parsedUrl.protocol}`);
  }
  // The hostname `fetch` actually connects to. When we resolve+validate
  // a DNS name ourselves we PIN this to the vetted IP so `fetch` cannot
  // re-resolve to a rebound (private) address between our check and the
  // socket connect — closing the TOCTOU window. For IP literals and the
  // allow-private path it stays the original host.
  let connectHost = parsedUrl.hostname;
  if (!ctx.config.HTTP_ACTION_ALLOW_PRIVATE) {
    if (isPrivateDestination(parsedUrl.hostname))
      throw new Error(`refused private destination ${parsedUrl.hostname} (set HTTP_ACTION_ALLOW_PRIVATE=true to allow)`);
    // Resolve the hostname ONCE, validate every returned address, then
    // connect to the validated IP directly (see `connectHost` use
    // below). `fetch` is given the IP, not the name, so it performs no
    // second resolution — a rebind to a private address after this
    // check can no longer take effect. The DNS lookup also catches IPv6
    // link-local / unique-local destinations the hostname-literal check
    // above cannot.
    if (!isIpLiteral(parsedUrl.hostname)) {
      let addrs: readonly { address: string; family: number }[];
      try {
        addrs = await dns.lookup(parsedUrl.hostname, { all: true });
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`DNS lookup for ${parsedUrl.hostname} failed: ${msg}`);
      }
      for (const a of addrs) {
        if (isPrivateDestination(a.address))
          throw new Error(`refused destination ${parsedUrl.hostname} (resolves to private ${a.address}; set HTTP_ACTION_ALLOW_PRIVATE=true to allow)`);
      }
      const pinned = addrs[0];
      if (!pinned)
        throw new Error(`DNS lookup for ${parsedUrl.hostname} returned no addresses`);
      // IPv6 literals must be bracketed in a URL authority.
      connectHost = pinned.family === 6 ? `[${pinned.address}]` : pinned.address;
    }
  }

  const startedAt = Date.now();
  const init: RequestInit = {
    method,
    // Never auto-follow: a 3xx to a private address would sail past the
    // DNS pin above. Redirects are reported as the response they are.
    redirect: "manual",
    signal: AbortSignal.timeout(Math.min(timeoutMs, ctx.config.HTTP_ACTION_TIMEOUT_SECONDS * 1000)),
  };
  if (cfg.headers !== undefined)
    init.headers = cfg.headers;
  if (method !== "GET" && method !== "HEAD" && cfg.body !== undefined)
    init.body = cfg.body;

  // Build the request target. When the host was pinned to a resolved IP
  // we rewrite the URL authority to that IP and:
  //   - set `Host` to the original hostname so virtual-host routing and
  //     the IdP's expectations still work, and
  //   - for HTTPS, set `tls.serverName` so SNI + certificate validation
  //     still run against the original hostname (the cert is NOT
  //     validated against the bare IP).
  let requestUrl = cfg.url;
  if (connectHost !== parsedUrl.hostname) {
    const pinnedUrl = new URL(cfg.url);
    pinnedUrl.hostname = connectHost;
    requestUrl = pinnedUrl.toString();
    const headers = new Headers(init.headers);
    headers.set("Host", parsedUrl.host);
    init.headers = headers;
    if (parsedUrl.protocol === "https:") {
      (init as RequestInit & { tls?: { serverName: string } }).tls = {
        serverName: parsedUrl.hostname,
      };
    }
  }

  let res: Response;
  try {
    res = await fetch(requestUrl, init);
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${method} ${cfg.url} failed: ${msg}`);
  }

  const durationMs = Date.now() - startedAt;
  const bodyPreview = await readBodyPreview(res);

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location") ?? "";
    throw new Error(`${method} ${cfg.url} → ${res.status} redirect to ${location || "<no location>"} (redirects are not followed)`);
  }

  const expected = expectStatus ?? null;
  const ok = expected === null ? res.ok : res.status === expected;
  if (!ok) {
    ctx.logger.warn(
      { url: cfg.url, method, status: res.status, durationMs, expected },
      "cron_http_request_unexpected_status",
    );
    throw new Error(
      `${method} ${cfg.url} → ${res.status} (expected ${expected ?? "2xx"}, ${durationMs}ms) body: ${bodyPreview}`,
    );
  }

  ctx.logger.debug(
    { url: cfg.url, method, status: res.status, durationMs },
    "cron_http_request_ok",
  );
  return `${method} ${cfg.url} → ${res.status} (${durationMs}ms)`;
};
