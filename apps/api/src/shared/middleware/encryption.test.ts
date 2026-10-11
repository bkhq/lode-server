import type { AppEnv } from "@/shared/lib/types";
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { EncryptionState } from "@/modules/encryption/state";
import { AppError } from "@/shared/lib/errors";
import { requireUnlocked } from "./encryption";

function buildApp(encryption: EncryptionState) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("encryption", encryption);
    return next();
  });
  app.use("*", requireUnlocked);
  app.get("/p", c => c.json({ ok: true }));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 503);
    }
    return c.json({ error: { code: "INTERNAL", message: String(err) } }, 500);
  });
  return app;
}

describe("requireUnlocked", () => {
  test("503 SYSTEM_LOCKED when initialized but not unlocked", async () => {
    const enc = new EncryptionState();
    enc.setInitialized(true);
    const res = await buildApp(enc).request("/p");
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("SYSTEM_LOCKED");
  });

  test("passes through when uninitialized (setup mode is not 'locked')", async () => {
    const enc = new EncryptionState();
    const res = await buildApp(enc).request("/p");
    expect(res.status).toBe(200);
  });

  test("passes through when DEK is set (system unlocked)", async () => {
    const enc = new EncryptionState();
    enc.setOnUnlock(async () => {});
    enc.beginOperation();
    try {
      await enc.setDek("a".repeat(64));
    }
    finally {
      enc.endOperation();
    }
    const res = await buildApp(enc).request("/p");
    expect(res.status).toBe(200);
  });
});
