/**
 * The URL `nsl` serves a route name at, or null when nsl cannot answer.
 * `nsl get` answers from the daemon's port whether or not the route is
 * registered yet, so it works before the caller's own `nsl run`.
 */
export function nslGet(name: string): string | null {
  const result = Bun.spawnSync(["nsl", "get", name]);
  const url = result.stdout.toString().trim();
  return result.exitCode === 0 && url.startsWith("http")
    ? url
    : null;
}
