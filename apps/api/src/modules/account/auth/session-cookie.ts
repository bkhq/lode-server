import type { Context } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

/**
 * Single source of truth for the session cookie name + read / write / clear.
 *
 * In production we prefix with `__Secure-`: browsers refuse to honour the
 * cookie unless it is `Secure`, which closes the cross-protocol leak path.
 * `__Host-` is intentionally not used — it forces `Path=/`, which would let
 * two instances sharing one origin under different `BASE_PATH`s overwrite
 * each other's session cookies. With `__Secure-` we keep per-instance
 * `Path=${BASE_PATH}/` scoping and the `SameSite=Lax` + `HttpOnly` + `Secure`
 * triad.
 *
 * In development (plain HTTP) the `__Secure-` prefix is incompatible with the
 * missing Secure flag, so we fall back to the plain name. Reads accept either
 * name so that flipping `NODE_ENV` between starts on the same browser doesn't
 * strand the user mid-session.
 *
 * The OAuth state and TOTP-pending cookies apply the same pattern in
 * `auth.routes.ts` — keep all three consistent if you tune one.
 */

const SESSION_COOKIE_PROD = "__Secure-session_id";
const SESSION_COOKIE_DEV = "session_id";

export function sessionCookieName(env: "production" | "development" | "test"): string {
  return env === "production" ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
}

/**
 * Regex matching the session cookie in a raw `Cookie` header under the prod
 * prefix or the dev plain name. Used by the CSRF guard to detect "this request
 * has a session cookie" without parsing the whole header.
 */
export const RE_ANY_SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?session_id=/;

export function readSessionId(c: Context<AppEnv>): string | undefined {
  return getCookie(c, SESSION_COOKIE_PROD) ?? getCookie(c, SESSION_COOKIE_DEV);
}

/** Normalise BASE_PATH ("" or "/foo") into a non-empty cookie Path. */
export function cookiePath(basePath: string): string {
  return basePath === "" ? "/" : basePath;
}

/**
 * Set the session cookie under the environment-appropriate name. The
 * `__Secure-` rules force `Secure`; we add `SameSite=Lax` + `HttpOnly` and
 * scope to `${BASE_PATH}/` so two instances sharing one origin do not
 * overwrite each other.
 */
export function writeSessionCookie(
  c: Context<AppEnv>,
  env: "production" | "development" | "test",
  basePath: string,
  sessionId: string,
  maxAge: number,
): void {
  const isProd = env === "production";
  setCookie(c, sessionCookieName(env), sessionId, {
    httpOnly: true,
    secure: isProd,
    sameSite: "Lax",
    path: cookiePath(basePath),
    maxAge,
  });
}

/**
 * Clear the session cookie. We delete both the prod-prefixed and the plain
 * variants so a flipped NODE_ENV still tears down stale cookies. Variants
 * whose prefix demands `Secure` must be deleted with `secure: true`; hono's
 * `deleteCookie` throws otherwise.
 */
export function clearSessionCookie(
  c: Context<AppEnv>,
  env: "production" | "development" | "test",
  basePath: string,
): void {
  const path = cookiePath(basePath);
  if (env === "production") {
    deleteCookie(c, SESSION_COOKIE_PROD, { path, secure: true });
  }
  deleteCookie(c, SESSION_COOKIE_DEV, { path });
}
