import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createDb } from "@/db";
import { createSession } from "@/modules/account/auth/auth.service";
import { loginLocalUser } from "@/modules/account/auth/local-login";
import { sessions } from "@/modules/account/auth/schema";
import { users } from "@/modules/account/users/schema";
import { createLocalUser, setUserPassword } from "./local-users.service";

let dir: string;
let db: AppDatabase;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "local-users-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const alice = {
  username: "Alice",
  name: "Alice",
  email: "Alice@Example.com",
  role: "user" as const,
  password: "correct horse battery",
};

describe("createLocalUser", () => {
  test("creates an active account, lower-casing username and email, without exposing the hash", async () => {
    const user = await createLocalUser(db, alice);
    expect(user).toMatchObject({
      username: "alice",
      email: "alice@example.com",
      role: "user",
      status: "active",
    });
    expect(JSON.stringify(user)).not.toContain("passwordHash");
    const row = (await db.select().from(users).where(eq(users.id, user.id)).get())!;
    expect(row.passwordHash).toMatch(/^pbkdf2-sha256\$/);
    expect(row.passwordHash).not.toContain(alice.password);
    expect(row.oauthSub).toBe(`local:${user.id}`);
  });

  test("refuses a username or email already taken, whatever the case", async () => {
    await createLocalUser(db, alice);
    await expect(createLocalUser(db, { ...alice, email: "other@example.com", username: "ALICE" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(createLocalUser(db, { ...alice, username: "other", email: "ALICE@example.com" })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("loginLocalUser", () => {
  test("accepts the password, whatever the case of the username", async () => {
    const created = await createLocalUser(db, alice);
    const result = await loginLocalUser(db, "ALICE", alice.password);
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.user.id).toBe(created.id);
  });

  test("rejects a wrong password, an unknown user, and an account with no password alike", async () => {
    await createLocalUser(db, alice);
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "idp",
      oauthSub: "sub",
      username: "idp",
      name: "idp",
      email: "idp@x.io",
      role: "user",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    for (const [name, pw] of [
      ["alice", "wrong"],
      ["nobody", alice.password],
      ["idp", alice.password],
    ] as const)
      expect(await loginLocalUser(db, name, pw)).toEqual({ status: "invalid" });
  });

  test("rejects a disabled account even with the right password", async () => {
    const u = await createLocalUser(db, alice);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, u.id)).run();
    expect(await loginLocalUser(db, "alice", alice.password)).toEqual({ status: "invalid" });
  });

  test("locks the username after repeated failures, even for the right password", async () => {
    await createLocalUser(db, alice);
    let last: Awaited<ReturnType<typeof loginLocalUser>> = { status: "invalid" };
    for (let i = 0; i < 10; i++)
      last = await loginLocalUser(db, "alice", "wrong");
    expect(last.status).toBe("locked");
    expect((await loginLocalUser(db, "alice", alice.password)).status).toBe("locked");
  });

  test("a success clears the failure count", async () => {
    await createLocalUser(db, alice);
    for (let i = 0; i < 9; i++)
      await loginLocalUser(db, "alice", "wrong");
    expect((await loginLocalUser(db, "alice", alice.password)).status).toBe("ok");
    for (let i = 0; i < 9; i++)
      expect((await loginLocalUser(db, "alice", "wrong")).status).toBe("invalid");
  });
});

describe("setUserPassword", () => {
  test("replaces the password and ends the user's sessions", async () => {
    const u = await createLocalUser(db, alice);
    await createSession(db, u.id, "tok", undefined, 3600);
    expect(await setUserPassword(db, u.id, "a brand new passphrase")).toBe(true);
    expect(await db.select().from(sessions).where(eq(sessions.userId, u.id)).all()).toEqual([]);
    expect((await loginLocalUser(db, "alice", alice.password)).status).toBe("invalid");
    expect((await loginLocalUser(db, "alice", "a brand new passphrase")).status).toBe("ok");
  });

  test("gives an IdP-only account a password", async () => {
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "idp",
      oauthSub: "sub",
      username: "idp",
      name: "idp",
      email: "idp@x.io",
      role: "user",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    expect(await setUserPassword(db, "idp", "an adequate passphrase")).toBe(true);
    expect((await loginLocalUser(db, "idp", "an adequate passphrase")).status).toBe("ok");
  });

  test("reports an unknown user", async () => {
    expect(await setUserPassword(db, "ghost", "an adequate passphrase")).toBe(false);
  });
});
