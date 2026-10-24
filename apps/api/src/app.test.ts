import type { AppDeps } from "./app";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { customAlphabet } from "nanoid";
import { configSchema } from "@/config/schema";
import { createDb } from "@/db";
import { __resetRouteBindingsForTests, getAllRouteBindings } from "@/modules/policy";
import { registerRouteBinding } from "@/modules/policy/route-registry";
import { buildFullApp } from "./app";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = resolve(tmpdir(), `test-app-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  db = await createDb(resolve(dir, "test.db"));
});

afterEach(() => {
  db.close();
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

function deps(): AppDeps {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    flush() {},
  } as unknown as Logger;
  // Sweeps and the scheduler stay off: nothing here should outlive the test.
  const config = configSchema.parse({
    NODE_ENV: "test",
    FILE_STORAGE_LOCAL_ROOT: resolve(dir, "files"),
    FILE_GC_INTERVAL_SECONDS: "0",
    REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS: "0",
  });
  const encryption = {
    isSystemLocked: () => false,
  } as unknown as AppDeps["encryption"];
  return { config, db, logger, encryption };
}

describe("buildFullApp", () => {
  test("boots with the registry module's policy route bindings", async () => {
    // Importing ./app loads every protected module, so this is the live
    // binding set.
    expect(getAllRouteBindings().some(b => b.resourceName === "package" && b.path.startsWith("/registry/packages/"))).toBe(true);

    const app = await buildFullApp(deps());

    expect((await app.request("/api/health")).status).toBe(200);
    // A bound route is gated by the policy middleware before any handler.
    expect((await app.request("/api/registry/packages/acme/tool")).status).toBe(401);
  });

  test("refuses to build when no policy route binding is registered", async () => {
    const saved = getAllRouteBindings();
    __resetRouteBindingsForTests();
    try {
      expect(getAllRouteBindings()).toEqual([]);
      await expect(buildFullApp(deps())).rejects.toThrow(/no route bindings registered/);
    }
    finally {
      for (const binding of saved)
        registerRouteBinding(binding);
    }
    expect(getAllRouteBindings()).toEqual(saved);
  });
});
