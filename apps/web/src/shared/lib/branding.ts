/**
 * Single source of truth for the application's brand identity on the
 * frontend. Values are injected at build time from the APP_NAME and
 * APP_DISPLAY_NAME env vars (mirrored into VITE_* by vite.config.ts).
 *
 * To rebrand a fork, set those env vars before the build — do not edit
 * call sites.
 */

const env = import.meta.env as Record<string, string | undefined>;

/** Lowercase slug. Used for filenames, localStorage keys, etc. */
export const APP_NAME = env.VITE_APP_NAME ?? "app";

/** Human-readable display name. Used for HTML title, login screen, etc. */
export const APP_DISPLAY_NAME = env.VITE_APP_DISPLAY_NAME ?? "App";

/**
 * Build a Web Storage key namespaced by {@link APP_NAME}. Two installs of
 * this template under the same browser origin (e.g. `/app-a` and `/app-b`
 * behind the same reverse proxy, or both at `localhost` during dev) share a
 * single localStorage / sessionStorage namespace; without the prefix, theme,
 * language, and per-feature state collide silently. Always route storage
 * keys through this helper instead of writing raw string literals.
 */
export function storageKey(suffix: string): string {
  return `${APP_NAME}:${suffix}`;
}
