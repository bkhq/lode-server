import type { Context } from "hono";
import type { LockoutPolicy, LockoutState } from "./lockout.service";
import type { AppDatabase } from "@/db";
import type { AppEnv } from "@/shared/lib/types";
import { Buffer } from "node:buffer";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { clearSessionCookie, cookiePath, readSessionId, writeSessionCookie } from "@/modules/account/auth/session-cookie";
import {
  consumeTotpChallenge,
  createTotpChallenge,
  hasVerifiedTotp,
  verifyTotpCode,
} from "@/modules/account/users/totp.service";
import { audit, auditMeta } from "@/modules/audit/audit.service";
import { deriveOrigin, getAuthConfig, getOAuthConfig, getOidcLogoutUrl, getSingleUserConfig, isLocalLogin, isOAuthConfigured, isSingleUserMode } from "@/shared/lib/app-config";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonOk, TAGS } from "@/shared/lib/openapi";
import { consumeRateLimit } from "@/shared/middleware/rate-limit";
import { applyIdpGroups } from "../groups/idp-sync";
import {
  consumePkceEntry,
  createPkceChallenge,
  createSession,
  deleteSession,
  getSessionWithUser,
  isSingleUserSession,
  SINGLE_USER_ACCESS_TOKEN,
  upsertSingleUser,
  upsertUser,
} from "./auth.service";
import { loginLocalUser } from "./local-login";
import { clearAllLockouts, clearFailures, isLocked, recordFailure } from "./lockout.service";
import { buildAuthorizeUrl, exchangeCodeForTokens, fetchUserInfo, revokeToken } from "./oidc";
import { verifyPassword } from "./password";

// eslint-disable-next-line no-control-regex
const RE_CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

/**
 * Thrown when the IdP returned an id_token that is present but cannot be
 * parsed into a usable `sub` (malformed JWT, non-string/absent `sub`
 * claim). This is an auth failure — NOT the same as a token-less pure
 * OAuth2 response. Treating an unparseable id_token as "no id_token"
 * would silently downgrade to `skipSubjectCheck`, dropping the sub
 * binding the IdP intended us to enforce.
 */
class IdTokenError extends Error {}

/**
 * Decode `sub` from the id_token JWT payload without verifying the
 * signature. We pass it to openid-client's `fetchUserInfo` as
 * `expectedSub` — the library performs the actual sub-match check
 * against the userinfo response.
 *
 * Three outcomes, deliberately distinct:
 *   - id_token genuinely absent (pure OAuth2 provider) → return `null`;
 *     the caller may skip the sub assertion.
 *   - id_token present and yields a string `sub` → return it.
 *   - id_token present but unparseable / missing a string `sub` → throw
 *     `IdTokenError`. The IdP committed to OIDC by sending a token; a
 *     broken one is an auth failure, not a reason to skip the binding.
 */
function readIdTokenSub(idToken: string | undefined): string | null {
  if (!idToken)
    return null;
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1])
    throw new IdTokenError("id_token present but not a well-formed JWT");
  let payload: { sub?: unknown };
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as { sub?: unknown };
  }
  catch {
    throw new IdTokenError("id_token payload is not valid JSON");
  }
  if (typeof payload.sub !== "string" || payload.sub === "")
    throw new IdTokenError("id_token payload has no usable string `sub` claim");
  return payload.sub;
}

// Test-only surface for the three-way id_token distinction (absent vs
// valid vs present-but-unparseable). Not used by runtime callers.
export const __readIdTokenSubForTests = readIdTokenSub;
export const __IdTokenErrorForTests = IdTokenError;
// In production we use `__Secure-` (not `__Host-`) for auxiliary cookies so
// multiple instances on one origin under different `BASE_PATH`s don't clobber
// each other's cookies via the forced `Path=/`. Dev uses the plain name
// because `__Secure-` requires HTTPS.
const TOTP_PENDING_COOKIE_PROD = "__Secure-totp_pending";
const TOTP_PENDING_COOKIE_DEV = "totp_pending";

function totpPendingCookieName(env: "production" | "development" | "test"): string {
  return env === "production"
    ? TOTP_PENDING_COOKIE_PROD
    : TOTP_PENDING_COOKIE_DEV;
}

// Browser-side `state` binding — closes the gap where PKCE alone proves
// "the same browser holds the verifier" but does NOT prove "the same
// browser kicked the flow off". Issued at /login, asserted at /callback.
const OAUTH_STATE_COOKIE_PROD = "__Secure-oauth_state";
const OAUTH_STATE_COOKIE_DEV = "oauth_state";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

function oauthStateCookieName(env: "production" | "development" | "test"): string {
  return env === "production"
    ? OAUTH_STATE_COOKIE_PROD
    : OAUTH_STATE_COOKIE_DEV;
}

// --- Per-IP rate limiter for auth endpoints ---
// 120/min/IP is comfortably above realistic human throughput (a user
// initiates login at most a handful of times per minute) yet below the
// "many concurrent test callers behind one NAT" floor that would lock
// out a developer or an integration suite. Both /login and /callback
// share this bucket — together they cap the total auth-flow churn from
// any one peer in a sliding minute.
const AUTH_RATE_WINDOW_MS = 60_000;
const AUTH_RATE_MAX = 120;

/**
 * Rate-limit key. Defers to `getClientIp` so `TRUST_PROXY=true` deployments
 * key per-end-user IP (X-Real-IP / right-most X-Forwarded-For) instead of
 * collapsing the entire tenant onto the proxy's peer IP.
 */
export function rateLimitKey(c: Context<AppEnv>): string {
  return getClientIp(c, c.get("config"));
}

/** Returns 0 when allowed, else seconds remaining until the bucket resets. */
function checkAuthRateLimit(ip: string): Promise<number> {
  return consumeRateLimit({
    bucket: "auth",
    key: ip,
    windowMs: AUTH_RATE_WINDOW_MS,
    max: AUTH_RATE_MAX,
  });
}

// --- Per-username lockout for single-user login ---
// The IP-keyed limiter above caps brute-force from one peer, but an
// attacker rotating proxies / residential IPs can still grind a single
// account. Lock the account after N consecutive failures for a fixed
// window, mirroring the per-user TOTP lockout. State lives in
// `auth_lockouts` (see `lockout.service.ts`) so the counter survives
// process restarts and is shared across replicas.
const SINGLE_USER_LOCKOUT_POLICY: LockoutPolicy = {
  threshold: 10,
  windowMs: 15 * 60 * 1000,
};

function singleUserLockoutKey(username: string): string {
  return `single-user:${username.toLowerCase()}`;
}

export async function isSingleUserLocked(
  db: AppDatabase,
  username: string,
): Promise<LockoutState> {
  return isLocked(db, singleUserLockoutKey(username));
}

async function recordSingleUserFailure(db: AppDatabase, username: string): Promise<LockoutState> {
  return recordFailure(db, singleUserLockoutKey(username), SINGLE_USER_LOCKOUT_POLICY);
}

async function clearSingleUserFailures(db: AppDatabase, username: string): Promise<void> {
  await clearFailures(db, singleUserLockoutKey(username));
}

/** Test hook — drop every persisted lockout row between specs. */
export async function __resetSingleUserLockoutForTests(db: AppDatabase): Promise<void> {
  await clearAllLockouts(db);
}

/**
 * Password sign-in for a database account (LOCAL_LOGIN). Failures answer the
 * same whether the username exists or not. With two-step verification on, the
 * session waits for the code, exactly as after an OIDC login: the pending
 * challenge rides in a cookie and `/account/auth/totp/verify` finishes it.
 */
async function signInLocalAccount(c: Context<AppEnv>, usernameRaw: string, password: string): Promise<Response> {
  const db = c.get("db");
  const config = c.get("config");
  const result = await loginLocalUser(db, usernameRaw, password);

  if (result.status === "locked") {
    c.header("Retry-After", String(result.retryAfterSeconds));
    return c.json({
      success: false,
      error: { code: "ACCOUNT_LOCKED", message: "Account temporarily locked. Try again later." },
    }, 429);
  }
  if (result.status === "invalid") {
    await audit(db, c.get("logger"), {
      actorId: "system",
      actorName: "system",
      action: "auth.login_failed",
      resourceType: "auth",
      resourceId: "",
      resourceName: "local",
      detail: {
        username: usernameRaw.slice(0, 64),
      },
      ...auditMeta(c),
      result: "failure",
    });
    return c.json({
      success: false,
      error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" },
    }, 401);
  }

  const { user } = result;
  const authCfg = await getAuthConfig(db, config);

  if (await hasVerifiedTotp(db, user.id)) {
    const challengeId = await createTotpChallenge(
      db,
      user.id,
      SINGLE_USER_ACCESS_TOKEN,
      undefined,
      authCfg.sessionMaxAge,
      `${config.BASE_PATH}/overview`,
    );
    setCookie(c, totpPendingCookieName(config.NODE_ENV), challengeId, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "Lax",
      path: cookiePath(config.BASE_PATH),
      maxAge: 300,
    });
    return c.json({
      success: true,
      data: { totpRequired: true },
    });
  }

  // The sentinel marks a session with no OAuth tokens behind it, so logout
  // skips the IdP revoke.
  const sessionId = await createSession(db, user.id, SINGLE_USER_ACCESS_TOKEN, undefined, authCfg.sessionMaxAge);
  writeSessionCookie(c, config.NODE_ENV, config.BASE_PATH, sessionId, authCfg.sessionMaxAge);
  await audit(db, c.get("logger"), {
    actorId: user.id,
    actorName: user.name,
    action: "auth.login",
    resourceType: "user",
    resourceId: user.id,
    resourceName: user.username,
    detail: { mode: "local" },
    ...auditMeta(c),
    result: "success",
  });
  return c.json({
    success: true,
    data: { id: user.id, username: user.username, name: user.name },
  });
}

// Collapse `/` and `\` runs that browsers may treat as protocol prefixes
// (`/\evil.com`, `\\evil.com`) before the prefix check.
const RE_LEADING_SLASHES = /^[/\\]+/;
const RE_BACKSLASH = /\\/g;

/**
 * Build a redirect to the SPA's shared `/error` page. Every auth failure
 * path goes through here so the user always sees the same Card-based
 * error layout. The frontend reads `?code` and `?detail` and renders an
 * i18n message; the Retry button uses the browser's own history (no
 * server-side "back" pointer needed). `detail` is truncated to defend
 * against runaway IdP error_description payloads.
 */
type LoginErrorCode = "oauth_not_configured" | "oauth_state_invalid" | "oidc_error" | "user_disabled" | "single_user_mode_active";

function buildLoginErrorUrl(basePath: string, code: LoginErrorCode, detail?: string): string {
  const url = new URL(`http://placeholder${basePath}/error`);
  url.searchParams.set("code", code);
  if (detail) {
    url.searchParams.set("detail", detail.slice(0, 200));
  }
  return `${url.pathname}${url.search}`;
}

function sanitizeRedirect(raw: string, basePath: string): string {
  // Reject:
  //  - empty / non-`/` strings (relative paths could resolve to current host
  //    + path which is what we want, but we keep the gate strict to avoid
  //    accidental ".." or scheme-relative escapes)
  //  - protocol-relative `//evil.com` / `/\evil.com` / `\\evil.com`
  //  - colon-bearing pseudo-protocols (`/javascript:alert(1)` — browsers
  //    technically reject as a navigation target, but defence in depth)
  //  - anything outside the application's BASE_PATH so a tampered redirect
  //    cannot bounce a logged-in user into an admin route their session is
  //    valid for but the UI never showed them
  const fallback = `${basePath}/`;
  if (typeof raw !== "string" || raw.length === 0)
    return fallback;
  // Re-shape backslashes into slashes so the prefix check cannot be evaded
  // via `\foo` (some browsers normalise this to `/foo` mid-flight).
  const normalised = raw.replace(RE_BACKSLASH, "/");
  // Strip leading slash runs and re-prefix with a single `/` to defeat
  // protocol-relative attempts.
  const stripped = normalised.replace(RE_LEADING_SLASHES, "");
  const candidate = `/${stripped}`;
  if (candidate.includes(":"))
    return fallback;
  // Must live under our BASE_PATH (or be exactly the base). Reject paths
  // pointing at the API itself; the SPA never redirects callers there.
  if (candidate !== basePath && !candidate.startsWith(`${basePath}/`))
    return fallback;
  if (candidate.startsWith(`${basePath}/api/`) || candidate === `${basePath}/api`)
    return fallback;
  return candidate;
}

export function authRoutes() {
  const router = new Hono<AppEnv>();

  // GET /account/auth/login — initiate OAuth flow (with optional PKCE)
  router.get(
    "/account/auth/login",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Initiate login",
      description: "Starts the OAuth/OIDC authorization flow and redirects to the IdP. Redirects to the SPA error page in single-user mode or when OAuth is not configured.",
      responses: {
        302: { description: "Redirect to the IdP authorize endpoint, or to the SPA error page on misconfiguration" },
        ...errors(429),
      },
    }),
    async (c) => {
      {
        const retryAfter = await checkAuthRateLimit(rateLimitKey(c));
        if (retryAfter > 0) {
          c.header("Retry-After", String(retryAfter));
          return c.json({
            success: false,
            error: { code: "RATE_LIMITED", message: "Too many requests" },
          }, 429);
        }
      }
      const config = c.get("config");
      const base = config.BASE_PATH;
      // Single-user mode short-circuits the OAuth dance. The SPA renders the
      // local username/password form instead, so an OAuth-initiated login is
      // an explicit operator misconfiguration — surface it loudly.
      if (isSingleUserMode(config)) {
        return c.redirect(buildLoginErrorUrl(base, "single_user_mode_active"), 302);
      }
      // OAuth is a hard requirement: refuse to start the dance when any of
      // OAUTH_CLIENT_ID / OAUTH_*_URL is missing, instead of letting
      // getOAuthConfig throw into Hono's default 500 handler. Bouncing back
      // to /login with a banner-friendly error code keeps the user in the
      // SPA flow.
      if (!isOAuthConfigured(config)) {
        return c.redirect(buildLoginErrorUrl(base, "oauth_not_configured"), 302);
      }
      const oauth = getOAuthConfig(config);
      const callbackUrl = `${deriveOrigin(c.req.raw, config)}${base}/api/account/auth/callback`;
      const redirectUri = sanitizeRedirect(c.req.query("redirect") ?? `${base}/portal`, base);

      const { state, codeChallenge } = await createPkceChallenge(c.get("db"), redirectUri);
      const authorizeUrl = buildAuthorizeUrl({
        oauth,
        appConfig: config,
        callbackUrl,
        state,
        codeChallenge: oauth.pkce
          ? await codeChallenge
          : undefined,
      });

      // Bind `state` to this browser via an httpOnly cookie. /callback rejects
      // any callback whose query state does not match the cookie — closes the
      // session-fixation hole that PKCE alone leaves open.
      setCookie(c, oauthStateCookieName(config.NODE_ENV), state, {
        httpOnly: true,
        secure: config.NODE_ENV === "production",
        sameSite: "Lax",
        path: cookiePath(base),
        maxAge: OAUTH_STATE_TTL_SECONDS,
      });

      return c.redirect(authorizeUrl, 302);
    },
  );

  // GET /account/auth/callback — OAuth callback
  router.get(
    "/account/auth/callback",
    describeRoute({
      tags: [TAGS.Account],
      summary: "OAuth callback",
      description: "Handles the IdP redirect: validates state, exchanges the code for tokens, then redirects to the original target (or to TOTP verification / the SPA error page).",
      responses: {
        302: { description: "Redirect to the post-login target, the TOTP verification page, or the SPA error page" },
        ...errors(429),
      },
    }),
    async (c) => {
      {
        const retryAfter = await checkAuthRateLimit(rateLimitKey(c));
        if (retryAfter > 0) {
          c.header("Retry-After", String(retryAfter));
          return c.json({
            success: false,
            error: { code: "RATE_LIMITED", message: "Too many requests" },
          }, 429);
        }
      }
      const db = c.get("db");
      const config = c.get("config");
      const logger = c.get("logger");
      const base = config.BASE_PATH;
      // Same guard as /login: if the OAuth config was wiped between the user
      // bouncing out to the IdP and bouncing back, surface a real error
      // instead of letting getOAuthConfig throw into a 500.
      if (!isOAuthConfigured(config)) {
        return c.redirect(buildLoginErrorUrl(base, "oauth_not_configured"), 302);
      }
      const oauth = getOAuthConfig(config);
      const authCfg = await getAuthConfig(db, config);

      const code = c.req.query("code");
      const state = c.req.query("state");
      const error = c.req.query("error");

      if (error) {
        const rawDesc = c.req.query("error_description") ?? error;
        const desc = rawDesc.replace(RE_CONTROL_CHARS, "").slice(0, 200);
        logger.warn({ error, desc }, "OAuth authorization error");
        await audit(db, c.get("logger"), {
          actorId: "system",
          actorName: "system",
          action: "auth.login_failed",
          resourceType: "auth",
          resourceId: "",
          resourceName: "oauth",
          detail: { error, description: desc },
          ...auditMeta(c),
          result: "failure",
        });
        return c.redirect(buildLoginErrorUrl(base, "oidc_error", desc), 302);
      }

      if (!code || !state) {
        return c.redirect(buildLoginErrorUrl(base, "oauth_state_invalid"), 302);
      }

      // `state` must match the cookie planted at /login. A reload after the
      // browser closed (or a CSRF-style cross-browser callback delivery) loses
      // the cookie — reject explicitly so the user re-initiates login.
      const cookieName = oauthStateCookieName(config.NODE_ENV);
      const cookieState = getCookie(c, cookieName);
      // Mirror the attributes it was set with. In production the name carries
      // the `__Secure-` prefix, and Hono refuses to write such a cookie —
      // even the expiring one a deletion emits — without `secure`, so leaving
      // it out threw here and turned every production OIDC callback into a
      // 500. The path must match too, or the browser keeps the original.
      deleteCookie(c, cookieName, {
        path: cookiePath(base),
        secure: config.NODE_ENV === "production",
      });
      if (!cookieState || cookieState !== state) {
        return c.redirect(buildLoginErrorUrl(base, "oauth_state_invalid"), 302);
      }

      const pkceEntry = await consumePkceEntry(c.get("db"), state);
      if (!pkceEntry) {
        return c.redirect(buildLoginErrorUrl(base, "oauth_state_invalid"), 302);
      }

      const origin = deriveOrigin(c.req.raw, config);
      const callbackUrl = new URL(`${origin}${base}/api/account/auth/callback`);
      // Mirror the inbound query string so openid-client can validate the
      // full set of response parameters in a single pass.
      for (const [k, v] of new URL(c.req.url).searchParams)
        callbackUrl.searchParams.append(k, v);
      let tokens;
      try {
        tokens = await exchangeCodeForTokens({
          oauth,
          appConfig: config,
          callbackUrl,
          expectedState: state,
          codeVerifier: oauth.pkce ? pkceEntry.codeVerifier : undefined,
        });
      }
      catch (err) {
        logger.error({
          err: err instanceof Error
            ? err.message
            : String(err),
          code: (err as { code?: unknown }).code,
        }, "OAuth token exchange failed");
        return c.redirect(buildLoginErrorUrl(base, "oidc_error", "Token exchange failed"), 302);
      }
      // Resolve the expected `sub` BEFORE the userinfo call so a present-
      // but-unparseable id_token fails closed as an auth error instead of
      // silently downgrading to `skipSubjectCheck`. A genuinely absent
      // id_token (pure OAuth2 IdP) yields `null` → skip is acceptable.
      let idTokenSub: string | null;
      try {
        idTokenSub = readIdTokenSub(tokens.id_token);
      }
      catch (err) {
        logger.error({
          err: err instanceof Error
            ? err.message
            : String(err),
        }, "OAuth id_token rejected");
        return c.redirect(buildLoginErrorUrl(base, "oidc_error", "Invalid id_token"), 302);
      }
      let userInfo;
      try {
      // expectedSub === "" tells fetchUserInfo to skipSubjectCheck — only
      // reached when the IdP sent no id_token at all (pure OAuth2).
        userInfo = await fetchUserInfo({
          oauth,
          appConfig: config,
          accessToken: tokens.access_token,
          expectedSub: idTokenSub ?? "",
        });
      }
      catch (err) {
        logger.error({
          err: err instanceof Error
            ? err.message
            : String(err),
        }, "OAuth userinfo fetch failed");
        return c.redirect(buildLoginErrorUrl(base, "oidc_error", "Userinfo fetch failed"), 302);
      }
      let user;
      try {
        user = await upsertUser(db, userInfo, authCfg, logger);
      }
      catch (err) {
        if (err instanceof AppError && err.code === "ACCOUNT_CONFLICT") {
          logger.warn({ username: userInfo.preferred_username }, "OIDC login refused: account conflict");
          return c.redirect(buildLoginErrorUrl(base, "oidc_error", "This account is already registered another way"), 302);
        }
        throw err;
      }

      if (user.status === "disabled") {
        logger.warn({ username: user.username }, "login denied: user is disabled");
        return c.redirect(buildLoginErrorUrl(base, "user_disabled"), 302);
      }

      await applyIdpGroups(db, {
        claim: config.OAUTH_GROUPS_CLAIM,
        userId: user.id,
        userInfo: userInfo as unknown as Record<string, unknown>,
        idToken: tokens.id_token,
        logger,
      });

      // Check if user has TOTP enabled — if so, defer session creation
      const totpEnabled = await hasVerifiedTotp(db, user.id);
      if (totpEnabled) {
        const challengeId = await createTotpChallenge(
          db,
          user.id,
          tokens.access_token,
          tokens.refresh_token,
          tokens.expires_in,
          pkceEntry.redirectUri,
        );
        setCookie(c, totpPendingCookieName(config.NODE_ENV), challengeId, {
          httpOnly: true,
          secure: config.NODE_ENV === "production",
          sameSite: "Lax",
          path: cookiePath(base),
          maxAge: 300,
        });
        return c.redirect(`${base}/totp-verify`, 302);
      }

      const sessionId = await createSession(
        db,
        user.id,
        tokens.access_token,
        tokens.refresh_token,
        authCfg.sessionMaxAge,
      );

      writeSessionCookie(c, config.NODE_ENV, config.BASE_PATH, sessionId, authCfg.sessionMaxAge);

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "auth.login",
        resourceType: "user",
        resourceId: user.id,
        resourceName: user.username,
        ...auditMeta(c),
        result: "success",
      });

      return c.redirect(sanitizeRedirect(pkceEntry.redirectUri, base), 302);
    },
  );

  // POST /account/auth/logout — destroy session
  router.post(
    "/account/auth/logout",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Log out",
      description: "Destroys the current session (if any), best-effort revokes IdP tokens, and clears the session cookie.",
      responses: {
        ...jsonOk(z.null(), "Logged out"),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const config = c.get("config");
      const sessionId = readSessionId(c);

      let logoutUser: { id: string; name: string; username: string } | undefined;
      if (sessionId) {
        const result = await getSessionWithUser(db, sessionId);
        if (result) {
          logoutUser = result.user;
          // Best-effort OAuth token revocation. Sessions minted by the
          // single-user flow carry the SINGLE_USER_ACCESS_TOKEN sentinel,
          // not a real IdP bearer — skip the revocation call entirely in
          // that case, both to avoid noise at the IdP and to keep the
          // sentinel value out of any audit / metrics surface the
          // openid-client library emits. openid-client picks the
          // discovered revocation_endpoint (with RFC 7009 path-replacement
          // fallback) so we don't have to guess the URL.
          if (!isSingleUserSession(result.session.accessToken)) {
            try {
              const oauth = getOAuthConfig(config);
              await revokeToken({
                oauth,
                appConfig: config,
                token: result.session.accessToken,
                hint: "access_token",
              });
              if (result.session.refreshToken) {
                await revokeToken({
                  oauth,
                  appConfig: config,
                  token: result.session.refreshToken,
                  hint: "refresh_token",
                });
              }
            }
            catch { /* non-critical */ }
          }
        }
        await deleteSession(db, sessionId);
      }

      clearSessionCookie(c, config.NODE_ENV, config.BASE_PATH);

      if (logoutUser) {
        await audit(db, c.get("logger"), {
          actorId: logoutUser.id,
          actorName: logoutUser.name,
          action: "auth.logout",
          resourceType: "user",
          resourceId: logoutUser.id,
          resourceName: logoutUser.username,
          ...auditMeta(c),
          result: "success",
        });
      }

      return c.json({ success: true, data: null });
    },
  );

  // GET /account/auth/logout-url — public, returns OIDC logout URL for account switching
  router.get(
    "/account/auth/logout-url",
    describeRoute({
      tags: [TAGS.Account],
      summary: "OIDC logout URL",
      description: "Public. Returns the IdP end-session URL used for account switching (null when not configured).",
      responses: {
        ...jsonOk(z.object({
          url: z.string().nullable(),
        }), "Logout URL"),
      },
    }),
    async (c) => {
      const config = c.get("config");
      const url = getOidcLogoutUrl(config);
      return c.json({
        success: true,
        data: { url },
      });
    },
  );

  // GET /account/auth/mode — public, surfaces which login UI to render
  // GET /account/auth/mode — anonymous; tells the SPA which login form
  // to render (OAuth button vs. single-user form). The fields below are
  // intentionally minimal because anonymous responses are observable
  // posture data:
  //   - `mode` is required so the SPA can render the right form
  //     without an extra round-trip on every login attempt.
  //   - `oauthConfigured` is required to decide whether the OAuth
  //     button should be rendered at all (a misconfigured deploy
  //     should not leave a dead button on the login page).
  // Brute-force exposure on the single-user surface is neutralised by
  // the per-username lockout in `/account/auth/login-local` — the
  // mode-leak is no longer an actionable triage signal for an attacker.
  router.get(
    "/account/auth/mode",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Login mode",
      description: "Public. Tells the SPA which login UI to render (OAuth vs. single-user) and whether OAuth is configured.",
      responses: {
        ...jsonOk(z.object({
          mode: z.enum(["single-user", "oauth"]),
          oauthConfigured: z.boolean(),
          localLogin: z.boolean(),
        }), "Login mode"),
      },
    }),
    (c) => {
      const config = c.get("config");
      return c.json({
        success: true,
        data: {
          mode: isSingleUserMode(config)
            ? "single-user"
            : "oauth",
          oauthConfigured: isOAuthConfigured(config),
          // Password sign-in for database accounts, offered next to OAuth.
          localLogin: isLocalLogin(config),
        },
      });
    },
  );

  // POST /account/auth/login-local — public, env-credential login (single-user mode)
  router.post(
    "/account/auth/login-local",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Single-user login",
      description: "Public. Username/password login: the configured account in single-user mode, or any account with a password under LOCAL_LOGIN. Uses timing-safe verification and a per-username lockout. When the account has two-step verification the response is `{ totpRequired: true }` and the code is sent to /account/auth/totp/verify.",
      responses: {
        ...jsonOk(z.object({
          id: z.string(),
          username: z.string(),
          name: z.string(),
        }).or(z.object({
          totpRequired: z.literal(true),
        })), "Logged in, or two-step verification required"),
        ...errors(400, 401, 404, 429),
      },
    }),
    async (c) => {
      {
        const retryAfter = await checkAuthRateLimit(rateLimitKey(c));
        if (retryAfter > 0) {
          c.header("Retry-After", String(retryAfter));
          return c.json({
            success: false,
            error: { code: "RATE_LIMITED", message: "Too many requests" },
          }, 429);
        }
      }

      const db = c.get("db");
      const config = c.get("config");
      const logger = c.get("logger");

      const singleUser = isSingleUserMode(config);
      if (!singleUser && !isLocalLogin(config)) {
        return c.json({
          success: false,
          error: { code: "SINGLE_USER_DISABLED", message: "Password login is not enabled" },
        }, 404);
      }

      let body: { username?: unknown; password?: unknown };
      try {
        body = await c.req.json();
      }
      catch {
        return c.json({
          success: false,
          error: { code: "INVALID_BODY", message: "Invalid JSON body" },
        }, 400);
      }

      const usernameRaw = typeof body.username === "string"
        ? body.username
        : "";
      const password = typeof body.password === "string"
        ? body.password
        : "";
      if (!usernameRaw || !password) {
        return c.json({
          success: false,
          error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" },
        }, 400);
      }

      if (!singleUser)
        return await signInLocalAccount(c, usernameRaw, password);

      const single = getSingleUserConfig(config);

      // Per-username lockout (proxy-rotation-resistant). Checked against the
      // configured account *and* the submitted account so the attacker cannot
      // probe past the lock by varying the username field on each request.
      for (const candidate of [single.username, usernameRaw]) {
        const lock = await isSingleUserLocked(db, candidate);
        if (lock.locked) {
          c.header("Retry-After", String(lock.retryAfterSeconds));
          return c.json(
            {
              success: false,
              error: { code: "ACCOUNT_LOCKED", message: "Account temporarily locked. Try again later." },
            },
            429,
          );
        }
      }

      const usernameMatches = usernameRaw.toLowerCase() === single.username;

      // Always run the password verify even when the username does not match —
      // keeps the comparison time roughly constant and avoids leaking which of
      // the two halves was wrong.
      let passwordMatches: boolean;
      try {
        passwordMatches = await verifyPassword(password, single.passwordHash);
      }
      catch (err) {
        // The hash could not be checked — a missing primitive, or one the
        // runtime refuses at this cost. That is a server fault, not a bad
        // credential: answering 401 would blame the operator's password,
        // record a lockout failure against them, and hide the real problem.
        const reason = err instanceof Error
          ? err.message
          : String(err);
        logger.error({ err: reason }, "single-user password verify failed");
        throw new AppError("Password verification is unavailable on this runtime", 500, "PASSWORD_VERIFY_UNAVAILABLE");
      }

      if (!usernameMatches || !passwordMatches) {
      // Record against the configured account regardless of which half failed;
      // an attacker spraying random usernames against a single real account
      // should hit the same shared lock as a direct attack.
        await recordSingleUserFailure(db, single.username);
        await audit(db, c.get("logger"), {
          actorId: "system",
          actorName: "system",
          action: "auth.login_failed",
          resourceType: "auth",
          resourceId: "",
          resourceName: "single-user",
          detail: {
            username: usernameRaw.slice(0, 64),
          },
          ...auditMeta(c),
          result: "failure",
        });
        return c.json({
          success: false,
          error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" },
        }, 401);
      }

      await clearSingleUserFailures(db, single.username);

      const user = await upsertSingleUser(db, {
        username: single.username,
        name: single.name,
        email: single.email,
      });

      const authCfg = await getAuthConfig(db, config);
      const sessionId = await createSession(
        db,
        user.id,
        SINGLE_USER_ACCESS_TOKEN,
        undefined,
        authCfg.sessionMaxAge,
      );
      writeSessionCookie(c, config.NODE_ENV, config.BASE_PATH, sessionId, authCfg.sessionMaxAge);

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "auth.login",
        resourceType: "user",
        resourceId: user.id,
        resourceName: user.username,
        detail: { mode: "single-user" },
        ...auditMeta(c),
        result: "success",
      });

      return c.json({
        success: true,
        data: { id: user.id, username: user.username, name: user.name },
      });
    },
  );

  // POST /account/auth/totp/verify — verify TOTP during login
  router.post(
    "/account/auth/totp/verify",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Verify TOTP challenge",
      description: "Public. Completes login by verifying the 6-digit TOTP code against the pending challenge cookie, then creates the session. Per-user lockout applies.",
      responses: {
        ...jsonOk(z.object({
          redirect: z.string(),
        }), "Verified, session created"),
        ...errors(400, 429),
      },
    }),
    async (c) => {
      {
        const retryAfter = await checkAuthRateLimit(rateLimitKey(c));
        if (retryAfter > 0) {
          c.header("Retry-After", String(retryAfter));
          return c.json({
            success: false,
            error: { code: "RATE_LIMITED", message: "Too many requests" },
          }, 429);
        }
      }
      const db = c.get("db");
      const config = c.get("config");

      const challengeId = getCookie(c, totpPendingCookieName(config.NODE_ENV))
        ?? getCookie(c, TOTP_PENDING_COOKIE_DEV);
      if (!challengeId) {
        return c.json({
          success: false,
          error: { code: "NO_PENDING_TOTP", message: "No pending TOTP challenge" },
        }, 400);
      }

      const body = await c.req.json();
      const code = typeof body.code === "string"
        ? body.code
        : "";
      if (code.length !== 6) {
        return c.json({
          success: false,
          error: { code: "INVALID_CODE", message: "Code must be 6 digits" },
        }, 400);
      }

      const challenge = await consumeTotpChallenge(db, challengeId);
      if (!challenge) {
        deleteCookie(c, totpPendingCookieName(config.NODE_ENV), {
          path: cookiePath(config.BASE_PATH),
          secure: config.NODE_ENV === "production",
        });
        return c.json({
          success: false,
          error: { code: "EXPIRED_CHALLENGE", message: "TOTP challenge expired, please login again" },
        }, 400);
      }

      // Per-user lockout precedes verifyTotpCode so 5 wrong codes from rotating
      // IPs still trip the gate (per-IP limiter alone misses that vector).
      const { isTotpUserLocked } = await import("@/modules/account/users/totp.service");
      const lockState = await isTotpUserLocked(db, challenge.userId);
      if (lockState.locked) {
        deleteCookie(c, totpPendingCookieName(config.NODE_ENV), {
          path: cookiePath(config.BASE_PATH),
          secure: config.NODE_ENV === "production",
        });
        c.header("Retry-After", String(lockState.retryAfterSeconds));
        return c.json(
          {
            success: false,
            error: { code: "TOTP_USER_LOCKED", message: "Too many failed attempts. Restart login after the lockout expires." },
          },
          429,
        );
      }

      const ok = await verifyTotpCode(db, challenge.userId, code);
      if (!ok) {
      // After verifyTotpCode flipped the failure counter, re-check whether
      // this attempt tipped the user over the threshold so we surface the
      // 429 immediately instead of inviting another guess.
        const stateAfter = await isTotpUserLocked(db, challenge.userId);
        if (stateAfter.locked) {
          deleteCookie(c, totpPendingCookieName(config.NODE_ENV), {
            path: cookiePath(config.BASE_PATH),
            secure: config.NODE_ENV === "production",
          });
          c.header("Retry-After", String(stateAfter.retryAfterSeconds));
          return c.json(
            {
              success: false,
              error: { code: "TOTP_USER_LOCKED", message: "Too many failed attempts. Restart login after the lockout expires." },
            },
            429,
          );
        }
        // Re-create challenge so user can retry
        const newId = await createTotpChallenge(
          db,
          challenge.userId,
          challenge.accessToken,
          challenge.refreshToken ?? undefined,
          challenge.expiresIn ?? undefined,
          challenge.redirectUri,
        );
        setCookie(c, totpPendingCookieName(config.NODE_ENV), newId, {
          httpOnly: true,
          secure: config.NODE_ENV === "production",
          sameSite: "Lax",
          path: cookiePath(config.BASE_PATH),
          maxAge: 300,
        });
        return c.json({
          success: false,
          error: { code: "TOTP_VERIFY_FAILED", message: "Invalid TOTP code" },
        }, 400);
      }

      deleteCookie(c, totpPendingCookieName(config.NODE_ENV), {
        path: cookiePath(config.BASE_PATH),
        secure: config.NODE_ENV === "production",
      });

      const authCfg = await getAuthConfig(db, config);
      const sessionId = await createSession(
        db,
        challenge.userId,
        challenge.accessToken,
        challenge.refreshToken ?? undefined,
        authCfg.sessionMaxAge,
      );

      writeSessionCookie(c, config.NODE_ENV, config.BASE_PATH, sessionId, authCfg.sessionMaxAge);

      // Resolve the human name for the audit row — challenge.userId is just
      // the opaque id, which makes the audit log unreadable in the UI.
      const { getUserById } = await import("@/modules/account/users/users.service");
      const challengeUser = await getUserById(db, challenge.userId);
      await audit(db, c.get("logger"), {
        actorId: challenge.userId,
        actorName: challengeUser?.name ?? challenge.userId,
        action: "auth.login",
        resourceType: "user",
        resourceId: challenge.userId,
        resourceName: "totp-verified",
        ...auditMeta(c),
        result: "success",
      });

      return c.json({
        success: true,
        data: {
          redirect: sanitizeRedirect(challenge.redirectUri, config.BASE_PATH),
        },
      });
    },
  );

  return router;
}
