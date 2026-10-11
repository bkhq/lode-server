import type { ActionSpec } from "../types";

/** How many newest rows to keep per active job. */
export const MAX_LOGS_PER_JOB = 1000;

/**
 * Declarative definition of the `log-cleanup` action. Contains no
 * execution logic — see `./executor.ts` for the implementation that the
 * cron task runner invokes.
 */
export const spec: ActionSpec = {
  name: "log-cleanup",
  displayName: "Log cleanup",
  description: "Trim cron job logs to keep last 1000 per job; purge logs of soft-deleted jobs.",
  category: "maintenance",
  icon: "Eraser",
  tags: ["retention"],
  version: "1.0.0",
  // Daily at 03:00 — quiet hours on most deployments.
  defaultCron: "0 0 3 * * *",
};
