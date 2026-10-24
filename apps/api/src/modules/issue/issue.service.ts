import type { AppDatabase } from "@/db";
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { users } from "@/modules/account/users/schema";
import { issueDetails } from "@/modules/issue/schema";
import { insertItem } from "@/modules/item/item.service";
import { items } from "@/modules/item/schema";
import { DIRECT_SUBJECT, relationTuples } from "@/modules/policy/schema";
import { check, listUserResources } from "@/modules/policy/zanzibar.engine";
import { nanoid, ulid, ulidTimestamp } from "@/shared/lib/id";
import { escapeLike, likeEscaped } from "@/shared/lib/like";

export type IssueStatus = "open" | "in_progress" | "done" | "cancelled";
export type IssuePriority = "low" | "medium" | "high" | "urgent";

/** Composite view returned by routes and tests. */
export interface IssueRow {
  readonly id: string; // short_id (8-char nanoid)
  readonly title: string;
  readonly description: string | null;
  readonly status: IssueStatus;
  readonly priority: IssuePriority;
  readonly creatorId: string;
  readonly assigneeId: string | null;
  readonly dueDate: string | null;
  readonly createdAt: string; // decoded from items.id (ULID timestamp prefix)
  readonly updatedAt: string;
  readonly version: number;
}

async function getAssigneeId(db: AppDatabase, itemId: string): Promise<string | null> {
  const row = await db.select({ subjectId: relationTuples.subjectId })
    .from(relationTuples)
    .where(and(
      eq(relationTuples.namespace, "item"),
      eq(relationTuples.objectId, itemId),
      eq(relationTuples.relation, "assignee"),
      eq(relationTuples.subjectNamespace, "user"),
    ))
    .get();
  return row?.subjectId ?? null;
}

async function composeIssue(
  db: AppDatabase,
  item: typeof items.$inferSelect,
  details?: typeof issueDetails.$inferSelect | undefined,
): Promise<IssueRow> {
  const d = details ?? await db.select().from(issueDetails).where(eq(issueDetails.itemId, item.id)).get();
  const assigneeId = await getAssigneeId(db, item.id);
  return {
    id: item.shortId,
    title: item.title,
    description: d?.description ?? null,
    status: item.status as IssueStatus,
    priority: (d?.priority ?? "medium") as IssuePriority,
    creatorId: item.creatorId,
    assigneeId,
    dueDate: d?.dueDate ?? null,
    createdAt: ulidTimestamp(item.id),
    updatedAt: item.updatedAt,
    version: item.version,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────

export interface CreateIssueInput {
  readonly title: string;
  readonly description?: string | undefined;
  readonly status?: IssueStatus | undefined;
  readonly priority?: IssuePriority | undefined;
  readonly creatorId: string;
  readonly assigneeId?: string | undefined;
  readonly dueDate?: string | undefined;
}

export async function createIssue(db: AppDatabase, input: CreateIssueInput): Promise<IssueRow> {
  const id = ulid();
  const shortId = nanoid();
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await insertItem(tx, {
      id,
      shortId,
      type: "issue",
      title: input.title,
      status: input.status ?? "open",
      creatorId: input.creatorId,
      now,
    });

    await tx.insert(issueDetails).values({
      itemId: id,
      description: input.description ?? null,
      priority: input.priority ?? "medium",
      dueDate: input.dueDate ?? null,
    }).run();

    if (input.assigneeId) {
      await tx.insert(relationTuples).values({
        id: nanoid(),
        namespace: "item",
        objectId: id,
        relation: "assignee",
        subjectNamespace: "user",
        subjectId: input.assigneeId,
        subjectRelation: DIRECT_SUBJECT,
        createdBy: input.creatorId,
        createdAt: now,
      }).run();
    }
  });

  const item = (await db.select().from(items).where(eq(items.id, id)).get())!;
  return await composeIssue(db, item);
}

export async function getIssueByShortId(db: AppDatabase, shortId: string): Promise<IssueRow | undefined> {
  const item = await db.select().from(items).where(
    and(eq(items.shortId, shortId), eq(items.type, "issue"), isNull(items.deletedAt)),
  ).get();
  if (!item)
    return undefined;
  return await composeIssue(db, item);
}

export interface UpdateIssueInput {
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly status?: IssueStatus | undefined;
  readonly priority?: IssuePriority | undefined;
  readonly assigneeId?: string | null | undefined;
  readonly dueDate?: string | null | undefined;
}

export async function updateIssue(db: AppDatabase, shortId: string, input: UpdateIssueInput): Promise<IssueRow | undefined> {
  const item = await db.select().from(items).where(
    and(eq(items.shortId, shortId), eq(items.type, "issue"), isNull(items.deletedAt)),
  ).get();
  if (!item)
    return undefined;

  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    const itemPatch: Record<string, unknown> = { updatedAt: now, version: sql`${items.version} + 1` };
    if (input.title !== undefined)
      itemPatch.title = input.title;
    if (input.status !== undefined)
      itemPatch.status = input.status;
    await tx.update(items).set(itemPatch).where(eq(items.id, item.id)).run();

    const detailsPatch: Record<string, unknown> = {};
    if (input.description !== undefined)
      detailsPatch.description = input.description;
    if (input.priority !== undefined)
      detailsPatch.priority = input.priority;
    if (input.dueDate !== undefined)
      detailsPatch.dueDate = input.dueDate;
    if (Object.keys(detailsPatch).length > 0) {
      await tx.update(issueDetails).set(detailsPatch).where(eq(issueDetails.itemId, item.id)).run();
    }

    if (input.assigneeId !== undefined) {
      // Replace any existing assignee tuple. Even if input is null we drop
      // the prior tuple — the canonical "no assignee" state is "no tuple".
      await tx.delete(relationTuples).where(and(
        eq(relationTuples.namespace, "item"),
        eq(relationTuples.objectId, item.id),
        eq(relationTuples.relation, "assignee"),
      )).run();
      if (input.assigneeId !== null) {
        await tx.insert(relationTuples).values({
          id: nanoid(),
          namespace: "item",
          objectId: item.id,
          relation: "assignee",
          subjectNamespace: "user",
          subjectId: input.assigneeId,
          subjectRelation: DIRECT_SUBJECT,
          createdBy: item.creatorId,
          createdAt: now,
        }).run();
      }
    }
  });

  const refreshed = await db.select().from(items).where(eq(items.id, item.id)).get();
  if (!refreshed)
    return undefined;
  return await composeIssue(db, refreshed);
}

export async function softDeleteIssue(db: AppDatabase, shortId: string): Promise<void> {
  const item = await db.select().from(items).where(
    and(eq(items.shortId, shortId), eq(items.type, "issue")),
  ).get();
  if (!item)
    return;
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.update(items)
      .set({ deletedAt: now, updatedAt: now, version: sql`${items.version} + 1` })
      .where(and(eq(items.id, item.id), isNull(items.deletedAt)))
      .run();
    await tx.delete(relationTuples).where(and(
      eq(relationTuples.namespace, "item"),
      eq(relationTuples.objectId, item.id),
    )).run();
  });
}

// ─── List ─────────────────────────────────────────────────────────────

export interface ListIssueParams {
  readonly q?: string | undefined;
  readonly status?: string | undefined;
  readonly priority?: string | undefined;
  readonly assigneeId?: string | undefined;
  readonly creatorId?: string | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
}

async function buildIssueConditions(params: ListIssueParams) {
  const conditions = [
    eq(items.type, "issue"),
    isNull(items.deletedAt),
  ];
  if (params.status && params.status !== "__all__")
    conditions.push(eq(items.status, params.status));
  if (params.creatorId)
    conditions.push(eq(items.creatorId, params.creatorId));
  if (params.q)
    conditions.push(likeEscaped(items.title, `%${escapeLike(params.q)}%`));
  return conditions;
}

async function paginateIssues(
  db: AppDatabase,
  baseConditions: readonly ReturnType<typeof eq>[],
  params: ListIssueParams,
) {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));

  // priority + assignee filters need joins / tuple lookups. We build the
  // candidate id set in stages so the final SELECT is a simple in-list.
  let where = and(...baseConditions);

  if (params.priority && params.priority !== "__all__") {
    const ids = await db.select({ itemId: issueDetails.itemId })
      .from(issueDetails)
      .where(eq(issueDetails.priority, params.priority as IssuePriority))
      .all();
    if (ids.length === 0)
      return { data: [] as IssueRow[], total: 0 };
    where = and(where, inArray(items.id, ids.map(r => r.itemId)));
  }

  if (params.assigneeId) {
    const ids = await db.select({ objectId: relationTuples.objectId })
      .from(relationTuples)
      .where(and(
        eq(relationTuples.namespace, "item"),
        eq(relationTuples.relation, "assignee"),
        eq(relationTuples.subjectNamespace, "user"),
        eq(relationTuples.subjectId, params.assigneeId),
      ))
      .all();
    if (ids.length === 0)
      return { data: [] as IssueRow[], total: 0 };
    where = and(where, inArray(items.id, ids.map(r => r.objectId)));
  }

  const totalRow = await db.select({
    value: count(),
  }).from(items).where(where).get();
  const total = totalRow?.value ?? 0;

  const rows = await db.select().from(items).where(where).orderBy(desc(items.id)).limit(limit).offset((page - 1) * limit).all();

  const data: IssueRow[] = [];
  for (const r of rows)
    data.push(await composeIssue(db, r));
  return { data, total };
}

export async function listIssues(db: AppDatabase, params: ListIssueParams = {}) {
  const conditions = await buildIssueConditions(params);
  return await paginateIssues(db, conditions, params);
}

export async function listMyIssues(db: AppDatabase, params: ListIssueParams & { userId: string }) {
  // "Mine" = creator OR assignee. Resolve the user-side tuple set first,
  // then OR with creator_id in the items query.
  const assigneeIds = await listUserResources(db, params.userId, "item", "assignee");
  const creatorClause = eq(items.creatorId, params.userId);

  const conditions = await buildIssueConditions(params);
  const baseAnd = and(...conditions);
  const where = assigneeIds.length > 0
    ? and(baseAnd, or(creatorClause, inArray(items.id, [...assigneeIds])))
    : and(baseAnd, creatorClause);

  // Reuse paginate with an explicit override of "where" via baseConditions.
  // Cheaper: inline the count + select here.
  const finalWhere = where;
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 20));

  let working = finalWhere;
  if (params.priority && params.priority !== "__all__") {
    const ids = await db.select({ itemId: issueDetails.itemId })
      .from(issueDetails)
      .where(eq(issueDetails.priority, params.priority as IssuePriority))
      .all();
    if (ids.length === 0)
      return { data: [] as IssueRow[], total: 0 };
    working = and(working, inArray(items.id, ids.map(r => r.itemId)));
  }

  const totalRow = await db.select({
    value: count(),
  }).from(items).where(working).get();
  const total = totalRow?.value ?? 0;
  const rows = await db.select().from(items).where(working).orderBy(desc(items.id)).limit(limit).offset((page - 1) * limit).all();
  const data: IssueRow[] = [];
  for (const r of rows)
    data.push(await composeIssue(db, r));
  return { data, total };
}

// ─── Access helper ────────────────────────────────────────────────────

/**
 * Resolve the actor's relations against the issue's item. Returns the
 * set of role flags the route handlers use to decide visibility / edit
 * rights. Admin bypass is owned by the caller (route layer).
 */
export interface IssueAccess {
  readonly isCreator: boolean;
  readonly isAssignee: boolean;
  readonly canRead: boolean;
  readonly canEdit: boolean;
}

export async function resolveAccess(
  db: AppDatabase,
  item: typeof items.$inferSelect,
  userId: string,
): Promise<IssueAccess> {
  const isCreator = item.creatorId === userId;
  // The policy engine walks the assignee → owner implication automatically,
  // but the route layer needs an explicit "you are the assignee" signal for
  // the existing "assignees can only update status" rule.
  const assignedTuple = await db.select({ id: relationTuples.id })
    .from(relationTuples)
    .where(and(
      eq(relationTuples.namespace, "item"),
      eq(relationTuples.objectId, item.id),
      eq(relationTuples.relation, "assignee"),
      eq(relationTuples.subjectNamespace, "user"),
      eq(relationTuples.subjectId, userId),
    ))
    .get();
  const isAssignee = !!assignedTuple;
  const view = await check(db, "item", item.id, "viewer", "user", userId);
  const edit = await check(db, "item", item.id, "editor", "user", userId);
  return {
    isCreator,
    isAssignee,
    canRead: view.allowed,
    canEdit: edit.allowed,
  };
}

export async function getUserById(db: AppDatabase, id: string) {
  return await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, id)).get();
}

/**
 * Resolve the underlying `items` row by short_id. Routes that need to
 * touch comments / attachments translate `:id` → items.id via this.
 */
export async function resolveIssueItem(db: AppDatabase, shortId: string) {
  return await db.select().from(items).where(
    and(eq(items.shortId, shortId), eq(items.type, "issue"), isNull(items.deletedAt)),
  ).get();
}
