/**
 * The same-origin path a login may continue to, or `fallback`.
 *
 * A browser reads `\` as `/` in a URL, so `/\host` leaves the site just as
 * `//host` does; resolving against the page's origin catches every spelling.
 */
export function safeRedirect(url: string | undefined, origin: string, fallback: string): string {
  if (!url || !url.startsWith("/"))
    return fallback;
  try {
    const resolved = new URL(url, origin);
    if (resolved.origin !== origin)
      return fallback;
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  }
  catch {
    return fallback;
  }
}
