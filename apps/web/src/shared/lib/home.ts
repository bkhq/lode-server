/**
 * The SPA's home page lives at the origin root, outside BASE_PATH, so a
 * temporary landing page can stand in front of an app mounted under a prefix.
 * The API serves the SPA shell at this path (see `HOME_PATH` in the API's
 * app.ts); the router has to be built without the base prefix to match it.
 */
export const HOME_PATH = "/home";

export function isHomePage(pathname: string = window.location.pathname): boolean {
  return pathname === HOME_PATH || pathname === `${HOME_PATH}/`;
}
