import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Job definitions registered with the scheduler. `taskConfig` is JSON text;
// `task_type` mirrors the registered action's `category` (e.g. `maintenance`,
// `network`, `system`, `custom`) so the admin UI can filter jobs by domain.
export const cronJobs = sqliteTable("cron_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  cron: text("cron").notNull(),
  taskType: text("task_type").notNull(),
  taskConfig: text("task_config").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  isDeleted: integer("is_deleted", { mode: "boolean" }).notNull().default(false),
  // Auto-pause threshold: N consecutive `cron_job_logs.status='failed'`
  // rows flip the job to `enabled=false` so a misconfigured handler can't
  // burn its retry budget forever. Default 3 matches what most operators
  // want. `0` disables auto-pause for jobs that must keep retrying (e.g.
  // a heartbeat that flaps while a downstream is briefly out).
  maxConsecutiveFailures: integer("max_consecutive_failures").notNull().default(3),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_cron_jobs_name").on(t.name),
  index("idx_cron_jobs_enabled").on(t.enabled),
]);

// Per-run history. `id` is a ULID so monotonic ordering equals run order
// (cf. audit_events); the foreign key cascades so deleting a job purges its
// run history. The compound `(job_id, started_at)` index serves the
// "latest run per job" query the admin UI shows on every refresh.
export const cronJobLogs = sqliteTable("cron_job_logs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => cronJobs.id, { onDelete: "cascade" }),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  durationMs: integer("duration_ms"),
  status: text("status", { enum: ["running", "success", "failed"] }).notNull(),
  result: text("result"),
  error: text("error"),
}, t => [
  index("idx_cron_job_logs_job").on(t.jobId),
  index("idx_cron_job_logs_job_started").on(t.jobId, t.startedAt),
  index("idx_cron_job_logs_status").on(t.status),
]);
