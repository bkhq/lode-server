import type { AppDatabase } from "@/db";
import type { AppEnv } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDb } from "@/db";
import { protectedRoutes, publicRoutes } from "@/routes";
import { rateLimits } from "@/shared/schema";
import { __resetCreationQuotaForTests } from "./creation-quota";
import { creationRateLimit, discoverCreationRoutes } from "./creation-rate-limit";

let db: AppDatabase;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(resolve(tmpdir(), "creation-rate-limit-"));
  db = await createDb(resolve(dir, "app.db"));
  // The quota cache is module-global and would otherwise carry counts from
  // the previous case into the next one.
  __resetCreationQuotaForTests();
});

afterEach(() => {
  __resetCreationQuotaForTests();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Limits {
  perMinute: number;
  perHour: number;
  exempt?: string[];
}

/**
 * A stand-in router shaped like the real ones: a collection answers GET and
 * POST, an action answers POST alone.
 */
function buildApp(limits: Limits, userId: string | null = "user-1") {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    c.set("config", {
      CREATE_RATE_LIMIT_PER_MINUTE: limits.perMinute,
      CREATE_RATE_LIMIT_PER_HOUR: limits.perHour,
      CREATE_RATE_LIMIT_EXEMPT: limits.exempt ?? [],
    } as unknown as AppEnv["Variables"]["config"]);
    if (userId !== null)
      c.set("user", { id: userId } as unknown as NonNullable<AppEnv["Variables"]["user"]>);
    await next();
  });
  app.use("*", creationRateLimit({ app }));

  app.get("/issues", c => c.json([]));
  app.post("/issues", c => c.json({ ok: true }, 201));
  app.get("/documents", c => c.json([]));
  app.post("/documents", c => c.json({ ok: true }, 201));
  app.get("/issues/:id/attachments", c => c.json([]));
  app.post("/issues/:id/attachments", c => c.json({ ok: true }, 201));
  // Action, not a collection: no GET on the same path.
  app.post("/issues/:id/close", c => c.json({ ok: true }, 200));
  return app;
}

function post(app: Hono<AppEnv>, path = "/issues") {
  return app.request(path, { method: "POST" });
}

describe("discoverCreationRoutes", () => {
  test("picks collection POSTs and ignores actions", () => {
    const found = discoverCreationRoutes(buildApp({ perMinute: 1, perHour: 0 }));
    expect(found.map(f => f.resource).sort()).toEqual(["attachment", "document", "issue"]);
  });

  test("honours the mount prefix", () => {
    const found = discoverCreationRoutes(buildApp({ perMinute: 1, perHour: 0 }), "/app/api");
    const issues = found.find(f => f.resource === "issue")!;
    expect(issues.regex.test("/app/api/issues")).toBe(true);
    expect(issues.regex.test("/issues")).toBe(false);
  });

  /**
   * Pins what the real router exposes. The limiter derives this set instead
   * of being wired route by route, so a route entering or leaving it is a
   * decision that should be made deliberately, not noticed in production.
   */
  test("the live route table yields exactly the creating resources", () => {
    const app = new Hono<AppEnv>();
    app.route("/", publicRoutes());
    app.route("/", protectedRoutes());

    const resources = [
      ...new Set(discoverCreationRoutes(app).map(f => f.resource)),
    ].sort();
    expect(resources).toEqual([
      "attachment",
      "comment",
      "document",
      "group",
      "issue",
      "job",
      "member",
      "resource-group",
      "share",
      // Minting personal API tokens is throttled like any other create.
      "token",
      "totp",
      "tuple",
      // Adding a password account is throttled like any other create.
      "user",
    ]);
  });
});

describe("creationRateLimit — minute window", () => {
  test("allows up to the cap, then answers 429 with Retry-After", async () => {
    const app = buildApp({ perMinute: 3, perHour: 0 });
    for (let i = 0; i < 3; i++)
      expect((await post(app)).status).toBe(201);

    const limited = await post(app);
    expect(limited.status).toBe(429);
    expect((await limited.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  test("an elapsed window starts a fresh count", async () => {
    const app = buildApp({ perMinute: 1, perHour: 0 });
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(429);

    // Expire both the checkpoint and the live counter.
    await db.update(rateLimits).set({ resetAt: Date.now() - 1 }).where(eq(rateLimits.key, "issue:minute:user-1"));
    __resetCreationQuotaForTests();

    expect((await post(app)).status).toBe(201);
  });
});

describe("creationRateLimit — hour window", () => {
  test("caps the sustained rate the minute window alone would allow", async () => {
    const app = buildApp({ perMinute: 100, perHour: 3 });
    for (let i = 0; i < 3; i++)
      expect((await post(app)).status).toBe(201);

    const limited = await post(app);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(60);
  });

  test("rejected requests still spend the hour budget, so abuse escalates", async () => {
    const app = buildApp({ perMinute: 2, perHour: 6 });
    // 2 accepted, 4 refused by the minute window — but all 6 charged to the
    // hour window, which is now spent.
    for (let i = 0; i < 6; i++)
      await post(app);

    // Clearing the minute window alone must not let the caller continue:
    // the hour window absorbed the refusals.
    await db.update(rateLimits).set({ resetAt: Date.now() - 1 }).where(eq(rateLimits.key, "issue:minute:user-1"));
    const limited = await post(app);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(60);
  });
});

describe("creationRateLimit — scoping", () => {
  test("each resource drains its own budget", async () => {
    const app = buildApp({ perMinute: 1, perHour: 0 });
    expect((await post(app, "/issues")).status).toBe(201);
    expect((await post(app, "/issues")).status).toBe(429);
    // A spent issue budget must not block creating a document.
    expect((await post(app, "/documents")).status).toBe(201);
    expect((await post(app, "/issues/abc/attachments")).status).toBe(201);
  });

  test("each user drains their own budget", async () => {
    expect((await post(buildApp({ perMinute: 1, perHour: 0 }, "alice"))).status).toBe(201);
    expect((await post(buildApp({ perMinute: 1, perHour: 0 }, "alice"))).status).toBe(429);
    expect((await post(buildApp({ perMinute: 1, perHour: 0 }, "bob"))).status).toBe(201);
  });

  test("the refusal survives a restart — the crossing write is in the database", async () => {
    const app = buildApp({ perMinute: 3, perHour: 0 });
    for (let i = 0; i < 4; i++)
      await post(app);

    // Dropping the cache is what a process restart or a Durable Object
    // eviction does; only the database carries the count across it.
    __resetCreationQuotaForTests();
    expect((await post(app)).status).toBe(429);
  });

  test("an action route is not a create and is never counted", async () => {
    const app = buildApp({ perMinute: 1, perHour: 1 });
    for (let i = 0; i < 5; i++)
      expect((await post(app, "/issues/abc/close")).status).toBe(200);
    expect((await db.select().from(rateLimits).all()).length).toBe(0);
  });
});

describe("creationRateLimit — escape hatches", () => {
  test("an exempt resource is skipped while the others stay limited", async () => {
    const app = buildApp({
      perMinute: 1,
      perHour: 0,
      exempt: ["issue"],
    });
    for (let i = 0; i < 5; i++)
      expect((await post(app, "/issues")).status).toBe(201);

    expect((await post(app, "/documents")).status).toBe(201);
    expect((await post(app, "/documents")).status).toBe(429);
  });

  test("both caps at 0 disable the gate and write nothing", async () => {
    const app = buildApp({ perMinute: 0, perHour: 0 });
    for (let i = 0; i < 5; i++)
      expect((await post(app)).status).toBe(201);
    expect((await db.select().from(rateLimits).all()).length).toBe(0);
  });

  test("one window at 0 leaves the other enforced", async () => {
    const app = buildApp({ perMinute: 0, perHour: 2 });
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(429);
  });

  test("an unauthenticated request is passed through to the auth layer", async () => {
    const app = buildApp({ perMinute: 1, perHour: 1 }, null);
    expect((await post(app)).status).toBe(201);
    expect((await db.select().from(rateLimits).all()).length).toBe(0);
  });
});

describe("creationRateLimit — concurrency", () => {
  test("concurrent requests cannot lose an increment", async () => {
    const app = buildApp({ perMinute: 20, perHour: 0 });
    const results = await Promise.all(Array.from({ length: 20 }, () => post(app)));
    expect(results.every(r => r.status === 201)).toBe(true);
    // Exactly 20 were counted, so the 21st is over the cap. A lost
    // increment would leave room here.
    expect((await post(app)).status).toBe(429);
  });
});
