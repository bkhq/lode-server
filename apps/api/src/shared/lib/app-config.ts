import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import { parseDefaultAdmins } from "@/config";
import { getSetting, setSetting } from "@/modules/settings/settings.service";

export async function getAppSetting(
  db: AppDatabase,
  key: string,
  envFallback?: string,
  defaultValue?: string,
): Promise<string | undefined> {
  const fromDb = await getSetting(db, key);
  if (fromDb !== null)
    return fromDb;
  if (envFallback !== undefined)
    return envFallback;
  return defaultValue;
}

// --- Resolved config types ---

export interface OAuthConfig {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly userinfoUrl: string;
  readonly pkce: boolean;
}

export interface AuthConfig {
  readonly sessionMaxAge: number;
  readonly defaultAdmins: readonly string[];
}

/**
 * Non-throwing predicate so callers can decide between "redirect with a
 * user-facing banner" and "let the exception bubble into a 500". Mirrors
 * the validation in `getOAuthConfig` — keep them in sync.
 */
export function isOAuthConfigured(config: Config): boolean {
  return Boolean(
    config.OAUTH_CLIENT_ID
    && config.OAUTH_AUTHORIZE_URL
    && config.OAUTH_TOKEN_URL
    && config.OAUTH_USERINFO_URL,
  );
}

export interface SingleUserConfig {
  readonly username: string;
  readonly passwordHash: string;
  readonly name: string;
  readonly email: string;
}

export function isSingleUserMode(config: Config): boolean {
  return Boolean(
    config.SINGLE_USER_MODE
    && config.SINGLE_USER_USERNAME
    && config.SINGLE_USER_PASSWORD_HASH,
  );
}

/** Password sign-in for database accounts is on, and single-user mode is not taking its place. */
export function isLocalLogin(config: Config): boolean {
  return config.LOCAL_LOGIN && !isSingleUserMode(config);
}

/** The admin named by SINGLE_USER_* under LOCAL_LOGIN, created at boot; undefined when not configured. */
export function getBootstrapAdmin(config: Config): SingleUserConfig | undefined {
  if (!isLocalLogin(config) || !config.SINGLE_USER_USERNAME || !config.SINGLE_USER_PASSWORD_HASH)
    return undefined;
  return getSingleUserConfig(config);
}

export function getSingleUserConfig(config: Config): SingleUserConfig {
  if (!config.SINGLE_USER_USERNAME || !config.SINGLE_USER_PASSWORD_HASH) {
    throw new Error("Single-user mode not configured (set SINGLE_USER_USERNAME and SINGLE_USER_PASSWORD_HASH)");
  }
  const username = config.SINGLE_USER_USERNAME.toLowerCase();
  return {
    username,
    passwordHash: config.SINGLE_USER_PASSWORD_HASH,
    name: config.SINGLE_USER_NAME ?? config.SINGLE_USER_USERNAME,
    email: (config.SINGLE_USER_EMAIL ?? `${username}@local`).toLowerCase(),
  };
}

export function getOAuthConfig(config: Config): OAuthConfig {
  const clientId = config.OAUTH_CLIENT_ID;
  if (!clientId)
    throw new Error("OAuth client_id not configured (set OAUTH_CLIENT_ID env var)");

  const authorizeUrl = config.OAUTH_AUTHORIZE_URL;
  const tokenUrl = config.OAUTH_TOKEN_URL;
  const userinfoUrl = config.OAUTH_USERINFO_URL;
  if (!authorizeUrl || !tokenUrl || !userinfoUrl) {
    throw new Error("OAuth endpoints not configured (set OAUTH_ISSUER or OAuth endpoint env vars)");
  }

  return {
    clientId,
    clientSecret: config.OAUTH_CLIENT_SECRET,
    authorizeUrl,
    tokenUrl,
    userinfoUrl,
    pkce: config.OAUTH_PKCE,
  };
}

export async function getAuthConfig(db: AppDatabase, config: Config): Promise<AuthConfig> {
  const maxAge = await getAppSetting(db, "session.max_age", String(config.SESSION_MAX_AGE), "86400");
  return {
    sessionMaxAge: Number(maxAge),
    defaultAdmins: parseDefaultAdmins(config.DEFAULT_ADMIN),
  };
}

export function getOidcLogoutUrl(config: Config): string | null {
  return config.OIDC_LOGOUT_URL ?? null;
}

/**
 * Derive the origin (scheme + host) used to build OAuth callback URLs.
 *
 * - Production: `APP_URL` is required (enforced at boot in `loadConfig`).
 *   The runtime branch below is defense-in-depth in case the boot check is
 *   bypassed or this code is exercised from a test that injects a partial
 *   config; it should never fire on a properly-launched production process.
 * - Non-production: falls back to `X-Forwarded-*` (when behind a trusted
 *   proxy) and finally to the request URL itself.
 */
const RE_TRAILING_SLASHES = /\/+$/;

export function deriveOrigin(req: Request, config: Config): string {
  if (config.APP_URL) {
    return config.APP_URL.replace(RE_TRAILING_SLASHES, "");
  }
  if (config.NODE_ENV === "production") {
    throw new Error(
      "APP_URL must be set in production. Forwarded headers are not trusted in production to derive OAuth callback URLs.",
    );
  }
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

export async function seedSettingsFromEnv(db: AppDatabase, config: Config): Promise<void> {
  if ((await getSetting(db, "session.max_age")) === null)
    await setSetting(db, "session.max_age", String(config.SESSION_MAX_AGE));
}
