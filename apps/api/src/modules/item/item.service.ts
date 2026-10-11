import type { AppDatabase } from "@/db";
import { and, count, desc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { items } from "@/modules/item/schema";
import { DIRECT_SUBJECT, relationTuples } from "@/modules/policy/schema";
import { NotFoundError, ValidationError } from "@/shared/lib/errors";
import { nanoid, ulid } from "@/shared/lib/id";

export type ItemRow = typeof items.$inferSelect;

const LIKE_SPECIAL_RE = /[%_]/g;

function escapeLike(v: string): string {
  return v.replace(LIKE_SPECIAL_RE, "\\$&");
}

/**
 * Optimistic-concurrency conflict result. Returned by {@link updateItem} when
 * the caller's `expectedVersion` no longer matches the stored row — another
 * writer has updated the item since the caller last read it.
 */
export interface VersionConflict {
  readonly conflict: true;
  readonly current: ItemRow;
}

export function isVersionConflict(v: unknown): v is VersionConflict {
  return typeof v === "object" && v !== null && (v as { conflict?: unknown }).conflict === true;
}

export interface CreateItemInput {
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly creatorId: string;
  /** Override the auto-generated nanoid short id. Sub-types pass this when they want bespoke human ids. */
  readonly shortId?: string | undefined;
  /** Reuse an existing ULID (for fixtures). Production callers omit; the service generates one. */
  readonly id?: string | undefined;
}

/**
 * Create a new item and write the `(item, X, owner, user, creator)`
 * policy tuple in the same transaction. Sub-types layer additional
 * relations (assignee, approver, viewer, parent_item) on top by calling
 * `policy.createTuple` after this returns.
 *
 * - `id` is a ULID — the first 10 chars encode the creation millisecond
 *   so ordering by `id DESC` is equivalent to time-desc.
 * - `shortId` is an 8-char nanoid (unique-indexed). Sub-types may pass
 *   a custom value to get human-friendly identifiers; collisions surface
 *   immediately as a UNIQUE-constraint violation.
 *
 * No audit emission here — sub-types own their action naming
 * (`issue.created`, `document.created`, …) and emit at the route layer.
 */
export async function createItem(db: AppDatabase, input: CreateItemInput): Promise<ItemRow> {
  return await db.transaction(async (tx) => {
    const id = input.id ?? ulid();
    const shortId = input.shortId ?? nanoid();
    const now = new Date().toISOString();

    await tx.insert(items).values({
      id,
      shortId,
      type: input.type,
      title: input.title,
      status: input.status,
      creatorId: input.creatorId,
      version: 1,
      deletedAt: null,
      updatedAt: now,
    }).run();

    // Write the `(item, X, owner, user, creator)` tuple in the same
    // transaction as the items row. We inline the insert rather than call
    // policy.createTuple because the latter expects the top-level
    // AppDatabase shape (close / checkpoint), and we need the atomic guarantee.
    await tx.insert(relationTuples).values({
      id: nanoid(),
      namespace: "item",
      objectId: id,
      relation: "owner",
      subjectNamespace: "user",
      subjectId: input.creatorId,
      subjectRelation: DIRECT_SUBJECT,
      createdBy: input.creatorId,
      createdAt: now,
    }).run();

    return (await tx.select().from(items).where(eq(items.id, id)).get())!;
  });
}

/** Get a live (non-soft-deleted) item by its internal id. */
export async function getItemById(db: AppDatabase, id: string): Promise<ItemRow | undefined> {
  return await db
    .select()
    .from(items)
    .where(and(eq(items.id, id), isNull(items.deletedAt)))
    .get();
}

/** Get a live item by its short id (== internal id by default; sub-types may override). */
export async function getItemByShortId(db: AppDatabase, shortId: string): Promise<ItemRow | undefined> {
  return await db
    .select()
    .from(items)
    .where(and(eq(items.shortId, shortId), isNull(items.deletedAt)))
    .get();
}

export interface UpdateItemInput {
  readonly title?: string | undefined;
  readonly status?: string | undefined;
  readonly shortId?: string | undefined;
  /**
   * Required if the caller wants optimistic concurrency. When supplied and
   * the stored row has a different version, the call returns a
   * {@link VersionConflict} instead of writing.
   */
  readonly expectedVersion?: number | undefined;
}

export async function updateItem(
  db: AppDatabase,
  id: string,
  input: UpdateItemInput,
): Promise<ItemRow | VersionConflict | undefined> {
  const now = new Date().toISOString();
  const setData: Record<string, unknown> = { updatedAt: now };

  if (input.title !== undefined)
    setData.title = input.title;
  if (input.status !== undefined)
    setData.status = input.status;
  if (input.shortId !== undefined)
    setData.shortId = input.shortId;

  // Always bump version on a successful write so subsequent reads observe a
  // strictly-monotonic counter.
  setData.version = sql`${items.version} + 1`;

  const where = input.expectedVersion !== undefined
    ? and(eq(items.id, id), isNull(items.deletedAt), eq(items.version, input.expectedVersion))
    : and(eq(items.id, id), isNull(items.deletedAt));

  const result = await db.update(items).set(setData).where(where).run();

  if (input.expectedVersion !== undefined && result.rowsAffected === 0) {
    // Either the item is gone, soft-deleted, or the version doesn't match.
    const current = await db.select().from(items).where(eq(items.id, id)).get();
    if (current && current.version !== input.expectedVersion) {
      return { conflict: true, current };
    }
    return current;
  }

  return await db.select().from(items).where(eq(items.id, id)).get();
}

/**
 * Soft-delete: stamp `deleted_at`, leave row + comments + (future)
 * attachments in place. Tuple cleanup happens here so listObjects calls
 * stop returning the dead item immediately.
 *
 * Hard delete is intentionally NOT exposed; see plan §H for the
 * janitor / retention design.
 */
export async function softDeleteItem(db: AppDatabase, id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(items)
      .set({ deletedAt: now, updatedAt: now, version: sql`${items.version} + 1` })
      .where(and(eq(items.id, id), isNull(items.deletedAt)))
      .run();

    if (updated.rowsAffected === 0)
      return;

    // Cascade tuple cleanup (object side; the item is never used as a
    // subject so the subject branch from policy.deleteTuplesForEntity is
    // redundant here). Inlined so the cleanup is part of the same
    // transaction as the deleted_at stamp.
    await tx.delete(relationTuples)
      .where(and(
        eq(relationTuples.namespace, "item"),
        eq(relationTuples.objectId, id),
      ))
      .run();
  });
}

/**
 * Reverse {@link softDeleteItem}.
 *
 * IMPORTANT: owner / participant / policy tuples are NOT auto-restored here.
 * {@link softDeleteItem} deletes every `(item, id, …)` tuple, and this
 * function has no owner/creator context to safely re-issue them. The
 * sub-type / route layer that triggers a restore MUST re-write the
 * appropriate relation tuples (at minimum the `owner` tuple) itself —
 * otherwise the restored item is live but unreachable via policy checks.
 *
 * The update is scoped to soft-deleted rows only: restoring an already-live
 * row is a no-op (no spurious version bump) and returns the existing row.
 */
export async function restoreItem(db: AppDatabase, id: string): Promise<ItemRow | undefined> {
  const now = new Date().toISOString();
  // Scope the write to soft-deleted rows. When the row is already live (or
  // absent) no row matches, so the version is not bumped; we just return the
  // current row (if any) unchanged.
  await db
    .update(items)
    .set({ deletedAt: null, updatedAt: now, version: sql`${items.version} + 1` })
    .where(and(eq(items.id, id), isNotNull(items.deletedAt)))
    .run();

  return await db.select().from(items).where(eq(items.id, id)).get();
}

export interface ListItemsFilter {
  readonly type?: string | undefined;
  readonly status?: string | undefined;
  /** Sub-string match against `items.title` (case-insensitive). FTS is deferred — see plan §G. */
  readonly search?: string | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
}

/**
 * Lists are ordered by `id DESC`. Because `items.id` is a ULID, the
 * monotonic timestamp prefix means this is identical to "newest first"
 * without needing a separate `created_at` column.
 */

/**
 * List live items whose id is in `ids`, with optional sub-type / status /
 * title filters. Sub-types compute the visible id set via
 * `policy.listObjects` (or equivalent) before calling this.
 *
 * Pagination is keyed by `createdAt DESC, id DESC` for stable ordering.
 */
export async function listItemsByIds(
  db: AppDatabase,
  ids: readonly string[],
  filter: ListItemsFilter = {},
): Promise<{ data: readonly ItemRow[]; total: number }> {
  if (ids.length === 0) {
    return { data: [], total: 0 };
  }
  const { type, status, search } = filter;
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));

  const conditions = [inArray(items.id, [...ids]), isNull(items.deletedAt)];
  if (type)
    conditions.push(eq(items.type, type));
  if (status)
    conditions.push(eq(items.status, status));
  if (search && search.length > 0) {
    // TODO(fts): swap LIKE for items_fts MATCH once the FTS5 virtual-table
    // gap is closed (see plan §G "FTS gap"). LIKE on title is fine for the
    // current row count.
    conditions.push(like(items.title, `%${escapeLike(search)}%`));
  }

  const where = and(...conditions);
  const totalRow = await db.select({ value: count() }).from(items).where(where).get();
  const total = totalRow?.value ?? 0;

  const data = await db
    .select()
    .from(items)
    .where(where)
    .orderBy(desc(items.id))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();

  return { data, total };
}

/**
 * Convenience: list live items by type, no permission filter. Mainly
 * useful for admin paths and tests; sub-types listing for end-users
 * should go through {@link listItemsByIds} after resolving the visible
 * id set against `policy`.
 */
export async function listItemsByType(
  db: AppDatabase,
  filter: ListItemsFilter & { type: string },
): Promise<{ data: readonly ItemRow[]; total: number }> {
  const { type, status, search } = filter;
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));

  const conditions = [eq(items.type, type), isNull(items.deletedAt)];
  if (status)
    conditions.push(eq(items.status, status));
  if (search && search.length > 0) {
    conditions.push(like(items.title, `%${escapeLike(search)}%`));
  }

  const where = and(...conditions);
  const totalRow = await db.select({ value: count() }).from(items).where(where).get();
  const total = totalRow?.value ?? 0;

  const data = await db
    .select()
    .from(items)
    .where(where)
    .orderBy(desc(items.id))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();

  return { data, total };
}

/**
 * Resolve a caller-supplied identifier that may be either an internal id
 * or a short id. Sub-types accept both shapes in their route params.
 */
export async function resolveItem(db: AppDatabase, idOrShortId: string): Promise<ItemRow | undefined> {
  return await db
    .select()
    .from(items)
    .where(and(or(eq(items.id, idOrShortId), eq(items.shortId, idOrShortId)), isNull(items.deletedAt)))
    .get();
}

export async function assertItemExists(db: AppDatabase, id: string): Promise<ItemRow> {
  const row = await getItemById(db, id);
  if (!row)
    throw new NotFoundError("Item", id);
  return row;
}

/** Internal: ValidationError builder for the comment validators. */
export function makeCommentValidationError(field: string, message: string): ValidationError {
  return new ValidationError("Invalid comment input", { [field]: message });
}
