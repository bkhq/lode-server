import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDb } from "@/db";
import {
  deleteSetting,
  getSetting,
  getSettings,
  isSensitiveKey,
  MASKED_VALUE,
  maskSensitiveValue,
  maskValue,
  setSetting,
} from "./settings.service";

let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "settings-svc-"));
  db = await createDb(resolve(dir, "app.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("isSensitiveKey", () => {
  test("matches the documented suffix list (case-insensitive)", () => {
    expect(isSensitiveKey("smtp.password")).toBe(true);
    expect(isSensitiveKey("OAUTH.CLIENT_SECRET")).toBe(true);
    expect(isSensitiveKey("foo.api_key")).toBe(true);
    expect(isSensitiveKey("bar.token")).toBe(true);
    expect(isSensitiveKey("baz.secret")).toBe(true);
  });

  test("does not match unrelated keys", () => {
    expect(isSensitiveKey("smtp.host")).toBe(false);
    expect(isSensitiveKey("session.max_age")).toBe(false);
    expect(isSensitiveKey("password.host")).toBe(false); // suffix only
  });
});

describe("maskSensitiveValue / maskValue", () => {
  test("returns MASKED_VALUE for sensitive keys", () => {
    const row = { key: "smtp.password", value: "real", updatedBy: null, updatedAt: "" };
    expect(maskSensitiveValue(row).value).toBe(MASKED_VALUE);
    expect(maskValue("smtp.password", "real")).toBe(MASKED_VALUE);
  });

  test("returns the original row for non-sensitive keys", () => {
    const row = { key: "smtp.host", value: "smtp.example.com", updatedBy: null, updatedAt: "" };
    expect(maskSensitiveValue(row)).toBe(row);
    expect(maskValue("smtp.host", "smtp.example.com")).toBe("smtp.example.com");
  });
});

describe("setSetting + getSetting", () => {
  test("inserts a new row and reads it back", async () => {
    await setSetting(db, "k1", "v1");
    expect(await getSetting(db, "k1")).toBe("v1");
  });

  test("captures updatedBy when a real user id is provided", async () => {
    const { users } = await import("@/modules/account/users/schema");
    const now = new Date().toISOString();
    await db.insert(users).values({
      id: "u_1",
      oauthSub: "sub-u-1",
      username: "u1",
      name: "u",
      email: "u1@example.com",
      createdAt: now,
      updatedAt: now,
    }).run();

    await setSetting(db, "withUser", "v", { updatedBy: "u_1" });
    const rows = await getSettings(db, "withUser");
    expect(rows[0]!.updatedBy).toBe("u_1");
  });

  test("upserts on existing key", async () => {
    await setSetting(db, "k1", "v1");
    await setSetting(db, "k1", "v2");
    expect(await getSetting(db, "k1")).toBe("v2");
  });

  test("missing key returns null", async () => {
    expect(await getSetting(db, "nope")).toBeNull();
  });
});

describe("getSettings", () => {
  beforeEach(async () => {
    await setSetting(db, "smtp.host", "h");
    await setSetting(db, "smtp.password", "p");
    await setSetting(db, "session.max_age", "86400");
  });

  test("returns all rows when no prefix given", async () => {
    const rows = await getSettings(db);
    expect(rows.map(r => r.key).sort()).toEqual(["session.max_age", "smtp.host", "smtp.password"]);
  });

  test("filters by prefix", async () => {
    const rows = await getSettings(db, "smtp.");
    expect(rows.map(r => r.key).sort()).toEqual(["smtp.host", "smtp.password"]);
  });
});

describe("deleteSetting", () => {
  test("returns true when the row existed and is now gone", async () => {
    await setSetting(db, "k", "v");
    expect(await deleteSetting(db, "k")).toBe(true);
    expect(await getSetting(db, "k")).toBeNull();
  });

  test("returns false when the row was never there", async () => {
    expect(await deleteSetting(db, "k")).toBe(false);
  });
});
