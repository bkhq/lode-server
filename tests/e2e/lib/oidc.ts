import { ApiClient, CookieJar, DEX_BASE } from "./api";

const RE_FORM_ACTION = /<form[^>]*action="([^"]+)"/i;

// Cache logged-in clients per email so successive tests don't burn through
// the auth rate limit (default 30 attempts / minute / IP). Tests that want a
// fresh session call `loginAs(...)` directly to bypass the cache.
const sessionCache = new Map<string, ApiClient>();

export async function getClient(email: string, password = "admin"): Promise<ApiClient> {
  const cached = sessionCache.get(email);
  if (cached?.cookies.has("session_id")) {
    // The cached cookie may still exist client-side while the server has
    // already revoked the session (status flipped to disabled, sessions
    // table cleared, etc.). Cheap probe via /me — if it 401s, drop the
    // cache and log in fresh.
    const probe = await cached.raw("/api/account/me");
    if (probe.ok)
      return cached;
    sessionCache.delete(email);
  }
  const c = await loginAs(email, password);
  sessionCache.set(email, c);
  return c;
}

export function dropCachedSession(email: string): void {
  sessionCache.delete(email);
}

/**
 * Walk the full OIDC login dance against the live dex IdP and the live API.
 *
 * Steps (HTTP-only, no browser):
 *   1. GET /api/account/auth/login → 302 to dex /auth/local
 *   2. Follow the chain of dex internal redirects until we land on the form
 *      page (POST /dex/auth/local?req=…).
 *   3. Submit credentials.
 *   4. dex redirects back to the API callback with code + state.
 *   5. The API exchanges the code, persists the user, and sets the session
 *      cookie. Done — `client.cookies` now carries the session.
 */
export async function loginAs(email: string, password: string): Promise<ApiClient> {
  const client = new ApiClient();
  const dexCookies = new CookieJar();

  // 1. Hit /login on the API; follow the redirect chain into dex.
  let res = await client.raw("/api/account/auth/login");
  let location = res.headers.get("location");
  if (!location)
    throw new Error(`expected /login to 302, got ${res.status}`);

  // 2. Follow up to ~10 redirects across dex and API to reach a form (POST)
  //    or the final callback. Dex uses internal /auth → /auth/local hops.
  let formAction: string | null = null;
  for (let i = 0; i < 10; i++) {
    res = await fetch(location, {
      method: "GET",
      redirect: "manual",
      headers: dexCookies.header() ? { Cookie: dexCookies.header() } : {},
    });
    dexCookies.capture(res);

    const next = res.headers.get("location");
    if (next) {
      location = next.startsWith("http") ? next : new URL(next, location).toString();
      // If dex redirects back to the API callback, hand off to the API client
      // so it picks up the session cookie issued by the callback handler.
      if (location.includes("/api/account/auth/callback")) {
        const path = location.replace(client.base, "");
        const cb = await client.raw(path);
        const cbLoc = cb.headers.get("location");
        if (!cbLoc || (cb.status !== 302 && cb.status !== 303)) {
          throw new Error(`callback returned ${cb.status}, expected redirect (body: ${await cb.text()})`);
        }
        if (!client.cookies.has("session_id")) {
          throw new Error(`callback did not set session_id cookie (location: ${cbLoc})`);
        }
        return client;
      }
      continue;
    }

    // Body must contain a form. Parse the action and submit credentials.
    const html = await res.text();
    const match = RE_FORM_ACTION.exec(html);
    if (!match || !match[1])
      throw new Error(`no <form action> found at ${location}; body head: ${html.slice(0, 200)}`);
    // Decode HTML entities in the action URL — dex serves `&amp;` for form
    // attributes, so the raw match would otherwise be a malformed URL.
    const action = match[1].replaceAll("&amp;", "&");
    formAction = action.startsWith("http") ? action : new URL(action, location).toString();
    break;
  }

  if (!formAction)
    throw new Error("dex login form not reached after 10 hops");

  // 3. Submit credentials.
  const body = new URLSearchParams({ login: email, password });
  res = await fetch(formAction, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(dexCookies.header() ? { Cookie: dexCookies.header() } : {}),
    },
    body: body.toString(),
  });
  dexCookies.capture(res);
  location = res.headers.get("location");
  if (!location)
    throw new Error(`dex form POST: expected redirect, got ${res.status} (body: ${(await res.text()).slice(0, 200)})`);

  // 4. dex returns a chain ending at our callback. Walk it.
  for (let i = 0; i < 10; i++) {
    if (location.includes("/api/account/auth/callback")) {
      const path = location.startsWith(client.base) ? location.slice(client.base.length) : location.replace(/^https?:\/\/[^/]+/, "");
      const cb = await client.raw(path);
      const cbLoc = cb.headers.get("location");
      if (!cbLoc || (cb.status !== 302 && cb.status !== 303)) {
        throw new Error(`callback returned ${cb.status}, expected redirect (body: ${await cb.text()})`);
      }
      if (!client.cookies.has("session_id")) {
        throw new Error(`callback did not set session_id cookie`);
      }
      return client;
    }
    const url = location.startsWith("http") ? location : new URL(location, DEX_BASE).toString();
    const next = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: dexCookies.header() ? { Cookie: dexCookies.header() } : {},
    });
    dexCookies.capture(next);
    const nextLoc = next.headers.get("location");
    if (!nextLoc) {
      throw new Error(`unexpected non-redirect at ${url}; body: ${(await next.text()).slice(0, 200)}`);
    }
    location = nextLoc;
  }

  throw new Error("OIDC callback never reached after dex login");
}
