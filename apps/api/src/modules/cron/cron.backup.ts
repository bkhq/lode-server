import type { BackupContribution } from "@/modules/backup/registry";
import { cronJobLogs, cronJobs } from "./schema";

// Job definitions restore before their log rows so the `cron_job_logs.job_id`
// foreign key resolves on insert. The module has no cross-module deps —
// nothing references `cron_jobs` outside this module.
export const cronBackupContribution: BackupContribution = {
  name: "cron",
  tables: [cronJobs, cronJobLogs],
  deps: [],
};
