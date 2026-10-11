import type { Config } from "@/config";
import type { Logger } from "@/shared/lib/logger";
import { registerBackupContribution } from "@/modules/backup/registry";
import { fileBackupContribution } from "./file.backup";
import { getDriver, setActiveDriver } from "./storage/registry";
// Side-effect import: the local driver self-registers at module load.
// Downstream projects shipping S3 / Azure / GCS drivers follow the same
// pattern — a single import here is enough; no patch of initFileModule
// required.
import "./storage/local";

export { fileRoutes } from "./file.routes";
export type { FileServiceConfig } from "./file.service";
export {
  addReference,
  buildDownloadResponse,
  getFileById,
  getReferenceById,
  listAttachmentsByOwner,
  listReferencesByOwner,
  makeAttachmentView,
  releaseAllByOwner,
  releaseReference,
  totalStoredBytes,
  uploadAndReference,
} from "./file.service";
export { startFileGcSweep, stopFileGcSweep } from "./gc";
export type { FilePermissionHook } from "./permission";
export { registerFilePermissionHook } from "./permission";

registerBackupContribution(fileBackupContribution);

/**
 * Activate the configured storage driver. Called once from
 * `app.ts::buildFullApp`. GC mode + presign settings are no longer
 * cached as module-level singletons here — `releaseReference`,
 * `releaseAllByOwner`, and `buildDownloadResponse` accept a narrow
 * `FileServiceConfig` parameter that callers thread through from
 * `c.get("config")`. Driver registration happens at module load
 * (side-effect imports above); this function only picks the active
 * driver and runs its optional `setup(config)` hook.
 */
export async function initFileModule(config: Config, logger?: Pick<Logger, "warn">): Promise<void> {
  const driver = getDriver(config.FILE_STORAGE_DRIVER);
  await driver.setup?.(config);
  setActiveDriver(config.FILE_STORAGE_DRIVER);
  // FILE_PRESIGN_ENABLED defaults to true, but presigning is a driver
  // capability the bundled `local` driver does not have — downloads then
  // stream through the API. Say so once at boot instead of silently
  // ignoring the setting.
  if (config.FILE_PRESIGN_ENABLED && !driver.presignDownload) {
    logger?.warn(
      { driver: driver.name },
      "FILE_PRESIGN_ENABLED is set but the active storage driver cannot presign downloads; files will stream through the API",
    );
  }
}
