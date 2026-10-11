import type { NavArea, NavItem } from "./types";

// Every `-<name>.nav.ts` beside a route is a sidebar entry. Vite resolves the
// glob at build time, so a module adds its entry by dropping the file in —
// no edit here. The `-` prefix keeps the router generator from treating it
// as a route.
const navModules = import.meta.glob<Record<string, NavItem>>(
  "../../../app/routes/**/-*.nav.ts",
  { eager: true },
);

const NAV_ITEMS: readonly NavItem[] = Object.values(navModules).flatMap(m => Object.values(m));

export function getNavItems(area: NavArea): NavItem[] {
  return NAV_ITEMS
    .filter(item => item.area === area)
    .toSorted((a, b) => a.order - b.order);
}
