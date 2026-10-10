import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createDb } from "@/db";
import { loginLocalUser } from "@/modules/account/auth/local-login";
import { hashPassword } from "@/modules/account/auth/password";
import { users } from "@/modules/account/users/schema";
import { seedBootstrapAdmin } from "./local-users.service";

const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {} } as unknown as Logger;

let dir: string;
let db: AppDatabase;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "bootstrap-admin-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function config(overrides: Partial<Config> = {}): Promise<Config> {
  return {
    LOCAL_LOGIN: true,
    SINGLE_USER_MODE: false,
    SINGLE_USER_USERNAME: "Root",
    SINGLE_USER_PASSWORD_HASH: await hashPassword("first passphrase here"),
    ...overrides,
  } as unknown as Config;
}

describe("seedBootstrapAdmin", () => {
  test("creates an active admin that can sign in with the configured password", async () => {
    await seedBootstrapAdmin(db, await config(), logger);
    const result = await loginLocalUser(db, "root", "first passphrase here");
    expect(result.status).toBe("ok");
    const row = (await db.select().from(users).where(eq(users.username, "root")).get())!;
    expect(row).toMatchObject({ role: "admin", status: "active", email: "root@local" });
  });

  test("is authoritative at every boot: a changed password, a demotion or a disable is undone", async () => {
    await seedBootstrapAdmin(db, await config(), logger);
    await db.update(users).set({ role: "user", status: "disabled" }).where(eq(users.username, "root")).run();
    await seedBootstrapAdmin(db, await config({ SINGLE_USER_PASSWORD_HASH: await hashPassword("second passphrase here") }), logger);
    expect((await loginLocalUser(db, "root", "first passphrase here")).status).toBe("invalid");
    const again = await loginLocalUser(db, "root", "second passphrase here");
    expect(again.status === "ok" && again.user.role).toBe("admin");
  });

  test("seeds nothing unless LOCAL_LOGIN is on, single-user mode is off and credentials are set", async () => {
    await seedBootstrapAdmin(db, await config({ LOCAL_LOGIN: false }), logger);
    await seedBootstrapAdmin(db, await config({ SINGLE_USER_MODE: true }), logger);
    await seedBootstrapAdmin(db, await config({ SINGLE_USER_USERNAME: undefined }), logger);
    expect(await db.select().from(users).all()).toEqual([]);
  });

  test("keeps the IdP identity of an existing account with the same username", async () => {
    const now = new Date().toISOString();
    await db.insert(users).values({ id: "x", oauthSub: "idp-sub", username: "root", name: "R", email: "r@corp.test", role: "user", status: "active", createdAt: now, updatedAt: now }).run();
    await seedBootstrapAdmin(db, await config(), logger);
    const row = (await db.select().from(users).where(eq(users.id, "x")).get())!;
    expect(row).toMatchObject({ oauthSub: "idp-sub", role: "admin" });
    expect(row.passwordHash).not.toBeNull();
  });
});
