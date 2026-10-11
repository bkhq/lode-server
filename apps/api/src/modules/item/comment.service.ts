import type { AppDatabase } from "@/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { releaseAllByOwner } from "@/modules/file";
import { itemComments, items } from "@/modules/item/schema";
import { NotFoundError, ValidationError } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";

/**
 * `owner_type` discriminator the file module uses for comment attachments.
 * Mirrors the value in `orphan-sweep.ts`'s `ORPHAN_RULES`; keeping the two
 * in lockstep is what makes the synchronous release in {@link deleteComment}
 * idempotent with the out-of-band orphan sweep.
 */
const COMMENT_ATTACHMENT_OWNER_TYPE = "item_comment_attachment";

/**
 * Drop a comment's attachment references on the **async** GC contract: the
 * `file_references` rows go away and `files.ref_count` is decremented in
 * `releaseReference`'s own transaction; blob reclamation is deferred to the
 * existing unreferenced-files GC. We deliberately do not request the `sync`
 * contract here — driving `driver.delete` + the `files` row delete from the
 * comment-delete path is exactly the cascade the libsql encrypted-WAL quirk
 * (documented on {@link deleteComment}) penalises.
 */
const RELEASE_CONFIG = { FILE_GC_MODE: "async", FILE_PRESIGN_ENABLED: false, FILE_PRESIGN_TTL_SECONDS: 0 } as const;

export type ItemCommentRow = typeof itemComments.$inferSelect;

export interface ListCommentsOptions {
  /**
   * When `false`, rows with `is_internal = 1` are filtered out. Callers
   * resolve the actor's relations on the parent item first (typically via
   * `policy.check`) and pass `true` iff the actor has owner / assignee /
   * approver / admin role. Viewer-only actors get `false`.
   */
  readonly includeInternal: boolean;
}

export async function listComments(
  db: AppDatabase,
  itemId: string,
  opts: ListCommentsOptions,
): Promise<readonly ItemCommentRow[]> {
  const conditions = [eq(itemComments.itemId, itemId)];
  if (!opts.includeInternal) {
    conditions.push(eq(itemComments.isInternal, false));
  }
  return await db
    .select()
    .from(itemComments)
    .where(and(...conditions))
    .orderBy(asc(itemComments.createdAt), asc(itemComments.id))
    .all();
}

export async function getCommentById(
  db: AppDatabase,
  itemId: string,
  commentId: string,
): Promise<ItemCommentRow | undefined> {
  return await db
    .select()
    .from(itemComments)
    .where(and(eq(itemComments.id, commentId), eq(itemComments.itemId, itemId)))
    .get();
}

export interface CreateCommentInput {
  readonly itemId: string;
  readonly authorId: string;
  readonly content: string;
  readonly replyToId?: string | null | undefined;
  readonly isInternal?: boolean | undefined;
}

/**
 * Create a comment. Reply validation:
 *
 * 1. The target comment must exist.
 * 2. The target must belong to the same `itemId` (no cross-item replies).
 * 3. If the target is `is_internal=1`, the reply is forced to `is_internal=1`
 *    too — internal threads stay internal so a viewer-only actor can't
 *    quote-leak an internal parent.
 *
 * Reasons (1) and (2) throw `ValidationError`; reason (3) is silent
 * coercion.
 */
export async function createComment(
  db: AppDatabase,
  input: CreateCommentInput,
): Promise<ItemCommentRow> {
  // Verify parent item exists and is live (callers usually already did this,
  // but the base guards anyway — a comment on a soft-deleted item would be
  // invisible everywhere and is almost certainly a bug).
  const parent = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.id, input.itemId), isNull(items.deletedAt)))
    .get();
  if (!parent)
    throw new NotFoundError("Item", input.itemId);

  let replyToId: string | null = null;
  let isInternal = input.isInternal ?? false;

  if (input.replyToId) {
    const target = await db
      .select({ id: itemComments.id, itemId: itemComments.itemId, isInternal: itemComments.isInternal })
      .from(itemComments)
      .where(eq(itemComments.id, input.replyToId))
      .get();
    if (!target) {
      throw new ValidationError(`Reply target ${input.replyToId} not found`, {
        replyToId: "Unknown comment id",
      });
    }
    if (target.itemId !== input.itemId) {
      throw new ValidationError("Reply target belongs to a different item", {
        replyToId: "Cross-item replies are not allowed",
      });
    }
    replyToId = target.id;
    if (target.isInternal && !isInternal) {
      // Force internal so threads don't leak across the visibility boundary.
      isInternal = true;
    }
  }

  const id = nanoid();
  const now = new Date().toISOString();

  await db.insert(itemComments).values({
    id,
    itemId: input.itemId,
    authorId: input.authorId,
    replyToId,
    content: input.content,
    isInternal,
    createdAt: now,
    updatedAt: now,
  }).run();

  return (await db.select().from(itemComments).where(eq(itemComments.id, id)).get())!;
}

/**
 * Hard delete (no soft delete for comments). The FK `ON DELETE SET NULL`
 * leaves any replies addressable but with `reply_to_id = NULL`; the UI
 * surfaces them as "replying to a removed comment".
 *
 * Attachment references are released **synchronously** here. The original
 * design relied solely on the out-of-band `runOrphanSweep` pass to reclaim
 * the leftover `file_references` rows, but that sweep does not run when the
 * file GC is disabled (`FILE_GC_INTERVAL_SECONDS=0`) or set to `sync` mode
 * — so refs (and, via `ref_count`, blobs) leaked permanently and storage
 * correctness silently depended on an optional background job.
 *
 * We now always release the comment's references on delete, reusing the
 * exact path the sweep uses (`releaseAllByOwner` → `releaseReference`,
 * `owner_type = 'item_comment_attachment'`). This is idempotent with the
 * sweep: a later sweep pass simply finds no orphan rows for this comment.
 *
 * The libsql encrypted-WAL recovery quirk that previously blocked an
 * in-line release was specific to driving the **blob delete** (`sync` GC:
 * `driver.delete` + `files` row delete) from this transaction. We sidestep
 * it by releasing on the **async** GC contract (see {@link RELEASE_CONFIG}):
 * only the `file_references` rows and `files.ref_count` change here, each
 * in `releaseReference`'s own transaction — never inside the
 * `itemComments` delete — and blob reclamation stays with the existing
 * unreferenced-files GC. The signature is unchanged because the release
 * contract is fixed, not caller-supplied.
 *
 * References are released before the row delete so a crash between the two
 * steps degrades to the original behaviour (leftover orphans the sweep can
 * still reclaim) rather than losing the ability to find them.
 */
export async function deleteComment(db: AppDatabase, commentId: string): Promise<void> {
  await releaseAllByOwner(db, RELEASE_CONFIG, COMMENT_ATTACHMENT_OWNER_TYPE, commentId);
  await db.delete(itemComments).where(eq(itemComments.id, commentId)).run();
}
