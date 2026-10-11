import type { ActionSpec } from "../types";

export const MAX_OLDER_THAN_DAYS = 365 * 10;

/**
 * Declarative definition of the `soft-delete-cleanup` action.
 *
 * Ships **without** a `defaultCron` so it is never seeded automatically.
 * Operators schedule it explicitly when they want a janitor pass; the
 * rest of the time the soft-delete marker stays in place so
 * `/cron/jobs?deleted=only` can still surface the tombstone for
 * forensics / restore-by-re-create.
 */
export const spec: ActionSpec = {
  name: "soft-delete-cleanup",
  displayName: "Soft-delete cleanup",
  description: "Hard-delete soft-deleted cron jobs (and cascade their log rows). Opt-in — never auto-mounted.",
  category: "maintenance",
  icon: "Trash2",
  tags: ["retention"],
  version: "1.0.0",
  inputs: [
    {
      key: "olderThanDays",
      label: "Grace window (days)",
      type: "number",
      min: 0,
      max: MAX_OLDER_THAN_DAYS,
      default: 0,
      description:
        "Only purge rows whose `updated_at` is older than this many days. `0` purges every soft-deleted row immediately.",
    },
  ],
};
