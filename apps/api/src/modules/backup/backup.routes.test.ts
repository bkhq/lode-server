import { describe, expect, it } from "bun:test";
import { backupRoutes } from "./backup.routes";

describe("backupRoutes aggregator", () => {
  it("constructs a router that composes export + restore sub-routers", () => {
    const router = backupRoutes();
    expect(router).toBeDefined();
    expect(typeof router.fetch).toBe("function");
    expect((router.routes as unknown[]).length).toBeGreaterThan(0);
  });
});
