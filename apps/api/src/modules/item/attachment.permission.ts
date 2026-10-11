import type { FilePermissionHook } from "@/modules/file";
import { registerFilePermissionHook } from "@/modules/file";
import { check } from "@/modules/policy/zanzibar.engine";

/**
 * Permission hook for `owner_type='item_attachment'`. The owner_id of an
 * `item_attachment` reference is the item id, so we ask the policy engine
 * whether the actor holds the required relation on `item:<id>`:
 *
 * - `canRead`  → `viewer` (inherits via editor / owner / parent_item)
 * - `canDelete`→ `editor` (so commenters / watchers cannot remove attachments)
 *
 * Admin bypass lives here, not in the file module — `mod-file` does not
 * know about the `users.role` column. Sub-types that need a different
 * delete policy (e.g. "uploader can also delete") can layer it on top by
 * extending this hook's logic, but the base rule is `editor` so the
 * permission story stays uniform across sub-types.
 */
export const itemAttachmentPermissionHook: FilePermissionHook = {
  async canRead(db, actor, ref) {
    if (actor.role === "admin")
      return true;
    const result = await check(db, "item", ref.ownerId, "viewer", "user", actor.id);
    return result.allowed;
  },
  async canDelete(db, actor, ref) {
    if (actor.role === "admin")
      return true;
    const result = await check(db, "item", ref.ownerId, "editor", "user", actor.id);
    return result.allowed;
  },
};

/** Called once from the item module's index.ts at load time. */
export function registerItemAttachmentPermissionHook(): void {
  registerFilePermissionHook("item_attachment", itemAttachmentPermissionHook);
}
