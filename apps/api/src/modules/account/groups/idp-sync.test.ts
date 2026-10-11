import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { addGroupMember, createGroup, getGroupByName, getGroupMembers } from "./groups.service";
import { applyIdpGroups, readGroupsClaim, syncIdpGroups } from "./idp-sync";

const warnings: string[] = [];
const logger = {
  debug() {},
  info() {},
  warn: (_ctx: unknown, msg: string) => warnings.push(msg),
  error() {},
  fatal() {},
  flush() {},
} as unknown as Logger;

let dir: string;
let db: AppDatabase;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "idp-sync-"));
  db = await createDb(resolve(dir, "app.db"));
  warnings.length = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedUser(id: string): Promise<string> {
  const now = new Date().toISOString();
  await db.insert(users).values({ id, oauthSub: `sub-${id}`, username: id, name: id, email: `${id}@t.io`, role: "user", status: "active", createdAt: now, updatedAt: now }).run();
  return id;
}

async function memberNames(userId: string): Promise<string[]> {
  const names: string[] = [];
  for (const name of ["eng", "ops", "local-team", "sales"]) {
    const group = await getGroupByName(db, name);
    if (group && (await getGroupMembers(db, group.id)).some(m => m.id === userId))
      names.push(name);
  }
  return names;
}

describe("readGroupsClaim", () => {
  test("reads a string array from userinfo", () => {
    expect(readGroupsClaim("groups", { groups: ["eng", "ops"] }, undefined)).toEqual(["eng", "ops"]);
  });

  test("falls back to the id_token when userinfo lacks the claim", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "s", roles: ["eng"] })).toString("base64url");
    expect(readGroupsClaim("roles", {}, `h.${payload}.sig`)).toEqual(["eng"]);
  });

  test("accepts a single string", () => {
    expect(readGroupsClaim("groups", { groups: "eng" }, undefined)).toEqual(["eng"]);
  });

  test("trims, drops blanks and non-strings, and de-duplicates", () => {
    expect(readGroupsClaim("groups", { groups: [" eng ", "", 7, "eng", null, "ops"] }, undefined)).toEqual(["eng", "ops"]);
  });

  test("returns undefined when the claim is absent, so a missing scope does not wipe memberships", () => {
    expect(readGroupsClaim("groups", {}, undefined)).toBeUndefined();
  });

  test("an empty array is an explicit empty set", () => {
    expect(readGroupsClaim("groups", { groups: [] }, undefined)).toEqual([]);
  });
});

describe("syncIdpGroups", () => {
  test("creates missing groups as IdP-managed and adds the user", async () => {
    const u = await seedUser("u1");
    await syncIdpGroups(db, u, ["eng", "ops"], logger);
    expect(await memberNames(u)).toEqual(["eng", "ops"]);
    expect((await getGroupByName(db, "eng"))?.source).toBe("idp");
  });

  test("removes the user from IdP groups no longer in the claim", async () => {
    const u = await seedUser("u1");
    await syncIdpGroups(db, u, ["eng", "ops"], logger);
    await syncIdpGroups(db, u, ["ops"], logger);
    expect(await memberNames(u)).toEqual(["ops"]);
  });

  test("an empty claim removes every IdP membership", async () => {
    const u = await seedUser("u1");
    await syncIdpGroups(db, u, ["eng"], logger);
    await syncIdpGroups(db, u, [], logger);
    expect(await memberNames(u)).toEqual([]);
  });

  test("leaves local groups and their memberships alone", async () => {
    const u = await seedUser("u1");
    const local = await createGroup(db, { name: "local-team" });
    await addGroupMember(db, local.id, u);
    await syncIdpGroups(db, u, ["eng"], logger);
    expect(await memberNames(u)).toEqual(["eng", "local-team"]);
  });

  test("does not join a local group that shares a claimed name", async () => {
    // Taking over a group an admin manages by hand would let the IdP grant
    // whatever that group grants; skip it and say so.
    const u = await seedUser("u1");
    await createGroup(db, { name: "sales" });
    await syncIdpGroups(db, u, ["sales"], logger);
    expect(await memberNames(u)).toEqual([]);
    expect((await getGroupByName(db, "sales"))?.source).toBe("local");
    expect(warnings.length).toBe(1);
  });

  test("does not touch other users' memberships", async () => {
    const a = await seedUser("a");
    const b = await seedUser("b");
    await syncIdpGroups(db, a, ["eng"], logger);
    await syncIdpGroups(db, b, ["eng"], logger);
    await syncIdpGroups(db, a, [], logger);
    expect(await memberNames(b)).toEqual(["eng"]);
  });
});

describe("applyIdpGroups — the login hook", () => {
  test("does nothing when OAUTH_GROUPS_CLAIM is unset", async () => {
    const u = await seedUser("u1");
    await applyIdpGroups(db, { claim: undefined, userId: u, userInfo: { groups: ["eng"] }, idToken: undefined, logger });
    expect(await memberNames(u)).toEqual([]);
  });

  test("syncs from the configured claim", async () => {
    const u = await seedUser("u1");
    await applyIdpGroups(db, { claim: "groups", userId: u, userInfo: { groups: ["eng"] }, idToken: undefined, logger });
    expect(await memberNames(u)).toEqual(["eng"]);
  });

  test("keeps memberships and warns when the configured claim is missing", async () => {
    const u = await seedUser("u1");
    await syncIdpGroups(db, u, ["eng"], logger);
    await applyIdpGroups(db, { claim: "groups", userId: u, userInfo: {}, idToken: undefined, logger });
    expect(await memberNames(u)).toEqual(["eng"]);
    expect(warnings.length).toBe(1);
  });
});
