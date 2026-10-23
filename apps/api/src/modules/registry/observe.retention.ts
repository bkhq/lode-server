import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { ScheduledHandle } from "@/platform";
import type { Logger } from "@/shared/lib/logger";
import { getPlatform } from "@/platform";
import { pruneObservations } from "./observe.service";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 30 * 1000;

let task: ScheduledHandle | undefined;
// Mutable for the same reason as the audit sweep's: a rebuilt app hands over
// a new db handle, and the long-lived task must not keep the old one.
let currentDb: AppDatabase | undefined;

/**
 * Start the hourly sweep of reported events and silent instances older than
 * `REGISTRY_OBSERVE_RETENTION_DAYS`. Idempotent: a second call only swaps the
 * live `db` reference. A retention of 0 disables it.
 */
export function startObserveRetentionSweep(db: AppDatabase, config: Config, logger: Logger): void {
  currentDb = db;
  if (task || config.REGISTRY_OBSERVE_RETENTION_DAYS <= 0)
    return;
  const run = async () => {
    const live = currentDb;
    if (!live)
      return;
    try {
      const deleted = await pruneObservations(live, config.REGISTRY_OBSERVE_RETENTION_DAYS);
      if (deleted > 0)
        logger.info({ deleted }, "registry observe retention sweep");
    }
    catch (err) {
      logger.error({ err }, "registry observe retention sweep failed");
    }
  };
  task = getPlatform().scheduler.every("registry-observe-retention", { delayMs: FIRST_SWEEP_DELAY_MS, intervalMs: SWEEP_INTERVAL_MS }, run);
}

/** Stop the sweep and wait for a pass already running. */
export async function stopObserveRetentionSweep(): Promise<void> {
  const t = task;
  task = undefined;
  await t?.stop();
  currentDb = undefined;
}
