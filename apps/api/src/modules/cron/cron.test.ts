import type { ActionExecutor } from "./actions";
import type { AppDatabase } from "@/db";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { cronJobLogs, cronJobs } from "@/db/schema";
import {
  __resetAndReinitActionsForTests,
  defineAction,
  getAction,
  getActionExecutor,
  getActionNames,
  getDefaultActions,
  registerAction,
  validateActionConfig,
} from "./actions";
import logCleanupAction from "./actions/log-cleanup";
import { isValidCron, normalizeCron, SUPPORTED_CRON_FORMATS } from "./cron-format";
import { __resetCronForTests, getScheduler, startCron, stopCron } from "./cron.service";
import { DEFAULT_MAX_CONSECUTIVE_FAILURES, executeTask } from "./executor";
import { serializeJob } from "./serialize";

const runLogCleanup = logCleanupAction.execute;

// Compact fixture used by the executor tests below — saves writing the
// full `defineAction({ spec, execute })` shape for every one-line
// throw / return.
function fixtureAction(name: string, execute: ActionExecutor) {
  return defineAction({
    spec: {
      name,
      displayName: name,
      description: "fixture",
      category: "custom",
    },
    execute,
  });
}

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
  const dir = resolve(tmpdir(), `test-cron-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
  // Each test runs against a fresh DB *and* a fresh action registry — the
  // registry is a module-level singleton so isolation requires explicit reset.
  __resetAndReinitActionsForTests();
});

afterEach(async () => {
  await __resetCronForTests();
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

// ─── cron-format ───

describe("isValidCron", () => {
  test("accepts 5-field standard expressions", () => {
    expect(isValidCron("* * * * *")).toBe(true);
    expect(isValidCron("0 3 * * *")).toBe(true);
  });

  test("accepts 6-field with seconds", () => {
    expect(isValidCron("0 0 3 * * *")).toBe(true);
    expect(isValidCron("*/5 * * * * *")).toBe(true);
  });

  test("accepts named aliases", () => {
    expect(isValidCron("@hourly")).toBe(true);
    expect(isValidCron("@daily")).toBe(true);
    expect(isValidCron("@weekly")).toBe(true);
    expect(isValidCron("@monthly")).toBe(true);
    expect(isValidCron("@yearly")).toBe(true);
    expect(isValidCron("@annually")).toBe(true);
    expect(isValidCron("@every_second")).toBe(true);
    expect(isValidCron("@every_minute")).toBe(true);
  });

  test("accepts @every_<N><unit> shorthand", () => {
    expect(isValidCron("@every_30s")).toBe(true);
    expect(isValidCron("@every_5m")).toBe(true);
    expect(isValidCron("@every_2h")).toBe(true);
    expect(isValidCron("@every_1d")).toBe(true);
  });

  test("accepts @every_<N>_<unit> long form", () => {
    expect(isValidCron("@every_30_seconds")).toBe(true);
    expect(isValidCron("@every_15_minutes")).toBe(true);
  });

  test("rejects empty / malformed expressions", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("not a cron")).toBe(false);
    expect(isValidCron("@unknown")).toBe(false);
    expect(isValidCron("@every_5x")).toBe(false);
    expect(isValidCron("* * *")).toBe(false);
  });

  test("SUPPORTED_CRON_FORMATS lists multiple formats", () => {
    expect(SUPPORTED_CRON_FORMATS.length).toBeGreaterThan(0);
  });
});

describe("normalizeCron", () => {
  test("expands 5-field to 6-field by prepending second 0", () => {
    expect(normalizeCron("* * * * *")).toBe("0 * * * * *");
    expect(normalizeCron("0 3 * * *")).toBe("0 0 3 * * *");
  });

  test("preserves 6-field unchanged", () => {
    expect(normalizeCron("0 0 3 * * *")).toBe("0 0 3 * * *");
  });

  test("normalizes @every shorthand to long form", () => {
    expect(normalizeCron("@every_30s")).toBe("@every_30_seconds");
    expect(normalizeCron("@every_5m")).toBe("@every_5_minutes");
    expect(normalizeCron("@every_2h")).toBe("@every_2_hours");
    expect(normalizeCron("@every_1d")).toBe("@every_1_dayOfMonth");
  });

  test("preserves named aliases unchanged", () => {
    expect(normalizeCron("@hourly")).toBe("@hourly");
    expect(normalizeCron("@daily")).toBe("@daily");
  });

  test("trims whitespace", () => {
    expect(normalizeCron("  * * * * *  ")).toBe("0 * * * * *");
  });
});

// ─── registry ───

describe("action registry", () => {
  test("default registry includes shipped log-cleanup", () => {
    expect(getActionNames()).toContain("log-cleanup");
    const def = getAction("log-cleanup");
    expect(def?.spec.category).toBe("maintenance");
    expect(def?.spec.defaultCron).toBeDefined();
  });

  test("registerAction throws on duplicate", () => {
    expect(() =>
      registerAction(defineAction({
        spec: {
          name: "log-cleanup",
          displayName: "dup",
          description: "dup",
          category: "custom",
        },
        execute: async () => "x",
      })),
    ).toThrow(/already registered/);
  });

  test("validateActionConfig rejects unknown action", async () => {
    const err = await validateActionConfig("unknown", { action: "unknown" });
    expect(err).toMatch(/Unknown action/);
  });

  test("validateActionConfig enforces required inputs", async () => {
    registerAction(defineAction({
      spec: {
        name: "needs-field",
        displayName: "needs-field",
        description: "test",
        category: "custom",
        inputs: [{ key: "target", label: "Target", type: "string", required: true }],
      },
      execute: async () => "ok",
    }));
    expect(await validateActionConfig("needs-field", { action: "needs-field" })).toMatch(/target.*required/);
    expect(await validateActionConfig("needs-field", { action: "needs-field", target: "x" })).toBeNull();
  });

  test("validateActionConfig type-checks inputs (number range)", async () => {
    registerAction(defineAction({
      spec: {
        name: "needs-number",
        displayName: "needs-number",
        description: "test",
        category: "custom",
        inputs: [{ key: "n", label: "N", type: "number", min: 1, max: 10 }],
      },
      execute: async () => "ok",
    }));
    expect(await validateActionConfig("needs-number", { action: "needs-number", n: 0 })).toMatch(/must be >= 1/);
    expect(await validateActionConfig("needs-number", { action: "needs-number", n: 100 })).toMatch(/must be <= 10/);
    expect(await validateActionConfig("needs-number", { action: "needs-number", n: 5 })).toBeNull();
  });

  test("validateActionConfig type-checks inputs (select enum)", async () => {
    registerAction(defineAction({
      spec: {
        name: "needs-select",
        displayName: "needs-select",
        description: "test",
        category: "custom",
        inputs: [{
          key: "color",
          label: "Color",
          type: "select",
          options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }],
        }],
      },
      execute: async () => "ok",
    }));
    expect(await validateActionConfig("needs-select", { action: "needs-select", color: "green" })).toMatch(/must be one of/);
    expect(await validateActionConfig("needs-select", { action: "needs-select", color: "red" })).toBeNull();
  });

  test("validateActionConfig honors custom validate hook", async () => {
    registerAction(defineAction({
      spec: {
        name: "custom-validate",
        displayName: "custom-validate",
        description: "test",
        category: "custom",
        validate: async cfg => cfg.bad ? "bad value" : null,
      },
      execute: async () => "ok",
    }));
    expect(await validateActionConfig("custom-validate", { action: "custom-validate" })).toBeNull();
    expect(await validateActionConfig("custom-validate", { action: "custom-validate", bad: 1 })).toBe("bad value");
  });

  test("getDefaultActions returns actions with defaultCron", () => {
    const defaults = getDefaultActions();
    const names = defaults.map(d => d.name);
    expect(names).toContain("log-cleanup");
  });

  test("getActionExecutor returns the executor when registered", () => {
    expect(getActionExecutor("log-cleanup")).toBeDefined();
    expect(getActionExecutor("does-not-exist")).toBeUndefined();
  });
});

// ─── executor ───

async function seedJob(opts: { name: string; action: string; enabled?: boolean }) {
  const id = nanoid();
  await db.insert(cronJobs).values({
    id,
    name: opts.name,
    cron: "@yearly",
    taskType: "custom",
    taskConfig: JSON.stringify({ action: opts.action }),
    enabled: opts.enabled ?? true,
  }).run();
  return id;
}

describe("executeTask", () => {
  test("records success and writes finished log", async () => {
    registerAction(fixtureAction("ok", async () => "done"));
    const jobId = await seedJob({ name: "j-ok", action: "ok" });

    const logId = await executeTask({ db, logger: fakeLogger, config: fakeConfig }, jobId, "j-ok", { action: "ok" });
    const matched = await db.select().from(cronJobLogs).where(eq(cronJobLogs.id, logId)).get();
    expect(matched?.status).toBe("success");
    expect(matched?.result).toBe("done");
    expect(matched?.finishedAt).not.toBeNull();
  });

  test("records failure and finished log when handler throws", async () => {
    registerAction(fixtureAction("boom", async () => {
      throw new Error("nope");
    }));
    const jobId = await seedJob({ name: "j-boom", action: "boom" });

    const logId = await executeTask({ db, logger: fakeLogger, config: fakeConfig }, jobId, "j-boom", { action: "boom" });
    const matched = await db.select().from(cronJobLogs).where(eq(cronJobLogs.id, logId)).get();
    expect(matched?.status).toBe("failed");
    expect(matched?.error).toBe("nope");
  });

  test("records failure when action is unknown", async () => {
    const jobId = await seedJob({ name: "j-unknown", action: "missing" });
    const logId = await executeTask({ db, logger: fakeLogger, config: fakeConfig }, jobId, "j-unknown", { action: "missing" });
    const matched = await db.select().from(cronJobLogs).where(eq(cronJobLogs.id, logId)).get();
    expect(matched?.status).toBe("failed");
    expect(matched?.error).toMatch(/Unknown action/);
  });

  test("auto-pauses job after consecutive failures", async () => {
    registerAction(fixtureAction("always-fail", async () => {
      throw new Error("x");
    }));
    const jobId = await seedJob({ name: "j-fail", action: "always-fail" });
    const onPause = mock(() => {});

    for (let i = 0; i < DEFAULT_MAX_CONSECUTIVE_FAILURES; i++) {
      await executeTask(
        { db, logger: fakeLogger, config: fakeConfig, onAutoPause: onPause },
        jobId,
        "j-fail",
        { action: "always-fail" },
      );
    }

    const reread = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get();
    expect(reread?.enabled).toBe(false);
    expect(onPause).toHaveBeenCalledWith("j-fail");
  });

  test("does not auto-pause when interleaved with success", async () => {
    registerAction(fixtureAction("flap-fail", async () => {
      throw new Error("x");
    }));
    registerAction(fixtureAction("flap-ok", async () => "ok"));
    const jobId = await seedJob({ name: "j-flap", action: "flap-fail" });

    await executeTask({ db, logger: fakeLogger, config: fakeConfig }, jobId, "j-flap", { action: "flap-fail" });
    await executeTask({ db, logger: fakeLogger, config: fakeConfig }, jobId, "j-flap", { action: "flap-ok" });
    await executeTask({ db, logger: fakeLogger, config: fakeConfig }, jobId, "j-flap", { action: "flap-fail" });
    await executeTask({ db, logger: fakeLogger, config: fakeConfig }, jobId, "j-flap", { action: "flap-fail" });

    const reread = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get();
    expect(reread?.enabled).toBe(true);
  });

  test("honours a custom maxConsecutiveFailures threshold (5)", async () => {
    registerAction(fixtureAction("custom-fail", async () => {
      throw new Error("x");
    }));
    const jobId = await seedJob({ name: "j-custom", action: "custom-fail" });
    const onPause = mock(() => {});

    // 4 failures < threshold → still enabled.
    for (let i = 0; i < 4; i++) {
      await executeTask(
        { db, logger: fakeLogger, config: fakeConfig, onAutoPause: onPause },
        jobId,
        "j-custom",
        { action: "custom-fail" },
        5,
      );
    }
    expect(onPause).not.toHaveBeenCalled();

    // 5th failure trips it.
    await executeTask(
      { db, logger: fakeLogger, config: fakeConfig, onAutoPause: onPause },
      jobId,
      "j-custom",
      { action: "custom-fail" },
      5,
    );
    expect(onPause).toHaveBeenCalledWith("j-custom");
    const reread = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get();
    expect(reread?.enabled).toBe(false);
  });

  test("maxConsecutiveFailures=0 disables auto-pause", async () => {
    registerAction(fixtureAction("forever-fail", async () => {
      throw new Error("x");
    }));
    const jobId = await seedJob({ name: "j-forever", action: "forever-fail" });
    const onPause = mock(() => {});

    // Run far more than the default threshold — nothing should pause it.
    for (let i = 0; i < 10; i++) {
      await executeTask(
        { db, logger: fakeLogger, config: fakeConfig, onAutoPause: onPause },
        jobId,
        "j-forever",
        { action: "forever-fail" },
        0,
      );
    }

    expect(onPause).not.toHaveBeenCalled();
    const reread = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).get();
    expect(reread?.enabled).toBe(true);
  });
});

// ─── log-cleanup action ───

describe("runLogCleanup", () => {
  async function insertLog(jobId: string, status: "success" | "failed" = "success") {
    // ULID-shaped id so monotonic ordering is preserved.
    const id = `${Date.now().toString(16).padStart(12, "0")}${nanoid().padEnd(14, "x")}`;
    await db.insert(cronJobLogs).values({
      id,
      jobId,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      status,
    }).run();
  }

  test("keeps under-threshold logs", async () => {
    const jobId = await seedJob({ name: "small", action: "log-cleanup" });
    for (let i = 0; i < 5; i++) await insertLog(jobId);
    const result = await runLogCleanup({ db, logger: fakeLogger, config: fakeConfig }, {});
    expect(result).toMatch(/^deleted 0 /);
  });

  test("trims active job logs above threshold", async () => {
    const jobId = await seedJob({ name: "noisy", action: "log-cleanup" });
    // 1001 logs → keep 1000, delete 1.
    for (let i = 0; i < 1001; i++) await insertLog(jobId);
    const result = await runLogCleanup({ db, logger: fakeLogger, config: fakeConfig }, {});
    expect(result).toMatch(/^deleted 1 /);
    const remaining = await db.select().from(cronJobLogs).where(eq(cronJobLogs.jobId, jobId)).all();
    expect(remaining.length).toBe(1000);
  });

  test("purges all logs for soft-deleted job", async () => {
    const jobId = await seedJob({ name: "doomed", action: "log-cleanup" });
    await insertLog(jobId);
    await insertLog(jobId);
    await db.update(cronJobs).set({ isDeleted: true }).where(eq(cronJobs.id, jobId)).run();

    const result = await runLogCleanup({ db, logger: fakeLogger, config: fakeConfig }, {});
    expect(result).toMatch(/^deleted 2 /);
    const remaining = await db.select().from(cronJobLogs).where(eq(cronJobLogs.jobId, jobId)).all();
    expect(remaining).toHaveLength(0);
  });
});

// ─── service / scheduler ───

describe("startCron", () => {
  test("seeds default jobs and stops cleanly", async () => {
    await startCron({ db, logger: fakeLogger, config: fakeConfig });
    const rows = await db.select().from(cronJobs).all();
    expect(rows.find(r => r.name === "log-cleanup")).toBeDefined();
    await stopCron();
  });

  test("startCron is idempotent — second call no-ops", async () => {
    await startCron({ db, logger: fakeLogger, config: fakeConfig });
    // Second invocation must not throw or duplicate the default rows.
    await startCron({ db, logger: fakeLogger, config: fakeConfig });
    const rows = await db.select().from(cronJobs).where(eq(cronJobs.name, "log-cleanup")).all();
    expect(rows).toHaveLength(1);
  });

  test("getScheduler returns null before startCron has run", async () => {
    expect(getScheduler()).toBeNull();
  });

  test("syncJob registers an enabled job and ignores disabled ones", async () => {
    await startCron({ db, logger: fakeLogger, config: fakeConfig });
    const scheduler = getScheduler()!;
    expect(scheduler).not.toBeNull();
    const id = nanoid();
    await db.insert(cronJobs).values({
      id,
      name: "synced",
      cron: "@yearly",
      taskType: "custom",
      taskConfig: JSON.stringify({ action: "log-cleanup" }),
      enabled: true,
    }).run();

    await scheduler.syncJob("synced");
    expect(scheduler.baker.getJobNames()).toContain("synced");

    await db.update(cronJobs).set({ enabled: false }).where(eq(cronJobs.id, id)).run();
    await scheduler.syncJob("synced");
    expect(scheduler.baker.getJobNames()).not.toContain("synced");
  });

  test("stopCron clears the singleton — getScheduler returns null afterwards", async () => {
    await startCron({ db, logger: fakeLogger, config: fakeConfig });
    await stopCron();
    expect(getScheduler()).toBeNull();
  });

  test("scheduler-off mode (startCron never called): null handle, no seed, actions still registered", async () => {
    // `app.ts` skips `startCron` when CRON_ENABLED=false and calls
    // `initCronActions()` directly instead. Reproduce that path here.
    const { initActions } = await import("./actions");
    initActions();

    expect(getScheduler()).toBeNull();
    // No auto-seed: default log-cleanup row should NOT exist while the
    // scheduler is off.
    const rows = await db.select().from(cronJobs).where(eq(cronJobs.name, "log-cleanup")).all();
    expect(rows).toHaveLength(0);
    // But the action catalog IS populated — operators can plan jobs
    // ahead of enabling the timer and the validator still works.
    expect(await validateActionConfig("log-cleanup", { action: "log-cleanup" })).toBeNull();
  });
});

// ─── defaultEnabled opt-in mechanism ───
//
// Actions with `spec.defaultEnabled: false` are kept out of the registry
// until the operator names them in `CRON_ACTIONS_ENABLED`. The `shell`
// action ships with this gate; the test verifies both the locked-down
// default and the opt-in path.

describe("initActions defaultEnabled gating", () => {
  test("shell stays out of the registry by default", () => {
    __resetAndReinitActionsForTests();
    expect(getActionNames().sort()).toEqual(["http-request", "log-cleanup", "soft-delete-cleanup"]);
    expect(getAction("shell")).toBeUndefined();
  });

  test("listing `shell` in enabledActions registers it alongside the always-on set", () => {
    __resetAndReinitActionsForTests({ enabledActions: ["shell"] });
    expect(getActionNames().sort()).toEqual(["http-request", "log-cleanup", "shell", "soft-delete-cleanup"]);
    expect(getAction("shell")?.spec.dangerous).toBe(true);
  });

  test("enabledActions referencing an unknown action is silently ignored", () => {
    __resetAndReinitActionsForTests({ enabledActions: ["does-not-exist"] });
    expect(getActionNames().sort()).toEqual(["http-request", "log-cleanup", "soft-delete-cleanup"]);
  });
});

// ─── list filter helper ───
//
// The list route's `deleted` knob folds three string values down to a
// nullable boolean. The SPA wires its `active / deleted / all` choices
// to these; the `lastStatus` filter is a correlated subquery and gets
// e2e coverage instead of a unit on the WHERE shape.

describe("resolveDeletedFlag", () => {
  test("undefined → false (default hides tombstones)", async () => {
    const { resolveDeletedFlag } = await import("./cron.routes");
    expect(resolveDeletedFlag(undefined)).toBe(false);
  });

  test("'false' → false", async () => {
    const { resolveDeletedFlag } = await import("./cron.routes");
    expect(resolveDeletedFlag("false")).toBe(false);
  });

  test("'only' → true (tombstones only)", async () => {
    const { resolveDeletedFlag } = await import("./cron.routes");
    expect(resolveDeletedFlag("only")).toBe(true);
  });

  test("'true' → null (no constraint)", async () => {
    const { resolveDeletedFlag } = await import("./cron.routes");
    expect(resolveDeletedFlag("true")).toBeNull();
  });
});

// ─── serialize ───

describe("serializeJob", () => {
  test("serializes a job with no scheduler reference", async () => {
    const id = nanoid();
    await db.insert(cronJobs).values({
      id,
      name: "ser",
      cron: "@yearly",
      taskType: "custom",
      taskConfig: JSON.stringify({ action: "noop", x: 1 }),
      enabled: true,
    }).run();
    const row = (await db.select().from(cronJobs).where(eq(cronJobs.id, id)).get())!;

    const out = await serializeJob(db, null, row);
    expect(out.id).toBe(id);
    expect(out.taskConfig).toEqual({ action: "noop", x: 1 });
    expect(out.status).toBe("not_loaded");
    expect(out.nextExecution).toBeNull();
    expect(out.lastRun).toBeNull();
  });

  test("serializes lastRun when logs exist", async () => {
    const id = nanoid();
    await db.insert(cronJobs).values({
      id,
      name: "ser2",
      cron: "@yearly",
      taskType: "custom",
      taskConfig: JSON.stringify({ action: "noop" }),
      enabled: true,
    }).run();
    const row = (await db.select().from(cronJobs).where(eq(cronJobs.id, id)).get())!;

    const startedAt = new Date().toISOString();
    await db.insert(cronJobLogs).values({
      id: `${Date.now().toString(16).padStart(12, "0")}${nanoid().padEnd(14, "x")}`,
      jobId: id,
      startedAt,
      finishedAt: startedAt,
      durationMs: 42,
      status: "success",
      result: "ok",
    }).run();

    const out = await serializeJob(db, null, row);
    expect(out.lastRun?.status).toBe("success");
    expect(out.lastRun?.durationMs).toBe(42);
  });

  test("falls back to a raw blob when taskConfig is not valid JSON", async () => {
    const id = nanoid();
    await db.insert(cronJobs).values({
      id,
      name: "bad-json",
      cron: "@yearly",
      taskType: "custom",
      taskConfig: "{not-json",
      enabled: false,
    }).run();
    const row = (await db.select().from(cronJobs).where(eq(cronJobs.id, id)).get())!;
    const out = await serializeJob(db, null, row);
    expect(out.taskConfig).toEqual({ _raw: "{not-json" });
    expect(out.status).toBe("disabled");
  });
});
