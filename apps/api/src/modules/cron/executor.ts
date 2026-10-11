import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { and, desc, eq, ne } from "drizzle-orm";
import { cronJobLogs, cronJobs } from "@/modules/cron/schema";
import { ulid } from "@/shared/lib/id";
import { getActionExecutor } from "./actions";

/**
 * Default auto-pause threshold for new jobs that don't override it. Three
 * consecutive failures is the threshold most ops teams want: enough to
 * absorb a transient outage, low enough that a wedged handler stops
 * burning retry budget within minutes on a one-minute schedule.
 *
 * Callers may pass `0` per-job to opt out of auto-pause entirely (jobs
 * that MUST keep retrying through a downstream incident).
 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

// Module-level registry of in-flight job promises. `stopCron` awaits these
// before the shutdown path closes the DB; without this a long-running
// action ends up writing to a freshly-closed handle and the
// `cron_job_logs` row never finalizes. Promises are added on entry and
// removed in `finally`, so reads of the set during shutdown reflect the
// jobs that are *still* executing.
const inFlight = new Set<Promise<unknown>>();

export function getInFlightJobCount(): number {
  return inFlight.size;
}

export async function awaitInFlightJobs(maxWaitMs: number): Promise<number> {
  if (inFlight.size === 0)
    return 0;
  const started = inFlight.size;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise<void>(resolve => setTimeout(resolve, maxWaitMs).unref?.()),
  ]);
  return started - inFlight.size;
}

export interface TaskConfig {
  readonly action: string;
  readonly [key: string]: unknown;
}

export interface ExecutorDeps {
  readonly db: AppDatabase;
  readonly logger: Logger;
  readonly config: Config;
  /** Optional hook invoked after auto-pause so the scheduler can detach. */
  readonly onAutoPause?: (jobName: string) => void;
}

/**
 * Run one task and persist a `cron_job_logs` row that records start, end,
 * status, and either the handler's string result or its error message.
 * Returns the log id so callers can read back the freshly-written row
 * without re-querying by `(job_id, started_at)`.
 *
 * On `maxConsecutiveFailures` failures in a row the job is auto-paused
 * (`enabled=false`) and the optional `onAutoPause` hook fires so the live
 * scheduler can stop receiving ticks for it without restarting the API.
 * Pass `0` to disable auto-pause entirely.
 */
export async function executeTask(
  deps: ExecutorDeps,
  jobId: string,
  jobName: string,
  taskConfig: TaskConfig,
  maxConsecutiveFailures: number = DEFAULT_MAX_CONSECUTIVE_FAILURES,
): Promise<string> {
  const work = executeTaskImpl(deps, jobId, jobName, taskConfig, maxConsecutiveFailures);
  inFlight.add(work);
  try {
    return await work;
  }
  finally {
    inFlight.delete(work);
  }
}

async function executeTaskImpl(
  deps: ExecutorDeps,
  jobId: string,
  jobName: string,
  taskConfig: TaskConfig,
  maxConsecutiveFailures: number,
): Promise<string> {
  const { db, logger, config } = deps;
  const logId = ulid();
  const startedAt = new Date().toISOString();

  await db.insert(cronJobLogs).values({
    id: logId,
    jobId,
    startedAt,
    status: "running",
  }).run();

  try {
    const execute = getActionExecutor(taskConfig.action);
    if (!execute) {
      throw new Error(`Unknown action: ${taskConfig.action}`);
    }

    const result = await execute({ db, logger, config }, taskConfig);

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - new Date(startedAt).getTime();

    await db.update(cronJobLogs)
      .set({ status: "success", result, finishedAt: finishedAt.toISOString(), durationMs })
      .where(eq(cronJobLogs.id, logId))
      .run();

    logger.debug({ jobName, durationMs, result }, "cron_job_success");
    return logId;
  }
  catch (err) {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - new Date(startedAt).getTime();
    const errorMessage = err instanceof Error ? err.message : String(err);

    await db.update(cronJobLogs)
      .set({ status: "failed", error: errorMessage, finishedAt: finishedAt.toISOString(), durationMs })
      .where(eq(cronJobLogs.id, logId))
      .run();

    logger.error({ jobName, durationMs, err }, "cron_job_failed");

    try {
      await maybeAutoPause(deps, jobId, jobName, maxConsecutiveFailures);
    }
    catch (pauseErr) {
      logger.error({ jobName, err: pauseErr }, "cron_auto_pause_check_failed");
    }

    return logId;
  }
}

async function maybeAutoPause(
  deps: ExecutorDeps,
  jobId: string,
  jobName: string,
  threshold: number,
): Promise<void> {
  // 0 (or any non-positive value) disables auto-pause entirely — used by
  // jobs that must keep retrying through a downstream incident.
  if (threshold <= 0)
    return;

  // Order by the actual run time, not the ULID. `id` is a ULID so it is
  // *usually* monotonic with `started_at`, but a clock skew or a backfilled
  // row would order the streak wrong; `started_at` is the source of truth,
  // with `id` only as a same-millisecond tiebreaker. Rows still 'running'
  // (e.g. a ghost row from a crash) are excluded so an unfinished run can't
  // reset or skew the consecutive-failure streak.
  const recent = await deps.db
    .select({ status: cronJobLogs.status })
    .from(cronJobLogs)
    .where(and(eq(cronJobLogs.jobId, jobId), ne(cronJobLogs.status, "running")))
    .orderBy(desc(cronJobLogs.startedAt), desc(cronJobLogs.id))
    .limit(threshold)
    .all();

  if (recent.length < threshold)
    return;
  if (!recent.every(r => r.status === "failed"))
    return;

  await deps.db
    .update(cronJobs)
    .set({ enabled: false })
    .where(and(eq(cronJobs.id, jobId), eq(cronJobs.enabled, true)))
    .run();

  deps.onAutoPause?.(jobName);

  deps.logger.warn(
    { jobName, consecutiveFailures: threshold },
    "cron_job_auto_paused",
  );
}
