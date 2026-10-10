import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "@/app/routeTree.gen";
import { isHomePage } from "./home";

describe("isHomePage", () => {
  it("matches /home with or without a trailing slash", () => {
    expect(isHomePage("/home")).toBe(true);
    expect(isHomePage("/home/")).toBe(true);
  });

  it("does not match the app's own pages or look-alikes", () => {
    for (const path of ["/", "/app/home", "/homepage", "/home/x", "/overview"])
      expect(isHomePage(path)).toBe(false);
  });
});

describe("the home route", () => {
  it("resolves at the origin root when the router has no base prefix", async () => {
    const router = createRouter({ routeTree, basepath: "/", history: createMemoryHistory({ initialEntries: ["/home"] }) });
    await router.load();
    expect(router.state.matches.map(m => m.routeId)).toContain("/home");
  });

  it("does not resolve at the origin root under a base prefix, which is why main.tsx drops it", async () => {
    const router = createRouter({ routeTree, basepath: "/app", history: createMemoryHistory({ initialEntries: ["/home"] }) });
    await router.load();
    expect(router.state.matches.map(m => m.routeId)).not.toContain("/home");
  });
});
