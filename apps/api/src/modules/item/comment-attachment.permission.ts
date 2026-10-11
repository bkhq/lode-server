import type { FilePermissionHook } from "@/modules/file";
import { eq } from "drizzle-orm";
import { registerFilePermissionHook } from "@/modules/file";
import { itemComments } from "@/modules/item/schema";
import { check } from "@/modules/policy/zanzibar.engine";

/**
 * Permission hook for `owner_type='item_comment_attachment'`. The owner_id
 * of such a reference is `item_comments.id`. We resolve the comment back
 * to its parent item and ask the policy engine whether the actor can read
 * (or, for delete, whether they own the attachment).
 *
 * - `canRead`  → `viewer` on the parent item, plus `editor` when the comment
 *                is internal (so viewer-only callers do not see internal
 *                attachments via direct file URLs).
 * - `canDelete`→ the uploader (`ref.createdBy === actor.id`) or admin. The
 *                route layer guarantees the uploader is the comment author,
 *                so this is "author can delete their own attachment".
 */
export const itemCommentAttachmentPermissionHook: FilePermissionHook = {
  async canRead(db, actor, ref) {
    if (actor.role === "admin")
      return true;
    const row = await db
      .select({ itemId: itemComments.itemId, isInternal: itemComments.isInternal })
      .from(itemComments)
      .where(eq(itemComments.id, ref.ownerId))
      .get();
    if (!row)
      return false;
    const relation = row.isInternal ? "editor" : "viewer";
    const result = await check(db, "item", row.itemId, relation, "user", actor.id);
    return result.allowed;
  },
  async canDelete(_db, actor, ref) {
    if (actor.role === "admin")
      return true;
    return ref.createdBy === actor.id;
  },
};

export function registerItemCommentAttachmentPermissionHook(): void {
  registerFilePermissionHook("item_comment_attachment", itemCommentAttachmentPermissionHook);
}
