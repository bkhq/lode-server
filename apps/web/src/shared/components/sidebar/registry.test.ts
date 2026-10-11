import type { NavItem } from "./types";
import { describe, expect, it } from "vitest";
import { getNavItems } from "./registry";

// What the registry should contain, found independently of it: any nav file
// anywhere under app/routes, however it is named. A file the registry's own
// pattern misses shows up here as a missing key.
const navFiles = import.meta.glob<Record<string, NavItem>>("/src/app/routes/**/*.nav.{ts,tsx}", { eager: true });
const navItemsOnDisk: NavItem[] = Object.values(navFiles).flatMap(m => Object.values(m));

describe("getNavItems", () => {
  it("registers every nav file under app/routes", () => {
    const onDisk = navItemsOnDisk;
    expect(onDisk.length).toBeGreaterThan(0);
    const registered = [...getNavItems("main"), ...getNavItems("admin")];
    expect(registered.map(i => i.key).toSorted()).toEqual(onDisk.map(i => i.key).toSorted());
  });

  it.each(["main", "admin"] as const)("returns only %s entries, sorted by order", (area) => {
    const items = getNavItems(area);
    expect(items.every(i => i.area === area)).toBe(true);
    const orders = items.map(i => i.order);
    expect(orders).toEqual(orders.toSorted((a, b) => a - b));
  });

  it("gives every entry a unique key", () => {
    const keys = navItemsOnDisk.map(i => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
