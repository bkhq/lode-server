/**
 * The SPA on Workers when the app is mounted under a BASE_PATH.
 *
 * Without a BASE_PATH the platform's asset pipeline serves the SPA by itself
 * (see `[assets]` in wrangler.toml) and this module is never reached. With
 * one, the build references `${BASE_PATH}/assets/…` but its files sit at the
 * root of the build directory, which the pipeline cannot remap, so the
 * Worker is configured to run first for `/` and `${BASE_PATH}/*` and does the
 * mapping here: strip the prefix, ask the asset binding.
 */

interface AssetBinding {
  fetch: (request: Request) => Promise<Response>;
}

export interface SpaEnv {
  ASSETS?: AssetBinding | undefined;
  BASE_PATH?: unknown;
  HOME_PAGE?: unknown;
}

function normalizedBasePath(value: unknown): string {
  const trimmed = typeof value === "string"
    ? value.replace(/^\/+|\/+$/g, "")
    : "";
  return trimmed === ""
    ? ""
    : `/${trimmed}`;
}

/**
 * The response for a request the SPA owns, or undefined when it belongs to
 * the app (the API) or to the platform (no BASE_PATH).
 */
export async function serveSpaRequest(request: Request, env: SpaEnv): Promise<Response | undefined> {
  const base = normalizedBasePath(env.BASE_PATH);
  if (base === "" || env.ASSETS === undefined)
    return undefined;

  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/") {
    // The origin root is the SPA's home page only with HOME_PAGE=root;
    // otherwise it points at the app, as the Bun server does.
    if (env.HOME_PAGE === "root")
      return env.ASSETS.fetch(request);
    return new Response(`<meta http-equiv="refresh" content="0;url=${base}/">`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (path !== base && !path.startsWith(`${base}/`))
    return undefined;
  const rest = path.slice(base.length) || "/";
  if (rest === "/api" || rest.startsWith("/api/"))
    return undefined;

  url.pathname = rest;
  return env.ASSETS.fetch(new Request(url, request));
}
