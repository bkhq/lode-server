import { registerBackupContribution } from "@/modules/backup/registry";
import { settingsBackupContribution } from "./settings.backup";

export { settingsRoutes } from "./settings.routes";

registerBackupContribution(settingsBackupContribution);
