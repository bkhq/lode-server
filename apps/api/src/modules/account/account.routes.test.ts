import { describe, expect, it } from "bun:test";
import { accountRoutes } from "./account.routes";

describe("accountRoutes aggregator", () => {
  it("constructs and mounts at least one sub-route", () => {
    const router = accountRoutes();
    expect(typeof router.fetch).toBe("function");
    expect((router.routes as unknown[]).length).toBeGreaterThan(0);
  });
});
