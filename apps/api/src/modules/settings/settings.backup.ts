import type { BackupContribution } from "@/modules/backup/registry";
import { settings } from "@/modules/settings/schema";

export const settingsBackupContribution: BackupContribution = {
  name: "settings",
  tables: [settings],
  deps: [],
};
