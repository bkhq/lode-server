import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { cronJobLogs, cronJobs } from "@/db/schema";
import { __resetAndReinitActionsForTests } from "./actions";
import { __resetCronForTests, startCron } from "./cron.service";
import { executeTask } from "./executor";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;

const fakeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: () => {},
  reopen: () => {},
} as unknown as Parameters<typeof startCron>[0]["logger"];

const fakeConfig = {
  HTTP_ACTION_ALLOW_PRIVATE: true,
} as unknown as Parameters<typeof startCron>[0]["config"];

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-cron-recovery-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
  __resetAndReinitActionsForTests();
});

afterEach(async () => {
  await __resetCronForTests();
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

async function seedJob(overrides: Partial<typeof cronJobs.$inferInsert> = {}) {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(cronJobs).values({
    id,
    name: `job-${id}`,
    cron: "* * * * *",
    taskType: "custom",
    taskConfig: JSON.stringify({ action: "noop" }),
    enabled: true,
    maxConsecutiveFailures: 3,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
  return id;
}

async function insertLog(
  jobId: string,
  status: "running" | "success" | "failed",
  startedAt: string,
  opts: { finishedAt?: string | null } = {},
) {
  const id = nanoid();
  await db.insert(cronJobLogs).values({
    id,
    jobId,
    startedAt,
    status,
    finishedAt: opts.finishedAt === undefined
      ? (status === "running" ? null : startedAt)
      : opts.finishedAt,
  }).run();
  return id;
}

describe("crash recovery: reapStaleRunningLogs on startCron", () => {
  test("a stale running log is reaped to failed on startCron", async () => {
    const jobId = await seedJob({ enabled: false }); // disabled so nothing schedules/fires
    const staleId = await insertLog(jobId, "running", new Date(Date.now() - 60_000).toISOString());

    await startCron({ db, logger: fakeLogger, config: fakeConfig });

    const row = await db
      .select()
      .from(cronJobLogs)
      .where(eq(cronJobLogs.id, staleId))
      .get();

    expect(row?.status).toBe("failed");
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.error).toMatch(/crash-detected/i);
  });

  test("does not disturb already-finished logs", async () => {
    const jobId = await seedJob({ enabled: false });
    const okId = await insertLog(jobId, "success", new Date(Date.now() - 120_000).toISOString());
    const failId = await insertLog(jobId, "failed", new Date(Date.now() - 90_000).toISOString());

    await startCron({ db, logger: fakeLogger, config: fakeConfig });

    const ok = await db.select().from(cronJobLogs).where(eq(cronJobLogs.id, okId)).get();
    const failed = await db.select().from(cronJobLogs).where(eq(cronJobLogs.id, failId)).get();
    expect(ok?.status).toBe("success");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBeNull();
  });
});

describe("auto-pause streak ordering", () => {
  test("counts consecutive failures by run time, not ULID order", async () => {
    const jobId = await seedJob({ maxConsecutiveFailures: 3 });

    // Insert older-but-newer-ULID rows out of started_at order. If the streak
    // were ordered by id (ULID) the latest-by-time failures would be missed.
    const base = Date.now();
    // Newest-by-time three rows are all 'failed'.
    await insertLog(jobId, "failed", new Date(base - 30_000).toISOString());
    await insertLog(jobId, "failed", new Date(base - 20_000).toISOString());
    // An older success that must NOT count toward the latest streak.
    await insertLog(jobId, "success", new Date(base - 90_000).toISOString());

    // The 3rd (newest) failure runs through executeTask, tripping auto-pause.
    let executed = false;
    const { defineAction, registerAction } = await import("./actions");
    registerAction(defineAction({
      spec: { name: "always-fail", displayName: "f", description: "f", category: "custom" },
      execute: async () => {
        executed = true;
        throw new Error("boom");
      },
    }));

    await executeTask(
      { db, logger: fakeLogger, config: fakeConfig },
      jobId,
      "job",
      { action: "always-fail" },
      3,
    );

    expect(executed).toBe(true);
    const job = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get();
    expect(job?.enabled).toBe(false); // auto-paused: 3 consecutive failures by run time
  });

  test("ignores running rows when evaluating the streak", async () => {
    const jobId = await seedJob({ maxConsecutiveFailures: 3 });
    const base = Date.now();

    // Two prior failures, then a ghost 'running' row newer than them.
    await insertLog(jobId, "failed", new Date(base - 60_000).toISOString());
    await insertLog(jobId, "failed", new Date(base - 50_000).toISOString());
    await insertLog(jobId, "running", new Date(base - 40_000).toISOString());

    const { defineAction, registerAction } = await import("./actions");
    registerAction(defineAction({
      spec: { name: "fail-again", displayName: "f", description: "f", category: "custom" },
      execute: async () => {
        throw new Error("boom");
      },
    }));

    // This produces the 3rd failure by run time. The interleaved 'running'
    // ghost row must be excluded, otherwise the streak would not be all-failed.
    await executeTask(
      { db, logger: fakeLogger, config: fakeConfig },
      jobId,
      "job",
      { action: "fail-again" },
      3,
    );

    const job = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get();
    expect(job?.enabled).toBe(false);
  });

  test("a running ghost row does not by itself break a non-failing streak", async () => {
    const jobId = await seedJob({ maxConsecutiveFailures: 3 });
    const base = Date.now();

    // Only one real failure; a 'running' row should not be counted as failed
    // nor should it pad the streak to the threshold.
    await insertLog(jobId, "success", new Date(base - 70_000).toISOString());
    await insertLog(jobId, "running", new Date(base - 60_000).toISOString());

    const { defineAction, registerAction } = await import("./actions");
    registerAction(defineAction({
      spec: { name: "fail-once", displayName: "f", description: "f", category: "custom" },
      execute: async () => {
        throw new Error("boom");
      },
    }));

    await executeTask(
      { db, logger: fakeLogger, config: fakeConfig },
      jobId,
      "job",
      { action: "fail-once" },
      3,
    );

    const job = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get();
    // success + (excluded running) + failed → not 3 consecutive failures.
    expect(job?.enabled).toBe(true);
  });
});
