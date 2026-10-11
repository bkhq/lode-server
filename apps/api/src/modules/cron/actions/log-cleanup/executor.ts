import type { ActionExecutor } from "../types";
import { and, count, desc, eq, lt } from "drizzle-orm";
import { cronJobLogs, cronJobs } from "@/modules/cron/schema";
import { MAX_LOGS_PER_JOB } from "./spec";

/**
 * Trim cron_job_logs: keep the newest `MAX_LOGS_PER_JOB` rows per active
 * job and purge every log row belonging to soft-deleted jobs. Returns
 * a short status string used by the run-history UI.
 */
export const execute: ActionExecutor = async (ctx) => {
  const jobs = await ctx.db
    .select({ id: cronJobs.id, isDeleted: cronJobs.isDeleted })
    .from(cronJobs)
    .all();

  let totalDeleted = 0;

  for (const job of jobs) {
    if (job.isDeleted) {
      const totalRow = await ctx.db
        .select({ value: count() })
        .from(cronJobLogs)
        .where(eq(cronJobLogs.jobId, job.id))
        .get();
      const cnt = totalRow?.value ?? 0;
      if (cnt > 0) {
        await ctx.db.delete(cronJobLogs).where(eq(cronJobLogs.jobId, job.id)).run();
        totalDeleted += cnt;
      }
      continue;
    }

    const keepIds = await ctx.db
      .select({ id: cronJobLogs.id })
      .from(cronJobLogs)
      .where(eq(cronJobLogs.jobId, job.id))
      .orderBy(desc(cronJobLogs.id))
      .limit(MAX_LOGS_PER_JOB)
      .all();

    if (keepIds.length < MAX_LOGS_PER_JOB)
      continue;

    const oldest = keepIds.at(-1)!.id;
    const totalRow = await ctx.db
      .select({ value: count() })
      .from(cronJobLogs)
      .where(and(eq(cronJobLogs.jobId, job.id), lt(cronJobLogs.id, oldest)))
      .get();
    const cnt = totalRow?.value ?? 0;
    if (cnt > 0) {
      await ctx.db
        .delete(cronJobLogs)
        .where(and(eq(cronJobLogs.jobId, job.id), lt(cronJobLogs.id, oldest)))
        .run();
      totalDeleted += cnt;
    }
  }

  if (totalDeleted > 0) {
    ctx.logger.info({ deleted: totalDeleted }, "cron_log_cleanup_done");
  }
  return `deleted ${totalDeleted} old log entries`;
};
