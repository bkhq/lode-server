import type { Config } from "./schema";
import { readFileSync } from "node:fs";
import { ConfigError } from "./errors";

// Recognised password hash prefixes — argon2{i,d,id}, bcrypt
// ($2a/$2b/$2y), and the project's own pbkdf2-sha256 form. A
// non-matching hash silently fails verifyPassword on every login
// attempt, so reject at boot rather than waste an operator's
// debugging time.
const RE_VALID_PASSWORD_HASH = /^(?:\$argon2(?:i|d|id)\$|\$2[aby]\$|pbkdf2-sha256\$)/;

/**
 * Read a password hash file. Picks the first non-blank, non-comment
 * line. If that line matches the htpasswd `<user>:<hash>` shape, the
 * prefix up to (and including) the first `:` is stripped. Trailing
 * whitespace is trimmed in both cases. Empty result throws so the
 * boot guard surfaces the misconfiguration loudly.
 *
 * Exported for unit-testability; production callers reach it via
 * `resolveSingleUserConfig`.
 */
export function readPasswordHashFile(path: string): string {
  const text = readFileSync(path, "utf-8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#"))
      continue;
    const colon = line.indexOf(":");
    const hash = colon >= 0
      ? line.slice(colon + 1).trim()
      : line;
    if (hash)
      return hash;
  }
  throw new Error(`no hash found in ${path}`);
}

/**
 * Resolve the single-user mode configuration in place: read the hash
 * file when only the path was provided, then validate the result.
 * Mutates `data.SINGLE_USER_PASSWORD_HASH` so the rest of `loadConfig`
 * sees the same field whether the operator used the inline or
 * file-based form. No-op when `SINGLE_USER_MODE` is off.
 *
 * Throws `ConfigError` on any failure; the orchestrating `loadConfig`
 * decides whether to print + exit or surface for tests.
 */
export function resolveSingleUserConfig(
  data: Config,
  resolvePath: (p: string) => string,
): void {
  // Under LOCAL_LOGIN the same fields are optional: they name a bootstrap
  // admin, validated only when any of them is set.
  const bootstrapAdmin = data.LOCAL_LOGIN
    && Boolean(data.SINGLE_USER_USERNAME || data.SINGLE_USER_PASSWORD_HASH || data.SINGLE_USER_PASSWORD_HASH_FILE);
  if (!data.SINGLE_USER_MODE && !bootstrapAdmin)
    return;

  if (!data.SINGLE_USER_PASSWORD_HASH && data.SINGLE_USER_PASSWORD_HASH_FILE) {
    try {
      data.SINGLE_USER_PASSWORD_HASH = readPasswordHashFile(resolvePath(data.SINGLE_USER_PASSWORD_HASH_FILE));
    }
    catch (err) {
      throw new ConfigError(
        `SINGLE_USER_PASSWORD_HASH_FILE could not be read: ${err instanceof Error
          ? err.message
          : String(err)}`,
        { field: "SINGLE_USER_PASSWORD_HASH_FILE" },
      );
    }
  }
  if (!data.SINGLE_USER_USERNAME || !data.SINGLE_USER_PASSWORD_HASH) {
    throw new ConfigError(
      "SINGLE_USER_MODE=true (or a bootstrap admin under LOCAL_LOGIN) requires SINGLE_USER_USERNAME and SINGLE_USER_PASSWORD_HASH (or SINGLE_USER_PASSWORD_HASH_FILE).",
      {
        field: "SINGLE_USER_USERNAME",
        hint: "Examples: `htpasswd -B -n admin > .secret/hash` or `bun run hash-password`.",
      },
    );
  }
  if (!RE_VALID_PASSWORD_HASH.test(data.SINGLE_USER_PASSWORD_HASH)) {
    throw new ConfigError(
      "SINGLE_USER_PASSWORD_HASH does not match a recognised hash format.",
      {
        field: "SINGLE_USER_PASSWORD_HASH",
        hint: "Expected an argon2id (`$argon2id$…`), bcrypt (`$2a$…` / `$2b$…` / `$2y$…`), or PBKDF2-SHA256 (`pbkdf2-sha256$…`) hash. Generate one via `bun run hash-password` or `htpasswd -B -n admin`.",
      },
    );
  }
}

/**
 * True iff the deployment uses OAuth for at least some logins. Used
 * by `loadConfig` to gate the CORS_ORIGIN / APP_URL boot guards —
 * a pure single-user deployment has no OAuth callback to protect.
 */
export function oauthInPlay(data: Config): boolean {
  return !data.SINGLE_USER_MODE || data.OAUTH_CLIENT_ID !== undefined;
}
