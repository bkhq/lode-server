import type Baker from "cronbake";
import type { AppDatabase } from "@/db";
import type { cronJobs } from "@/modules/cron/schema";
import { desc, eq } from "drizzle-orm";
import { cronJobLogs } from "@/modules/cron/schema";

export interface LastRun {
  readonly status: string;
  readonly startedAt: string;
  readonly durationMs: number | null;
  readonly result: string | null;
  readonly error: string | null;
}

export interface SerializedCronJob {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly taskType: string;
  readonly taskConfig: Record<string, unknown>;
  readonly enabled: boolean;
  readonly status: string;
  readonly nextExecution: string | null;
  readonly lastRun: LastRun | null;
  readonly maxConsecutiveFailures: number;
  readonly isDeleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Fold a `cron_jobs` row + live Baker state + last log row into one DTO. The
 * Baker handle is optional so callers without a running scheduler (tests,
 * the just-deleted path that already removed the job from Baker) still get
 * a coherent payload — `status` falls back to a DB-derived label and
 * `nextExecution` is null.
 */
export async function serializeJob(
  db: AppDatabase,
  baker: Baker | null,
  row: typeof cronJobs.$inferSelect,
): Promise<SerializedCronJob> {
  let status = row.enabled ? "not_loaded" : "disabled";
  let nextExecution: string | null = null;

  if (baker) {
    try {
      status = baker.getStatus(row.name);
      const next = baker.nextExecution(row.name);
      nextExecution = next ? next.toISOString() : null;
    }
    catch {
      // Job not registered in Baker (e.g. just deleted) — keep DB-derived defaults.
    }
  }

  let taskConfig: Record<string, unknown>;
  try {
    taskConfig = JSON.parse(row.taskConfig) as Record<string, unknown>;
  }
  catch {
    taskConfig = { _raw: row.taskConfig };
  }

  const latestLog = await db
    .select({
      status: cronJobLogs.status,
      startedAt: cronJobLogs.startedAt,
      durationMs: cronJobLogs.durationMs,
      result: cronJobLogs.result,
      error: cronJobLogs.error,
    })
    .from(cronJobLogs)
    .where(eq(cronJobLogs.jobId, row.id))
    .orderBy(desc(cronJobLogs.id))
    .limit(1)
    .get();

  const lastRun: LastRun | null = latestLog
    ? {
        status: latestLog.status,
        startedAt: latestLog.startedAt,
        durationMs: latestLog.durationMs,
        result: latestLog.result,
        error: latestLog.error,
      }
    : null;

  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    taskType: row.taskType,
    taskConfig,
    enabled: row.enabled,
    status,
    nextExecution,
    lastRun,
    maxConsecutiveFailures: row.maxConsecutiveFailures,
    isDeleted: row.isDeleted,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
