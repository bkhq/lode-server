import type { BackupContribution } from "@/modules/backup/registry";
import { relationTuples, resourceGroups } from "@/modules/policy/schema";

export const policyBackupContribution: BackupContribution = {
  name: "policies",
  tables: [resourceGroups, relationTuples],
  // Tuples reference user / group ids, so users must restore first.
  deps: ["users"],
};
