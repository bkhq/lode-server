/**
 * OIDC discovery: fetch `/.well-known/openid-configuration` from the
 * configured issuer at boot, cache the result next to the DB, and fall
 * back to the cache when the IdP is unreachable. Keeps the runtime
 * able to refresh OAuth endpoints without a config change while
 * surviving brief IdP outages.
 *
 * Security: the cache file sits on a writeable data volume, so the
 * cached endpoints' origins are pinned against the issuer's origin
 * before they are trusted — a co-tenant with write access cannot
 * swap them out for attacker-controlled URLs during the next IdP blip.
 */

import { getPlatform } from "@/platform";

export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  end_session_endpoint?: string;
}

interface CachedDiscovery {
  readonly issuer: string;
  readonly fetchedAt: string;
  readonly discovery: OidcDiscovery;
}

// Read on cold boot only when the IdP is currently unreachable. A
// 24-hour ceiling on cache age lets a one-day IdP outage ride
// through without operator action, but an indefinitely-stale entry
// (IdP replaced, endpoint URLs rotated) gets a loud warning so the
// operator notices that the pinned values may no longer point at a
// working server.
const DISCOVERY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const RE_TRAILING_SLASHES = /\/+$/;

export async function fetchOidcDiscovery(issuer: string): Promise<OidcDiscovery> {
  const url = `${issuer.replace(RE_TRAILING_SLASHES, "")}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText} from ${url}`);
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("json")) {
    throw new Error(`OIDC discovery returned non-JSON content-type: ${ctype}`);
  }
  // Bound the response body — discovery docs are well under 64 KB; an attacker
  // controlling the issuer (or MITM) could otherwise stream unlimited bytes.
  const text = await res.text();
  if (text.length > 64 * 1024) {
    throw new Error(`OIDC discovery response too large: ${text.length} bytes`);
  }
  return JSON.parse(text) as OidcDiscovery;
}

/**
 * Verify every URL inside the cached discovery document shares an
 * origin with the configured issuer. Refuses (returns false) when any
 * endpoint points off-origin or fails to parse — the caller treats a
 * false here as "cache is corrupt; refuse the fallback".
 */
export function discoveryEndpointsMatchIssuer(discovery: OidcDiscovery, issuer: string): boolean {
  let issuerOrigin: string;
  try {
    issuerOrigin = new URL(issuer).origin;
  }
  catch {
    return false;
  }
  for (const url of [discovery.authorization_endpoint, discovery.token_endpoint, discovery.userinfo_endpoint]) {
    try {
      if (new URL(url).origin !== issuerOrigin)
        return false;
    }
    catch {
      return false;
    }
  }
  if (discovery.end_session_endpoint !== undefined) {
    try {
      if (new URL(discovery.end_session_endpoint).origin !== issuerOrigin)
        return false;
    }
    catch {
      return false;
    }
  }
  return true;
}

export interface DiscoveryWarnings {
  /** Cache file rejected because endpoint origins didn't match the issuer. */
  readonly tampered: boolean;
  /** Cache entry older than DISCOVERY_CACHE_TTL_MS. */
  readonly stale: boolean;
  /** Age of the cache entry in hours, when known. Used in the stale warning. */
  readonly ageHours: number | undefined;
}

/**
 * Inspect-and-return a cached discovery document. Splits "did the
 * file exist / parse / match" decisions out of the warning-emission
 * concerns so the orchestrator can tell tests apart from production
 * boot output. Returns `null` (and `tampered === true`) when the
 * cached endpoints have been off-origin'd, so the caller treats that
 * the same as no cache.
 */
export async function readDiscoveryCache(cachePath: string, issuer: string): Promise<{
  discovery: OidcDiscovery | null;
  warnings: DiscoveryWarnings;
}> {
  const blank: DiscoveryWarnings = { tampered: false, stale: false, ageHours: undefined };
  // No filesystem, no cache: discovery is re-fetched on every boot.
  if (!getPlatform().capabilities.filesystem)
    return { discovery: null, warnings: blank };
  try {
    const file = Bun.file(cachePath);
    if (!(await file.exists()))
      return { discovery: null, warnings: blank };
    const cached = await file.json() as CachedDiscovery;
    if (cached.issuer !== issuer)
      return { discovery: null, warnings: blank };
    if (!discoveryEndpointsMatchIssuer(cached.discovery, issuer))
      return { discovery: null, warnings: { ...blank, tampered: true } };

    const fetchedAt = Date.parse(cached.fetchedAt);
    let stale = false;
    let ageHours: number | undefined;
    if (Number.isFinite(fetchedAt)) {
      const ageMs = Date.now() - fetchedAt;
      if (ageMs > DISCOVERY_CACHE_TTL_MS) {
        stale = true;
        ageHours = Math.round(ageMs / 3_600_000);
      }
    }
    return { discovery: cached.discovery, warnings: { tampered: false, stale, ageHours } };
  }
  catch {
    return { discovery: null, warnings: blank };
  }
}

export async function writeDiscoveryCache(cachePath: string, issuer: string, discovery: OidcDiscovery): Promise<void> {
  if (!getPlatform().capabilities.filesystem)
    return;
  try {
    const tmp = `${cachePath}.tmp`;
    await Bun.write(tmp, JSON.stringify({ issuer, fetchedAt: new Date().toISOString(), discovery } satisfies CachedDiscovery));
    const { renameSync } = await import("node:fs");
    renameSync(tmp, cachePath);
  }
  catch {
    // best-effort — discovery still works without the cache
  }
}

export interface OidcResolveResult {
  /** Resolved endpoint values, or null when neither the network nor the cache yielded a discovery document. */
  readonly discovery: OidcDiscovery | null;
  /** Surface for the orchestrator to log without coupling this module to any logger interface. */
  readonly warnings: readonly string[];
}

/**
 * Try the network first, fall back to the on-disk cache. Refresh the
 * cache on success. Returns a structured result instead of mutating
 * env so this module stays free of `Config` import cycles — the
 * orchestrator applies the resolved endpoints into the config object.
 */
export async function resolveOidcDiscovery(opts: {
  readonly issuer: string;
  readonly cachePath: string;
}): Promise<OidcResolveResult> {
  const warnings: string[] = [];
  let discovery: OidcDiscovery | null = null;
  try {
    discovery = await fetchOidcDiscovery(opts.issuer);
    await writeDiscoveryCache(opts.cachePath, opts.issuer, discovery);
  }
  catch {
    const { discovery: cached, warnings: cacheWarnings } = await readDiscoveryCache(opts.cachePath, opts.issuer);
    if (cacheWarnings.tampered) {
      warnings.push(
        `[config] OIDC discovery cache rejected — endpoint origin does not match issuer ${opts.issuer}. The cache file may have been tampered with; ignoring.`,
      );
    }
    if (cacheWarnings.stale && cacheWarnings.ageHours !== undefined) {
      warnings.push(
        `[config] OIDC discovery cache is stale (last successful refresh ${cacheWarnings.ageHours}h ago, TTL ${DISCOVERY_CACHE_TTL_MS / 3_600_000}h); endpoints may be outdated.`,
      );
    }
    if (cached)
      warnings.push("[config] OIDC discovery refresh failed; using cached endpoints from previous boot");
    discovery = cached;
  }
  return { discovery, warnings };
}
