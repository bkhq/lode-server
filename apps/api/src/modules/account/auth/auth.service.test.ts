import type { AppDatabase } from "@/db";
import type { AuthConfig } from "@/shared/lib/app-config";
import type { Logger } from "@/shared/lib/logger";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { nanoid } from "@/shared/lib/id";
import { upsertSingleUser, upsertUser } from "./auth.service";

let db: AppDatabase;
let dbPath: string;

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
} as unknown as Logger;

function authConfig(defaultAdmins: readonly string[]): AuthConfig {
  return {
    sessionMaxAge: 86400,
    defaultAdmins,
  };
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-auth-service-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

describe("upsertUser DEFAULT_ADMIN bootstrap", () => {
  test("every identity listed in DEFAULT_ADMIN is an admin", async () => {
    // DEFAULT_ADMIN is the operator's declaration of who administers the
    // deployment. Listing two people makes two admins, not a race for one.
    const first = await upsertUser(
      db,
      {
        sub: "sub-admin",
        preferred_username: "admin",
        email: "admin@example.com",
        email_verified: true,
      },
      authConfig(["admin@example.com", "second@example.com"]),
      logger,
    );

    const second = await upsertUser(
      db,
      {
        sub: "sub-second",
        preferred_username: "second",
        email: "second@example.com",
        email_verified: true,
      },
      authConfig(["admin@example.com", "second@example.com"]),
      logger,
    );

    expect(first.role).toBe("admin");
    expect(second.role).toBe("admin");
  });

  test("an admin that already exists does not cancel DEFAULT_ADMIN", async () => {
    // What broke a real deployment: a single-user account (always an admin)
    // existed before the configured admin's first OIDC login, and the old
    // "only while no admin exists" gate silently skipped the promotion.
    const other = await upsertSingleUser(db, { username: "smoke", name: "Smoke", email: "smoke@local" });
    expect(other.role).toBe("admin");

    const configured = await upsertUser(
      db,
      {
        sub: "sub-roy",
        preferred_username: "roy",
        email: "a@roy.me",
        email_verified: true,
      },
      authConfig(["a@roy.me"]),
      logger,
    );

    expect(configured.role).toBe("admin");
  });

  test("an existing user is promoted once DEFAULT_ADMIN lists them", async () => {
    // The configured admin may already have an account — created before the
    // setting was added, or while another admin blocked the old bootstrap.
    // Their next login must honour the setting instead of leaving them stuck.
    const created = await upsertUser(
      db,
      {
        sub: "sub-alice",
        preferred_username: "alice",
        email: "alice@example.com",
        email_verified: true,
      },
      authConfig([]),
      logger,
    );
    expect(created.role).toBe("user");

    const promoted = await upsertUser(
      db,
      {
        sub: "sub-alice",
        preferred_username: "alice",
        email: "alice@example.com",
        email_verified: true,
      },
      authConfig(["alice@example.com"]),
      logger,
    );
    const row = await db.select().from(users).where(eq(users.id, created.id)).get();

    expect(promoted.role).toBe("admin");
    expect(row?.role).toBe("admin");
  });

  test("an unverified email does not match DEFAULT_ADMIN", async () => {
    // At many IdPs an unverified email is whatever the user typed.
    const user = await upsertUser(
      db,
      { sub: "sub-mallory", preferred_username: "mallory", email: "a@roy.me" },
      authConfig(["a@roy.me"]),
      logger,
    );
    expect(user.role).toBe("user");
  });

  test("a username shaped like the admin's email does not match an email entry", async () => {
    // Usernames are often self-chosen. An email entry is claimed only by a
    // verified email, never by a username that happens to spell it.
    const user = await upsertUser(
      db,
      {
        sub: "sub-mallory",
        preferred_username: "a@roy.me",
        email: "mallory@example.com",
        email_verified: true,
      },
      authConfig(["a@roy.me"]),
      logger,
    );
    expect(user.role).toBe("user");
  });

  test("a username entry matches the username", async () => {
    const user = await upsertUser(
      db,
      { sub: "sub-ops", preferred_username: "ops" },
      authConfig(["ops"]),
      logger,
    );
    expect(user.role).toBe("admin");
  });

  test("removing an identity from DEFAULT_ADMIN does not demote it", async () => {
    // The setting grants; it does not revoke. Otherwise an admin granted in
    // the UI would lose the role on their next login.
    const first = await upsertUser(
      db,
      {
        sub: "sub-alice",
        preferred_username: "alice",
        email: "alice@example.com",
        email_verified: true,
      },
      authConfig(["alice@example.com"]),
      logger,
    );
    const later = await upsertUser(
      db,
      {
        sub: "sub-alice",
        preferred_username: "alice",
        email: "alice@example.com",
        email_verified: true,
      },
      authConfig([]),
      logger,
    );

    expect(first.role).toBe("admin");
    expect(later.role).toBe("admin");
  });

  test("promotes DEFAULT_ADMIN even when a non-admin user signed up first", async () => {
    // Bootstrap is gated on "no admin exists", not "no user exists", so a
    // regular employee logging in before the admin must not lock the admin
    // out of auto-promotion.
    const first = await upsertUser(
      db,
      { sub: "sub-bob", preferred_username: "bob", email: "bob@example.com" },
      authConfig(["admin@example.com"]),
      logger,
    );

    const admin = await upsertUser(
      db,
      {
        sub: "sub-admin",
        preferred_username: "admin",
        email: "admin@example.com",
        email_verified: true,
      },
      authConfig(["admin@example.com"]),
      logger,
    );

    expect(first.role).toBe("user");
    expect(admin.role).toBe("admin");
  });

  test("upsertUser rebinds an existing single-user row when OAuth comes back", async () => {
    // 1. OAuth bootstrap admin
    const first = await upsertUser(
      db,
      {
        sub: "google-12345",
        preferred_username: "admin",
        email: "admin@example.com",
        email_verified: true,
        name: "Admin",
      },
      authConfig(["admin@example.com"]),
      logger,
    );
    expect(first.role).toBe("admin");
    expect(first.oauthSub).toBe("google-12345");

    // 2. Operator flips SINGLE_USER_MODE on — single-user takes over the row.
    const single = await upsertSingleUser(db, {
      username: "admin",
      name: "Admin",
      email: "admin@example.com",
    });
    expect(single.id).toBe(first.id);
    expect(single.oauthSub).toBe("single-user");

    // 3. Operator flips SINGLE_USER_MODE off — same email lands via OAuth.
    // The row must rebind to the IdP sub instead of crashing on the email
    // unique index.
    const reclaimed = await upsertUser(
      db,
      {
        sub: "google-12345",
        preferred_username: "admin",
        email: "admin@example.com",
        name: "Admin",
      },
      authConfig(["admin@example.com"]),
      logger,
    );
    expect(reclaimed.id).toBe(first.id);
    expect(reclaimed.oauthSub).toBe("google-12345");
    expect(reclaimed.role).toBe("admin");

    const rows = await db.select().from(users).all();
    expect(rows.length).toBe(1);
  });

  test("upsertUser takes over a row by username/email when the IdP sub changes", async () => {
    // E.g. operator moved from one IdP to another. The original user row
    // had a Google sub; the new login carries an Okta sub.
    const original = await upsertUser(
      db,
      { sub: "google-aaa", preferred_username: "alice", email: "alice@example.com" },
      authConfig([]),
      logger,
    );

    const migrated = await upsertUser(
      db,
      { sub: "okta-bbb", preferred_username: "alice", email: "alice@example.com" },
      authConfig([]),
      logger,
    );

    expect(migrated.id).toBe(original.id);
    expect(migrated.oauthSub).toBe("okta-bbb");

    const rows = await db.select().from(users).all();
    expect(rows.length).toBe(1);
  });

  test("upsertSingleUser takes over an existing user with the same username/email", async () => {
    // Simulate an existing OAuth-bootstrapped user (e.g. operator flipped
    // SINGLE_USER_MODE on an existing deployment without wiping the DB).
    const existing = await upsertUser(
      db,
      {
        sub: "google-12345",
        preferred_username: "admin",
        email: "admin@example.com",
        name: "Existing Admin",
      },
      authConfig([]),
      logger,
    );

    const single = await upsertSingleUser(db, {
      username: "admin",
      name: "Admin",
      email: "admin@example.com",
    });

    expect(single.id).toBe(existing.id);
    expect(single.oauthSub).toBe("single-user");
    expect(single.role).toBe("admin");

    // Subsequent logins resolve to the same row via the sentinel oauth_sub.
    const again = await upsertSingleUser(db, {
      username: "admin",
      name: "Admin",
      email: "admin@example.com",
    });
    expect(again.id).toBe(existing.id);

    const rows = await db.select().from(users).all();
    expect(rows.length).toBe(1);
  });

  test("upsertSingleUser inserts an admin row and keeps the same id on rename", async () => {
    const first = await upsertSingleUser(db, {
      username: "owner",
      name: "Owner",
      email: "owner@local",
    });
    expect(first.role).toBe("admin");
    expect(first.oauthSub).toBe("single-user");

    const renamed = await upsertSingleUser(db, {
      username: "boss",
      name: "Boss",
      email: "boss@local",
    });
    expect(renamed.id).toBe(first.id);
    expect(renamed.username).toBe("boss");
    expect(renamed.email).toBe("boss@local");

    const rows = await db.select().from(users).all();
    expect(rows.length).toBe(1);
    expect(rows[0]?.role).toBe("admin");
  });

  test("re-promotes DEFAULT_ADMIN after the only admin is deleted", async () => {
    // Initial bootstrap.
    const initial = await upsertUser(
      db,
      {
        sub: "sub-initial",
        preferred_username: "initial",
        email: "initial@example.com",
        email_verified: true,
      },
      authConfig(["initial@example.com", "backup@example.com"]),
      logger,
    );
    expect(initial.role).toBe("admin");

    // Operator removes the initial admin (e.g. employee left).
    await db.delete(users).where(eq(users.id, initial.id)).run();

    // A different DEFAULT_ADMIN logs in for the first time.
    const backup = await upsertUser(
      db,
      {
        sub: "sub-backup",
        preferred_username: "backup",
        email: "backup@example.com",
        email_verified: true,
      },
      authConfig(["initial@example.com", "backup@example.com"]),
      logger,
    );
    expect(backup.role).toBe("admin");
  });

  test("unverified email cannot bootstrap admin", async () => {
    // email_verified absent → DEFAULT_ADMIN email match must not grant admin.
    const attacker = await upsertUser(
      db,
      { sub: "attacker-sub", preferred_username: "attacker", email: "admin@example.com" },
      authConfig(["admin@example.com", "admin2@example.com"]),
      logger,
    );
    expect(attacker.role).toBe("user");

    // email_verified false, distinct admin email (avoids unique-index clash).
    const stillUser = await upsertUser(
      db,
      {
        sub: "attacker-sub-2",
        preferred_username: "attacker2",
        email: "admin2@example.com",
        email_verified: false,
      },
      authConfig(["admin@example.com", "admin2@example.com"]),
      logger,
    );
    expect(stillUser.role).toBe("user");
  });

  test("unverified email cannot take over an existing (admin) row", async () => {
    // Legitimate verified admin.
    const victim = await upsertUser(
      db,
      {
        sub: "victim-sub",
        preferred_username: "victim",
        email: "victim@example.com",
        email_verified: true,
      },
      authConfig(["victim@example.com"]),
      logger,
    );
    expect(victim.role).toBe("admin");

    // Different username, victim's email, unverified: email match ignored,
    // victim row not rebound, fresh insert collides on unique email → throws.
    await expect(upsertUser(
      db,
      { sub: "attacker-sub", preferred_username: "mallory", email: "victim@example.com" },
      authConfig(["victim@example.com"]),
      logger,
    )).rejects.toThrow();

    const victimRow = await db.select().from(users).where(eq(users.id, victim.id)).get();
    expect(victimRow?.oauthSub).toBe("victim-sub");
    expect(victimRow?.role).toBe("admin");

    const attackerRow = await db.select().from(users).where(eq(users.oauthSub, "attacker-sub")).get();
    expect(attackerRow).toBeUndefined();
  });
});

describe("upsertUser and accounts that sign in with a password", () => {
  async function localAdmin(): Promise<string> {
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "loc",
      oauthSub: "local:loc",
      username: "admin",
      name: "Admin",
      email: "admin@corp.test",
      role: "admin",
      status: "active",
      passwordHash: "pbkdf2-sha256$1$AAAA$AAAA",
      createdAt: now,
      updatedAt: now,
    }).run();
    return "loc";
  }

  test("an IdP user who merely picks the same username cannot take the account over", async () => {
    // Usernames are self-chosen at many IdPs: registering "admin" there must
    // not hand over the local admin.
    await localAdmin();
    await expect(
      upsertUser(db, {
        sub: "attacker",
        preferred_username: "admin",
        email: "evil@x.io",
        email_verified: true,
      }, authConfig([]), logger),
    ).rejects.toMatchObject({ code: "ACCOUNT_CONFLICT" });
    const row = (await db.select().from(users).where(eq(users.id, "loc")).get())!;
    expect(row.oauthSub).toBe("local:loc");
  });

  test("nor with an unverified email that happens to match", async () => {
    await localAdmin();
    await expect(
      upsertUser(db, {
        sub: "attacker",
        preferred_username: "someone",
        email: "admin@corp.test",
        email_verified: false,
      }, authConfig([]), logger),
    ).rejects.toMatchObject({ code: "ACCOUNT_CONFLICT" });
  });

  test("a verified email the IdP vouches for links the account, which keeps its password", async () => {
    await localAdmin();
    const user = await upsertUser(db, {
      sub: "real",
      preferred_username: "admin",
      email: "admin@corp.test",
      email_verified: true,
    }, authConfig([]), logger);
    expect(user.id).toBe("loc");
    const row = (await db.select().from(users).where(eq(users.id, "loc")).get())!;
    expect(row.oauthSub).toBe("real");
    expect(row.passwordHash).not.toBeNull();
    expect(row.role).toBe("admin");
  });

  test("an account without a password is still rebound by username, as before", async () => {
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "old",
      oauthSub: "single-user",
      username: "owner",
      name: "o",
      email: "o@x.io",
      role: "user",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();
    const user = await upsertUser(db, { sub: "idp", preferred_username: "owner" }, authConfig([]), logger);
    expect(user.id).toBe("old");
  });
});
