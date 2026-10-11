import type { BackupContribution } from "@/modules/backup/registry";
import { groupMembers, groups } from "@/modules/account/groups/schema";
import { userPreferences, users } from "@/modules/account/users/schema";

// One backup row per meta-module — users + groups + group memberships +
// per-user preferences stay together so an import never separates
// membership from members. `name` is the stable identifier in backup
// files; renaming it is a breaking change (bump file `version` in
// export.service.ts).
export const accountBackupContribution: BackupContribution = {
  name: "users",
  tables: [users, groups, groupMembers, userPreferences],
  deps: [],
};
