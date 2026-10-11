import type { ActionContext } from "../types";
import type { AppDatabase } from "@/db";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { cronJobLogs, cronJobs } from "@/db/schema";
import softDeleteCleanupAction from ".";
import { __resetActionRegistryForTests, registerAction, validateActionConfig } from "../registry";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

const fakeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
  reopen: () => {},
} as unknown as ActionContext["logger"];

let db: AppDatabase;
let dbPath: string;

beforeAll(() => {
  __resetActionRegistryForTests();
  registerAction(softDeleteCleanupAction);
});

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-cron-purge-${Date.now()}-${nanoid()}`);
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

function validate(cfg: Record<string, unknown>) {
  return validateActionConfig("soft-delete-cleanup", { ...cfg, action: "soft-delete-cleanup" });
}
const fakeConfig = {} as unknown as Parameters<typeof softDeleteCleanupAction.execute>[0]["config"];
function run(cfg: Record<string, unknown>) {
  return softDeleteCleanupAction.execute({ db, logger: fakeLogger, config: fakeConfig }, cfg);
}

async function seedJob(opts: {
  name: string;
  isDeleted?: boolean;
  updatedAt?: string;
}) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(cronJobs).values({
    id,
    name: opts.name,
    cron: "@yearly",
    taskType: "custom",
    taskConfig: JSON.stringify({ action: "noop" }),
    enabled: opts.isDeleted !== true,
    isDeleted: opts.isDeleted ?? false,
    createdAt: now,
    updatedAt: opts.updatedAt ?? now,
  }).run();
  return id;
}

async function seedLog(jobId: string) {
  const id = `${Date.now().toString(16).padStart(12, "0")}${nanoid().padEnd(14, "x")}`;
  await db.insert(cronJobLogs).values({
    id,
    jobId,
    startedAt: new Date().toISOString(),
    status: "success",
  }).run();
}

describe("soft-delete-cleanup validate (via inputs[])", () => {
  test("accepts an empty config", async () => {
    expect(await validate({})).toBeNull();
  });

  test("accepts olderThanDays in range", async () => {
    expect(await validate({ olderThanDays: 0 })).toBeNull();
    expect(await validate({ olderThanDays: 30 })).toBeNull();
    expect(await validate({ olderThanDays: 365 })).toBeNull();
  });

  test("rejects negative olderThanDays", async () => {
    expect(await validate({ olderThanDays: -1 })).toMatch(/olderThanDays must be >= 0/);
  });

  test("rejects olderThanDays above the ceiling", async () => {
    expect(await validate({ olderThanDays: 999_999 })).toMatch(/olderThanDays must be <= 3650/);
  });

  test("rejects non-numeric olderThanDays", async () => {
    expect(await validate({ olderThanDays: "abc" })).toMatch(/olderThanDays must be a number/);
  });
});

describe("runSoftDeleteCleanup", () => {
  test("no-op when no jobs exist", async () => {
    const result = await run({});
    expect(result).toMatch(/^no soft-deleted jobs/);
  });

  test("preserves live jobs", async () => {
    const id = await seedJob({ name: "live" });
    await seedLog(id);
    const result = await run({});
    expect(result).toMatch(/^no soft-deleted jobs/);
    const row = await db.select().from(cronJobs).where(eq(cronJobs.id, id)).get();
    expect(row).toBeDefined();
  });

  test("hard-deletes soft-deleted jobs and cascades their logs", async () => {
    const live = await seedJob({ name: "live" });
    const dead = await seedJob({ name: "dead", isDeleted: true });
    await seedLog(live);
    await seedLog(dead);
    await seedLog(dead);

    const result = await run({});
    expect(result).toMatch(/purged 1 soft-deleted jobs/);
    expect(result).toMatch(/cascaded 2 log rows/);

    const liveRow = await db.select().from(cronJobs).where(eq(cronJobs.id, live)).get();
    expect(liveRow).toBeDefined();
    const deadRow = await db.select().from(cronJobs).where(eq(cronJobs.id, dead)).get();
    expect(deadRow).toBeUndefined();

    const liveLogs = await db.select().from(cronJobLogs).where(eq(cronJobLogs.jobId, live)).all();
    expect(liveLogs).toHaveLength(1);
    const deadLogs = await db.select().from(cronJobLogs).where(eq(cronJobLogs.jobId, dead)).all();
    expect(deadLogs).toHaveLength(0);
  });

  test("respects olderThanDays — recent tombstones survive the grace window", async () => {
    const today = new Date().toISOString();
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = await seedJob({ name: "fresh-trash", isDeleted: true, updatedAt: today });
    const stale = await seedJob({ name: "stale-trash", isDeleted: true, updatedAt: longAgo });

    const result = await run({ olderThanDays: 7 });
    expect(result).toMatch(/purged 1 soft-deleted jobs/);

    const freshRow = await db.select().from(cronJobs).where(eq(cronJobs.id, fresh)).get();
    expect(freshRow).toBeDefined();
    const staleRow = await db.select().from(cronJobs).where(eq(cronJobs.id, stale)).get();
    expect(staleRow).toBeUndefined();
  });

  test("olderThanDays=0 (default) purges every soft-deleted row", async () => {
    await seedJob({ name: "a", isDeleted: true });
    await seedJob({ name: "b", isDeleted: true });
    await seedJob({ name: "c", isDeleted: true });

    const result = await run({});
    expect(result).toMatch(/purged 3 soft-deleted jobs/);
  });
});
