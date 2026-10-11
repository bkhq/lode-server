import type { PolicyContext } from "./registry";

/**
 * Sentinel no-op logger for read-only policy checks invoked outside a
 * request scope (e.g. `getDocumentPermission`). The mutating hooks
 * (`onGranted` / `onRevoked`) are never triggered on read paths, so a
 * no-op is semantically equivalent to the request logger here.
 */
export const NOOP_POLICY_LOGGER: PolicyContext["logger"] = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
  reopen: () => {},
};
