import type { ActionExecutor } from "../types";
import { and, count, eq, lt } from "drizzle-orm";
import { cronJobLogs, cronJobs } from "@/modules/cron/schema";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Hard-delete soft-deleted cron_jobs rows. The `cron_job_logs.job_id`
 * FK has `ON DELETE CASCADE`, so each removed job takes its full run
 * history with it in the same statement — no separate logs sweep
 * needed.
 *
 * Reads the optional `config.olderThanDays` so the same executor can
 * service both "purge immediately" and "purge after N days of grace"
 * schedules.
 */
export const execute: ActionExecutor = async (ctx, config) => {
  const olderThanDays = config.olderThanDays === undefined ? 0 : Number(config.olderThanDays);
  const cutoffIso = olderThanDays > 0
    ? new Date(Date.now() - olderThanDays * MS_PER_DAY).toISOString()
    : null;

  const conditions = [eq(cronJobs.isDeleted, true)];
  if (cutoffIso)
    conditions.push(lt(cronJobs.updatedAt, cutoffIso));
  const where = conditions.length === 1 ? conditions[0]! : and(...conditions)!;

  const candidates = await ctx.db
    .select({ id: cronJobs.id })
    .from(cronJobs)
    .where(where)
    .all();

  if (candidates.length === 0)
    return "no soft-deleted jobs to purge";

  // CASCADE handles the per-job log table; count up front for the result string.
  let logCount = 0;
  for (const c of candidates) {
    const totalRow = await ctx.db
      .select({ value: count() })
      .from(cronJobLogs)
      .where(eq(cronJobLogs.jobId, c.id))
      .get();
    logCount += totalRow?.value ?? 0;
  }

  await ctx.db.delete(cronJobs).where(where).run();

  ctx.logger.info(
    { jobs: candidates.length, cascadedLogs: logCount, olderThanDays },
    "cron_soft_delete_cleanup_done",
  );

  return `purged ${candidates.length} soft-deleted jobs (cascaded ${logCount} log rows)`;
};
