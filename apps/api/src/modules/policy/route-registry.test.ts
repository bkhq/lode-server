import { describe, expect, test } from "bun:test";
import { customAlphabet } from "nanoid";
import { getRouteBindingsForResource, registerRouteBinding } from "./route-registry";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

describe("registerRouteBinding", () => {
  // The binding table is a process-wide singleton shared with every other
  // test file, so use paths nothing else can collide with instead of
  // resetting it.
  test("throws on a second binding for the same (method, path) instead of double-gating the route", () => {
    const resourceName = `dup-${nanoid()}`;
    const path = `/${resourceName}/:id`;
    registerRouteBinding({ resourceName, method: "GET", path, action: "read" });

    expect(() => registerRouteBinding({ resourceName, method: "GET", path, action: "read" }))
      .toThrow(/already bound/);
    expect(getRouteBindingsForResource(resourceName)).toHaveLength(1);
  });

  test("the same path under a different method is a distinct binding", () => {
    const resourceName = `methods-${nanoid()}`;
    const path = `/${resourceName}/:id`;
    registerRouteBinding({ resourceName, method: "GET", path, action: "read" });
    registerRouteBinding({ resourceName, method: "DELETE", path, action: "delete" });
    expect(getRouteBindingsForResource(resourceName)).toHaveLength(2);
  });
});
