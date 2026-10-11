import type { BackupContribution } from "@/modules/backup/registry";
import { fileReferences, files } from "@/modules/file/schema";

export const fileBackupContribution: BackupContribution = {
  name: "files",
  // `files` first so the FK on `file_references.file_id` resolves on restore.
  tables: [files, fileReferences],
  deps: ["users"],
};
