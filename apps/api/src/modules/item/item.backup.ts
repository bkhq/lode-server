import type { BackupContribution } from "@/modules/backup/registry";
import { itemComments, items } from "@/modules/item/schema";

export const itemBackupContribution: BackupContribution = {
  name: "items",
  tables: [items, itemComments],
  deps: ["users"],
};
