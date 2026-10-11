import { registerBackupContribution } from "@/modules/backup/registry";
import { cronBackupContribution } from "./cron.backup";

// Populates the in-memory action catalog without allocating the
// scheduler. `app.ts` calls it unconditionally so `/cron/actions`,
// the create-time validator, and manual triggers keep working when
// the cron gate is off.
export { initActions as initCronActions } from "./actions";
export { cronRoutes } from "./cron.routes";
export { assertCronSchedulerSupported, startCron, stopCron } from "./cron.service";

registerBackupContribution(cronBackupContribution);
