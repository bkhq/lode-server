/**
 * OIDC client wrapper around `oauth4webapi` (panva). Direct IETF-spec
 * primitives — fewer layers than `openid-client`, zero deps, pure Web API
 * (fetch / SubtleCrypto). Better fit for our Bun runtime bundle.
 *
 * Replaces hand-rolled PKCE / token / refresh / revocation code, gaining:
 *
 *   - PKCE code-challenge generation / verification
 *   - `state` validation that cannot be forgotten
 *   - RFC 7009 token revocation (with path-replacement fallback when the
 *     IdP did not advertise `revocation_endpoint`)
 *   - typed errors instead of bare strings
 *
 * The wrapper exposes a stable function shape so the rest of the codebase
 * does not depend on oauth4webapi's request/response two-step API. Inside
 * each function we still go request → process so failure modes are
 * unambiguous.
 */

import type { Config } from "@/config";
import type { OAuthConfig } from "@/shared/lib/app-config";
import * as oauth from "oauth4webapi";

interface CachedAs {
  readonly key: string;
  readonly as: oauth.AuthorizationServer;
  readonly client: oauth.Client;
  readonly clientAuth: oauth.ClientAuth;
  readonly insecure: boolean;
}

let cached: CachedAs | null = null;

function asKey(oauth: OAuthConfig): string {
  return `${oauth.clientId}|${oauth.tokenUrl}|${oauth.authorizeUrl}|${oauth.userinfoUrl}`;
}

function buildAs(oauthConfig: OAuthConfig, appConfig: Config): CachedAs {
  const key = asKey(oauthConfig);
  if (cached && cached.key === key)
    return cached;

  const issuer = appConfig.OAUTH_ISSUER ?? new URL(oauthConfig.tokenUrl).origin;

  // oauth4webapi refuses non-HTTPS endpoints unless `allowInsecureRequests`
  // is set. We opt in when ANY endpoint is http and NODE_ENV !== production.
  //
  // Why `some` and not `every`? This is for a specific dev topology: an
  // external HTTPS tunnel (e.g. Cloudflare / FRP) exposes the app and dex
  // to the user's browser, but the dev box itself cannot reach those
  // external URLs (firewall / 403). The resolution is a "split-horizon"
  // .env: browser-facing endpoints stay https (so the browser can hit
  // them through the tunnel) while server-facing endpoints are rewritten
  // to the local nsl http URL (so the API can talk to dex directly,
  // bypassing the firewall). With `every` this asymmetric config was
  // blocked — any single https URL flipped `insecure` to false and the
  // remaining http calls were rejected. `some` permits the mixed shape
  // while still gating on NODE_ENV.
  //
  // Production is unaffected: NODE_ENV=production keeps `insecure` false
  // regardless of scheme mix, and a misconfigured prod that mixes http
  // and https endpoints still fails closed.
  const anyHttp = [oauthConfig.tokenUrl, oauthConfig.authorizeUrl, oauthConfig.userinfoUrl, issuer]
    .some(u => u.startsWith("http://"));
  const insecure = anyHttp && appConfig.NODE_ENV !== "production";

  const as: oauth.AuthorizationServer = {
    issuer,
    authorization_endpoint: oauthConfig.authorizeUrl,
    token_endpoint: oauthConfig.tokenUrl,
    userinfo_endpoint: oauthConfig.userinfoUrl,
    ...(appConfig.OIDC_LOGOUT_URL ? { end_session_endpoint: appConfig.OIDC_LOGOUT_URL } : {}),
  };

  const client: oauth.Client = {
    client_id: oauthConfig.clientId,
  };

  const clientAuth: oauth.ClientAuth = oauthConfig.clientSecret
    ? oauth.ClientSecretPost(oauthConfig.clientSecret)
    : oauth.None();

  cached = { key, as, client, clientAuth, insecure };
  return cached;
}

/** Drop the cached configuration. Test-only — production never swaps. */
export function __resetOidcConfigForTests(): void {
  cached = null;
}

/**
 * Compute the per-request options bag that opts into HTTP-only endpoints.
 * oauth4webapi reads `[allowInsecureRequests]` off the options argument of
 * each request function (NOT off the AuthorizationServer object). Plain
 * HTTP is rejected by default; we opt in when the operator's config is
 * fully http and we are not in production. Production stays strict.
 */
function insecureOptions(appConfig: Config, oauthConfig: OAuthConfig): { [oauth.allowInsecureRequests]?: true } {
  const { insecure } = buildAs(oauthConfig, appConfig);
  return insecure ? { [oauth.allowInsecureRequests]: true } : {};
}

// ─── PKCE / state helpers (delegating to oauth4webapi) ───

export function randomState(): string {
  return oauth.generateRandomState();
}

export function randomPkceVerifier(): string {
  return oauth.generateRandomCodeVerifier();
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return await oauth.calculatePKCECodeChallenge(verifier);
}

// ─── Authorization URL ───

export function buildAuthorizeUrl(args: {
  oauth: OAuthConfig;
  appConfig: Config;
  callbackUrl: string;
  state: string;
  codeChallenge?: string | undefined;
}): string {
  const { as } = buildAs(args.oauth, args.appConfig);
  if (!as.authorization_endpoint)
    throw new Error("authorization_endpoint not configured");
  const url = new URL(as.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.oauth.clientId);
  url.searchParams.set("redirect_uri", args.callbackUrl);
  url.searchParams.set("scope", args.appConfig.OAUTH_SCOPES);
  url.searchParams.set("state", args.state);
  if (args.codeChallenge) {
    url.searchParams.set("code_challenge", args.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

// ─── Authorization-code grant ───

export interface OidcTokens {
  readonly access_token: string;
  readonly refresh_token?: string | undefined;
  readonly expires_in?: number | undefined;
  readonly id_token?: string | undefined;
}

export async function exchangeCodeForTokens(args: {
  oauth: OAuthConfig;
  appConfig: Config;
  callbackUrl: URL;
  expectedState: string;
  codeVerifier?: string | undefined;
}): Promise<OidcTokens> {
  const { as, client, clientAuth } = buildAs(args.oauth, args.appConfig);

  // Validate the authorization response (state, error, code presence).
  // `validateAuthResponse` throws on mismatch / missing code.
  const params = oauth.validateAuthResponse(as, client, args.callbackUrl.searchParams, args.expectedState);

  const redirectUri = `${args.callbackUrl.origin}${args.callbackUrl.pathname}`;
  const verifier: string | typeof oauth.nopkce = args.codeVerifier ?? oauth.nopkce;
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    clientAuth,
    params,
    redirectUri,
    verifier,
    insecureOptions(args.appConfig, args.oauth),
  );

  const tokens = await oauth.processAuthorizationCodeResponse(as, client, response);
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    id_token: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
  };
}

// ─── Userinfo ───

export interface OidcUserInfo {
  readonly sub: string;
  readonly preferred_username?: string;
  readonly username?: string;
  readonly name?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly picture?: string;
}

export async function fetchUserInfo(args: {
  oauth: OAuthConfig;
  appConfig: Config;
  accessToken: string;
  expectedSub: string;
}): Promise<OidcUserInfo> {
  const { as, client } = buildAs(args.oauth, args.appConfig);
  const response = await oauth.userInfoRequest(as, client, args.accessToken, insecureOptions(args.appConfig, args.oauth));
  // When we don't know the sub yet (no id_token, or id_token absent), pass
  // the skipSubjectCheck symbol — oauth4webapi enforces a strict equality
  // check otherwise and aborts. The caller still trusts the userinfo body
  // through the access-token gate.
  const expected: string | typeof oauth.skipSubjectCheck = args.expectedSub
    ? args.expectedSub
    : oauth.skipSubjectCheck;
  const userinfo = await oauth.processUserInfoResponse(as, client, expected, response);
  return userinfo as OidcUserInfo;
}

// ─── Refresh ───

export async function refreshTokens(args: {
  oauth: OAuthConfig;
  appConfig: Config;
  refreshToken: string;
}): Promise<OidcTokens> {
  const { as, client, clientAuth } = buildAs(args.oauth, args.appConfig);
  const response = await oauth.refreshTokenGrantRequest(as, client, clientAuth, args.refreshToken, insecureOptions(args.appConfig, args.oauth));
  const tokens = await oauth.processRefreshTokenResponse(as, client, response);
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    id_token: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
  };
}

// ─── Revocation (RFC 7009) ───

const RE_TOKEN_PATH = /\/token\/?$/;

export async function revokeToken(args: {
  oauth: OAuthConfig;
  appConfig: Config;
  token: string;
  hint?: "access_token" | "refresh_token";
}): Promise<void> {
  const { as, client, clientAuth, insecure } = buildAs(args.oauth, args.appConfig);

  // 1. Use the discovered revocation_endpoint if the IdP advertised one.
  if (as.revocation_endpoint) {
    try {
      const opts: oauth.RevocationRequestOptions = {
        ...insecureOptions(args.appConfig, args.oauth),
        ...(args.hint ? { additionalParameters: new URLSearchParams({ token_type_hint: args.hint }) } : {}),
      };
      const response = await oauth.revocationRequest(as, client, clientAuth, args.token, opts);
      await oauth.processRevocationResponse(response);
      return;
    }
    catch {
      // best-effort: fall through to RFC 7009 path-replacement guess
    }
  }

  // 2. Fallback: derive `/revoke` from `/token`. Some IdPs implement it
  //    without exposing it via discovery (Okta historically, Keycloak in
  //    older versions). Skip when the URL doesn't end in `/token`.
  const revocationUrl = args.oauth.tokenUrl.replace(RE_TOKEN_PATH, "/revoke");
  if (revocationUrl === args.oauth.tokenUrl)
    return;
  if (revocationUrl.startsWith("http://") && !insecure)
    return; // never POST a token to plain HTTP outside dev
  try {
    const body = new URLSearchParams({
      token: args.token,
      token_type_hint: args.hint ?? "access_token",
      client_id: args.oauth.clientId,
    });
    if (args.oauth.clientSecret)
      body.set("client_secret", args.oauth.clientSecret);
    await fetch(revocationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(5_000),
    });
  }
  catch {
    // best-effort; do not fail logout if provider is unreachable
  }
}
