import { registerBackupContribution } from "@/modules/backup/registry";
import { registerItemAttachmentPermissionHook } from "./attachment.permission";
import { registerItemCommentAttachmentPermissionHook } from "./comment-attachment.permission";
import { itemBackupContribution } from "./item.backup";

// No HTTP routes — the `item` module is a server-side primitive consumed by
// sub-type modules (issue, document, …). Sub-types own their `/api/<type>`
// routes and call ItemService internally.

registerBackupContribution(itemBackupContribution);

// Permission hooks for file references that the file module's routes will
// consult. Both resolve back to the parent item and ask the policy engine.
registerItemAttachmentPermissionHook();
registerItemCommentAttachmentPermissionHook();
