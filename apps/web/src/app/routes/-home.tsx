import { Landing } from "./-landing";

/**
 * The home page, shown at `/` when `HOME_PAGE` is `base` or `root` (see
 * `.env.example`). It is public and makes no authenticated call.
 */
export function HomePage() {
  return <Landing />;
}
