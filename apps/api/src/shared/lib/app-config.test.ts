import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDb } from "@/db";
import { getSetting, setSetting } from "@/modules/settings/settings.service";
import { nanoid } from "@/shared/lib/id";
import { deriveOrigin, getAppSetting, getAuthConfig, getOAuthConfig, getOidcLogoutUrl, seedSettingsFromEnv } from "./app-config";

let db: AppDatabase;
let dbPath: string;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    HOST: "127.0.0.1",
    DB_PATH: dbPath,
    DB_ENCRYPTION: false,
    APP_NAME: "app",
    APP_DISPLAY_NAME: "App",
    BASE_PATH: "/access",
    LOG_LEVEL: "error",
    LOG_FILE: resolve(dbPath, "../test.log"),
    LOG_TO_STDOUT: false,
    TRUST_PROXY: false,
    ENABLE_EXPERIMENTAL_DEK_ROTATION: false,
    OAUTH_CLIENT_ID: "env-client",
    OAUTH_CLIENT_SECRET: "env-secret",
    OAUTH_AUTHORIZE_URL: "https://idp.example.com/authorize",
    OAUTH_TOKEN_URL: "https://idp.example.com/token",
    OAUTH_USERINFO_URL: "https://idp.example.com/userinfo",
    OAUTH_PKCE: true,
    OAUTH_SCOPES: "openid profile email",
    HOME_PAGE: "off",
    LOCAL_LOGIN: false,
    SESSION_MAX_AGE: 1234,
    AUDIT_RETENTION_DAYS: 0,
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
    MAX_ATTACHMENTS_PER_RESOURCE: 20,
    UPLOADS_TOTAL_BYTES: 0,
    DEFAULT_ADMIN: "admin@example.com",
    OIDC_LOGOUT_URL: "https://idp.example.com/logout",
    ...overrides,
  } as Config;
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-app-config-${Date.now()}-${nanoid()}`);
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

describe("getOAuthConfig", () => {
  test("uses environment config without reading editable settings", async () => {
    await setSetting(db, "oauth.client_id", "db-client");
    const oauth = getOAuthConfig(makeConfig());

    expect(oauth.clientId).toBe("env-client");
    expect(oauth.clientSecret).toBe("env-secret");
    expect(oauth.authorizeUrl).toBe("https://idp.example.com/authorize");
    expect(oauth.tokenUrl).toBe("https://idp.example.com/token");
    expect(oauth.userinfoUrl).toBe("https://idp.example.com/userinfo");
    expect(oauth.pkce).toBe(true);
  });

  test("returns OIDC logout URL from environment config", () => {
    expect(getOidcLogoutUrl(makeConfig())).toBe("https://idp.example.com/logout");
  });
});

describe("seedSettingsFromEnv", () => {
  test("does not seed OAuth, OIDC, or default-admin settings", async () => {
    await seedSettingsFromEnv(db, makeConfig());

    expect(await getSetting(db, "session.max_age")).toBe("1234");
    expect(await getSetting(db, "oauth.client_id")).toBeNull();
    expect(await getSetting(db, "oauth.client_secret")).toBeNull();
    expect(await getSetting(db, "oauth.authorize_url")).toBeNull();
    expect(await getSetting(db, "oauth.token_url")).toBeNull();
    expect(await getSetting(db, "oauth.userinfo_url")).toBeNull();
    expect(await getSetting(db, "oauth.pkce")).toBeNull();
    expect(await getSetting(db, "oidc.logout_url")).toBeNull();
    expect(await getSetting(db, "auth.default_admin")).toBeNull();
  });
});

describe("deriveOrigin", () => {
  function req(url: string, headers: Record<string, string> = {}): Request {
    return new Request(url, { headers });
  }

  test("uses APP_URL when set, stripping trailing slash", () => {
    const config = makeConfig({ APP_URL: "https://example.com/" });
    expect(deriveOrigin(req("https://internal.local/access/api"), config)).toBe("https://example.com");
  });

  test("falls back to forwarded headers in non-production", () => {
    const config = makeConfig({ NODE_ENV: "development" });
    const r = req("http://localhost:3000/access/api", {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "edge.example.com",
    });
    expect(deriveOrigin(r, config)).toBe("https://edge.example.com");
  });

  test("falls back to request URL when no headers and no APP_URL (non-prod)", () => {
    const config = makeConfig({ NODE_ENV: "development" });
    expect(deriveOrigin(req("https://localhost:3000/access/api"), config)).toBe("https://localhost:3000");
  });

  test("throws in production when APP_URL is unset", () => {
    const config = makeConfig({ NODE_ENV: "production" });
    expect(() => deriveOrigin(req("http://attacker.example/"), config)).toThrow(
      /APP_URL must be set in production/,
    );
  });
});

describe("getAppSetting", () => {
  test("DB hit wins over envFallback / defaultValue", async () => {
    await setSetting(db, "k", "from-db");
    expect(await getAppSetting(db, "k", "from-env", "default")).toBe("from-db");
  });

  test("falls back to envFallback when DB has no row", async () => {
    expect(await getAppSetting(db, "missing", "from-env", "default")).toBe("from-env");
  });

  test("falls back to defaultValue when DB and env are both unset", async () => {
    expect(await getAppSetting(db, "missing", undefined, "default")).toBe("default");
  });

  test("returns undefined when nothing is set anywhere", async () => {
    expect(await getAppSetting(db, "missing")).toBeUndefined();
  });
});

describe("getAuthConfig", () => {
  test("reads sessionMaxAge from DB and parses defaultAdmins from env", async () => {
    await setSetting(db, "session.max_age", "3600");
    const cfg = await getAuthConfig(db, makeConfig({ DEFAULT_ADMIN: "admin@example.com,second@example.com" }));
    expect(cfg.sessionMaxAge).toBe(3600);
    expect(cfg.defaultAdmins).toEqual(["admin@example.com", "second@example.com"]);
  });

  test("falls back to env SESSION_MAX_AGE when DB has nothing", async () => {
    const cfg = await getAuthConfig(db, makeConfig({ SESSION_MAX_AGE: 7200, DEFAULT_ADMIN: "" }));
    expect(cfg.sessionMaxAge).toBe(7200);
    expect(cfg.defaultAdmins).toEqual([]);
  });
});
