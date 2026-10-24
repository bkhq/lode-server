import { BASE_PATH } from "@/shared/lib/http";

/**
 * `HOME_PAGE` on the server (see its entry in `.env.example`): where the
 * home page lives. `off` — nowhere; `base` — at `${BASE_PATH}/`; `root` — at
 * the origin's `/`, outside BASE_PATH.
 */
export type HomePageMode = "off" | "base" | "root";

/**
 * The page is the origin's `/` while the app is mounted under a prefix. The
 * server only serves the SPA there in `root` mode; the router has to be
 * built without the prefix to match it.
 */
export function isOriginRootPage(pathname: string = window.location.pathname): boolean {
  return BASE_PATH !== "" && pathname === "/";
}

/**
 * Whether the `/` route renders the home page rather than sending the
 * visitor into the app. Without a BASE_PATH the two places coincide.
 */
export function showsHome(mode: HomePageMode, atOriginRoot: boolean = isOriginRootPage(), basePath: string = BASE_PATH): boolean {
  if (mode === "off")
    return false;
  if (basePath === "")
    return true;
  return mode === "root"
    ? atOriginRoot
    : !atOriginRoot;
}
