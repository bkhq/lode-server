import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { TOTP } from "otpauth";
import { createDb } from "@/db";
import { users, userTotpDevices } from "@/modules/account/users/schema";
import { createTotpChallenge, createTotpDevice } from "@/modules/account/users/totp.service";
import { authRequired } from "@/shared/middleware/auth";
import { errorHandler } from "@/shared/middleware/error-handler";
import { authRoutes } from "./auth.routes";
import { createSession, SESSION_ABSOLUTE_LIFETIME_MS } from "./auth.service";
import { sessions } from "./schema";
import "@/modules/account";

const noop = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  flush() {},
} as unknown as Logger;

const DAY_S = 86_400;
const HOUR_MS = 3_600_000;
const T0 = new Date("2026-03-02T09:00:00.000Z").getTime();

let dir: string;
let db: AppDatabase;

const config = {
  NODE_ENV: "test",
  BASE_PATH: "",
  TRUST_PROXY: false,
  SESSION_MAX_AGE: DAY_S,
  DEFAULT_ADMIN: "",
} as unknown as Config;

beforeEach(async () => {
  setSystemTime(T0);
  dir = mkdtempSync(resolve(tmpdir(), "session-lifetime-"));
  db = await createDb(resolve(dir, "app.db"));
  await db.insert(users).values({
    id: "u1",
    oauthSub: "sub-u1",
    username: "u1",
    name: "u1",
    email: "u1@t.io",
    role: "user",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();
});

afterEach(() => {
  setSystemTime();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function app(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", config);
    c.set("logger", noop);
    await next();
  });
  a.use("/me", authRequired);
  a.get("/me", c => c.json({ id: c.get("user")!.id }));
  a.route("/", authRoutes());
  a.onError(errorHandler);
  return a;
}

const at = (ms: number) => setSystemTime(T0 + ms);
function me(sid: string) {
  return app().request("/me", {
    headers: { Cookie: `session_id=${sid}` },
  });
}
const row = async (sid: string) => db.select().from(sessions).where(eq(sessions.id, sid)).get();

describe("session lifetime", () => {
  test("a session outlives the IdP's one-hour access token", async () => {
    const sid = await createSession(db, "u1", "idp-access", "idp-refresh", DAY_S);
    at(2 * HOUR_MS);
    expect((await me(sid)).status).toBe(200);
  });

  test("before half its lifetime, use neither writes the session nor sets a cookie", async () => {
    const sid = await createSession(db, "u1", "tok", undefined, DAY_S);
    const before = (await row(sid))!.expiresAt;
    at(11 * HOUR_MS);
    const res = await me(sid);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await row(sid))!.expiresAt).toBe(before);
  });

  test("past half its lifetime, use extends the session and its cookie by a full period", async () => {
    const sid = await createSession(db, "u1", "tok", undefined, DAY_S);
    at(13 * HOUR_MS);
    const res = await me(sid);
    expect(res.status).toBe(200);
    expect((await row(sid))!.expiresAt).toBe(new Date(T0 + 13 * HOUR_MS + DAY_S * 1000).toISOString());
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`session_id=${sid}`);
    expect(cookie).toContain(`Max-Age=${DAY_S}`);
  });

  test("an active session keeps going; an idle one ends after the timeout", async () => {
    const sid = await createSession(db, "u1", "tok", undefined, DAY_S);
    for (let h = 13; h <= 24 * 5; h += 13) {
      at(h * HOUR_MS);
      expect((await me(sid)).status).toBe(200);
    }
    const last = Date.parse((await row(sid))!.expiresAt);
    setSystemTime(last + 1000);
    const res = await me(sid);
    expect(res.status).toBe(401);
    expect(await row(sid)).toBeUndefined();
    expect(res.headers.get("set-cookie") ?? "").toContain("session_id=;");
  });

  test("no session outlives its absolute lifetime, however active", async () => {
    const sid = await createSession(db, "u1", "tok", undefined, DAY_S);
    for (let h = 0; h * HOUR_MS < SESSION_ABSOLUTE_LIFETIME_MS; h += 12) {
      at(h * HOUR_MS);
      expect((await me(sid)).status).toBe(200);
      expect(Date.parse((await row(sid))!.expiresAt)).toBeLessThanOrEqual(T0 + SESSION_ABSOLUTE_LIFETIME_MS);
    }
    at(SESSION_ABSOLUTE_LIFETIME_MS + 1000);
    expect((await me(sid)).status).toBe(401);
  });

  test("an expired session is not revived through its refresh token", async () => {
    const sid = await createSession(db, "u1", "idp-access", "idp-refresh", DAY_S);
    at(DAY_S * 1000 + 1000);
    expect((await me(sid)).status).toBe(401);
    expect(await row(sid)).toBeUndefined();
  });

  test("creating a session sweeps expired ones", async () => {
    const old = await createSession(db, "u1", "tok", undefined, DAY_S);
    at(2 * DAY_S * 1000);
    await createSession(db, "u1", "tok", undefined, DAY_S);
    expect(await row(old)).toBeUndefined();
  });

  test("a login finished by two-step verification gets the configured lifetime, not the IdP token's", async () => {
    const device = await createTotpDevice(db, "u1", "phone", "u1");
    await db.update(userTotpDevices).set({ verified: true }).where(eq(userTotpDevices.id, device.id)).run();
    const challenge = await createTotpChallenge(db, "u1", "idp-access", "idp-refresh", 3600, "/overview");
    const code = new TOTP({ secret: device.secret }).generate();

    const res = await app().request("/account/auth/totp/verify", {
      method: "POST",
      headers: { "Cookie": `totp_pending=${challenge}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const sid = /session_id=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!;
    expect((await row(sid))!.expiresAt).toBe(new Date(T0 + DAY_S * 1000).toISOString());
  });
});
