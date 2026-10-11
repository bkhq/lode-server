import type { Config } from "@/config";
import type { AppDatabase } from "@/db";
import type { ScheduledHandle } from "@/platform";
import type { Logger } from "@/shared/lib/logger";
import { getPlatform } from "@/platform";
import { runUploadSweepOnce } from "./upload.service";

const FIRST_RUN_DELAY_MS = 30 * 1000;

let task: ScheduledHandle | undefined;
// Mutable for the same reason as the file GC's: a rebuilt app hands over a
// new db handle, and the long-lived task must not keep the old one.
let currentDb: AppDatabase | undefined;

/**
 * Start the periodic sweep of expired multipart uploads. Idempotent: a
 * second call only swaps the live `db` reference.
 * `REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS=0` disables it.
 *
 * Scheduled through the platform seam (timers on Bun, the Durable Object
 * alarm on Workers), which never overlaps runs. `firstRunDelayMs` is a
 * parameter for the tests.
 */
export function startRegistryUploadSweep(db: AppDatabase, config: Config, logger: Logger, firstRunDelayMs = FIRST_RUN_DELAY_MS): void {
  currentDb = db;
  if (task)
    return;
  if (config.REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS <= 0)
    return;

  const run = async () => {
    const live = currentDb;
    if (!live)
      return;
    try {
      const swept = await runUploadSweepOnce(live, config);
      if (swept > 0)
        logger.info({ swept }, "registry upload sweep");
    }
    catch (err) {
      logger.error({ err }, "registry upload sweep failed");
    }
  };

  task = getPlatform().scheduler.every(
    "registry-upload-sweep",
    { delayMs: firstRunDelayMs, intervalMs: config.REGISTRY_UPLOAD_SWEEP_INTERVAL_SECONDS * 1000 },
    run,
  );
}

/** Stop the sweep and wait for a pass already running; for shutdown, before the database closes, and for tests. */
export async function stopRegistryUploadSweep(): Promise<void> {
  const t = task;
  task = undefined;
  await t?.stop();
}
