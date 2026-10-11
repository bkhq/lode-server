import type { CronExpression } from "cronbake";
import type { ExecutorDeps, TaskConfig } from "./executor";
import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import Baker from "cronbake";
import { and, eq, isNull } from "drizzle-orm";
import { cronJobLogs, cronJobs } from "@/modules/cron/schema";
import { getPlatform } from "@/platform";
import { nanoid } from "@/shared/lib/id";
import { __resetAndReinitActionsForTests, getAction, getActionExecutor, getDefaultActions } from "./actions";
import { normalizeCron } from "./cron-format";
import { awaitInFlightJobs, executeTask, getInFlightJobCount } from "./executor";

export interface SchedulerDeps {
  readonly db: AppDatabase;
  readonly logger: Logger;
  readonly config: Config;
}

export interface CronScheduler {
  readonly baker: Baker;
  /** Sync a single job from DB state into Baker (add / update / remove). */
  readonly syncJob: (name: string) => Promise<void>;
}

// Baker is a genuine process-singleton (one timer per process). Routes
// pull the active handle via `getScheduler()` (null while not running).
// DB / logger / config are NOT cached on the handle — `syncJob` closes
// over the executorDeps built at `startCron` time, and routes thread
// their own `c.get("db" | "logger" | "config")` for any other work.
let _scheduler: CronScheduler | null = null;
let _shutdownLogger: Logger | null = null;

async function ensureDefaultJobs(db: AppDatabase, logger: Logger): Promise<void> {
  for (const { name, cron } of getDefaultActions()) {
    const existing = await db
      .select({ id: cronJobs.id })
      .from(cronJobs)
      .where(and(eq(cronJobs.name, name), eq(cronJobs.isDeleted, false)))
      .get();

    if (!existing) {
      // `taskType` mirrors the registered action's `category` — same
      // discriminator the create route uses, so default + user-created
      // rows are filterable through the same toolbar dropdown.
      const def = getAction(name);
      await db.insert(cronJobs).values({
        id: nanoid(),
        name,
        cron,
        taskType: def?.spec.category ?? "custom",
        taskConfig: JSON.stringify({ action: name }),
        enabled: true,
      }).run();
      logger.info({ name }, "cron_default_job_created");
    }
  }
}

/**
 * A `cron_job_logs` row stuck at `status='running'` with `finished_at IS NULL`
 * means the process died mid-execution (the `finally`/catch that finalizes the
 * row never ran). Left in place these ghost rows (a) pollute the admin UI's
 * lastStatus='running' filter forever and (b) corrupt `maybeAutoPause`'s
 * consecutive-failure streak. Reap them to `failed` once at boot, before any
 * job is scheduled, so a fresh run starts from a clean history.
 */
async function reapStaleRunningLogs(db: AppDatabase, logger: Logger): Promise<void> {
  try {
    const finishedAt = new Date().toISOString();
    const reaped = await db
      .update(cronJobLogs)
      .set({
        status: "failed",
        error: "Process exited while job was running (crash-detected on startup)",
        finishedAt,
      })
      .where(and(eq(cronJobLogs.status, "running"), isNull(cronJobLogs.finishedAt)))
      .returning({ id: cronJobLogs.id })
      .all();

    if (reaped.length > 0) {
      logger.warn({ count: reaped.length }, "cron_stale_running_logs_reaped");
    }
  }
  catch (err) {
    logger.error({ err }, "cron_stale_running_logs_reap_failed");
  }
}

function buildExecutorDeps(deps: SchedulerDeps, baker: Baker): ExecutorDeps {
  return {
    db: deps.db,
    logger: deps.logger,
    config: deps.config,
    onAutoPause: (jobName) => {
      try {
        baker.pause(jobName);
      }
      catch {
        // Job may have been removed already.
      }
    },
  };
}

function registerJob(
  baker: Baker,
  executorDeps: ExecutorDeps,
  row: typeof cronJobs.$inferSelect,
): void {
  const config = JSON.parse(row.taskConfig) as TaskConfig;

  baker.add({
    name: row.name,
    cron: normalizeCron(row.cron) as CronExpression,
    overrunProtection: true,
    callback: async () => {
      await executeTask(executorDeps, row.id, row.name, config, row.maxConsecutiveFailures);
    },
    onError: (error: Error) => {
      executorDeps.logger.error({ jobName: row.name, err: error }, "cron_job_callback_error");
    },
  });
}

async function loadJobsFromDb(
  baker: Baker,
  executorDeps: ExecutorDeps,
  db: AppDatabase,
): Promise<number> {
  const rows = await db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.enabled, true), eq(cronJobs.isDeleted, false)))
    .all();

  for (const row of rows) {
    try {
      registerJob(baker, executorDeps, row);
    }
    catch (err) {
      executorDeps.logger.error({ jobName: row.name, err }, "cron_job_register_failed");
    }
  }

  return rows.length;
}

async function syncJobInternal(
  baker: Baker,
  executorDeps: ExecutorDeps,
  db: AppDatabase,
  name: string,
): Promise<void> {
  try {
    baker.remove(name);
  }
  catch {
    // Not registered — fine.
  }

  const row = await db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.name, name), eq(cronJobs.isDeleted, false)))
    .get();

  if (row && row.enabled) {
    registerJob(baker, executorDeps, row);
    baker.bake(name);
    executorDeps.logger.info({ name }, "cron_job_synced");
  }
}

/**
 * Allocate the Baker timer, seed default jobs, load every
 * `enabled && !is_deleted` row into Baker, and start ticking.
 * Idempotent — re-invoking on an already-running scheduler is a no-op.
 *
 * Precondition: the action catalog has been populated (production
 * does this via `initCronActions()`; tests do it via the test reset
 * helper). Callers that skip both will hit "Unknown action" errors at
 * registration time.
 */
/**
 * Refuse to start the scheduler on a host that cannot keep it running.
 *
 * cronbake arms a timer per job and relies on the process staying resident
 * between firings. On a runtime that evicts the app when idle, those timers
 * stop without any error and jobs silently never run — worse than not
 * offering the feature. Called from `buildFullApp` before `startCron`, so
 * the failure lands at boot with the misconfiguration in hand.
 *
 * Such deployments drive jobs externally instead: a platform cron trigger
 * (or any outside scheduler) calling `POST /api/cron/jobs/:id/trigger`,
 * which executes a job without the in-process scheduler.
 */
export function assertCronSchedulerSupported(): void {
  if (getPlatform().capabilities.residentTimers)
    return;
  throw new Error(
    "CRON_ENABLED=true needs a runtime that keeps the app resident between "
    + "requests; this one evicts it when idle, so scheduled jobs would stop "
    + "firing silently. Set CRON_ENABLED=false and drive jobs from an "
    + "external scheduler via POST /api/cron/jobs/:id/trigger.",
  );
}

export async function startCron(deps: SchedulerDeps): Promise<void> {
  if (_scheduler)
    return;

  const baker = Baker.create({
    enableMetrics: true,
    // cronbake's default pollingInterval is 1s. Most schedules in this app
    // have minute (or coarser) resolution; a 30s poll keeps cron timing
    // responsive enough while cutting the wakeups-per-second load that
    // accumulates under tests with many short-lived jobs.
    schedulerConfig: { pollingInterval: 30_000 },
    onError: (error: Error, jobName: string) => {
      deps.logger.error({ jobName, err: error }, "cron_global_error");
    },
  });

  const executorDeps = buildExecutorDeps(deps, baker);

  // Reap crash-orphaned 'running' rows before anything is scheduled so the
  // first execution + the admin UI both see a consistent run history.
  await reapStaleRunningLogs(deps.db, deps.logger);

  try {
    await ensureDefaultJobs(deps.db, deps.logger);
  }
  catch (err) {
    deps.logger.error({ err }, "cron_ensure_defaults_failed");
  }

  const count = await loadJobsFromDb(baker, executorDeps, deps.db);

  try {
    baker.bakeAll();
  }
  catch (err) {
    deps.logger.error({ err }, "cron_bake_all_failed");
  }

  for (const { name, runOnStartup } of getDefaultActions()) {
    if (!runOnStartup)
      continue;
    const execute = getActionExecutor(name);
    if (!execute)
      continue;
    void execute({ db: deps.db, logger: deps.logger, config: deps.config }, { action: name }).catch((err: unknown) => {
      deps.logger.error({ err, action: name }, "cron_startup_run_error");
    });
  }

  deps.logger.info({ jobCount: count }, "cron_scheduler_started");

  _scheduler = {
    baker,
    syncJob: name => syncJobInternal(baker, executorDeps, deps.db, name),
  };
  _shutdownLogger = deps.logger;
}

// Bound the in-flight wait so shutdown still completes within the
// orchestrator's grace period. 20s leaves the outer shutdown some
// slack to flush + close the DB before SIGKILL lands.
const STOP_CRON_DRAIN_MS = 20_000;

/** Stop the scheduler and clear the singleton. No-op when not running. */
export async function stopCron(): Promise<void> {
  const handle = _scheduler;
  const logger = _shutdownLogger;
  if (!handle || !logger)
    return;
  try {
    // Detach Baker first so no new ticks fire while we drain in-flight work.
    handle.baker.stopAll();
    handle.baker.destroyAll();
    const stillRunning = getInFlightJobCount();
    if (stillRunning > 0) {
      logger.info({ inFlight: stillRunning }, "cron_scheduler_draining");
      const completed = await awaitInFlightJobs(STOP_CRON_DRAIN_MS);
      const remaining = getInFlightJobCount();
      if (remaining > 0) {
        logger.warn(
          { drained: completed, remaining },
          "cron_scheduler_drain_timeout",
        );
      }
    }
    logger.info("cron_scheduler_stopped");
  }
  catch (err) {
    logger.error({ err }, "cron_scheduler_stop_failed");
  }
  _scheduler = null;
  _shutdownLogger = null;
}

/**
 * Live scheduler handle, or `null` when `startCron` has not run.
 * Route handlers that touch Baker null-check the result so the
 * data-layer paths keep working with the scheduler off.
 */
export function getScheduler(): CronScheduler | null {
  return _scheduler;
}

/** Test-only: tear down the singleton + action registry so each test re-boots. */
export async function __resetCronForTests(): Promise<void> {
  await stopCron();
  __resetAndReinitActionsForTests();
}
