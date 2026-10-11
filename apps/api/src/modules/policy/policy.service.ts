import type { AppDatabase } from "@/db";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { DIRECT_SUBJECT, relationTuples } from "@/modules/policy/schema";
import { isUniqueViolation, ValidationError } from "@/shared/lib/errors";
import { getNamespace, getValidRelations } from "./namespace-config";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

export interface CreateTupleInput {
  readonly namespace: string;
  readonly objectId: string;
  readonly relation: string;
  readonly subjectNamespace: string;
  readonly subjectId: string;
  readonly subjectRelation?: string | null | undefined;
}

export interface TupleFilter {
  readonly namespace?: string | undefined;
  readonly objectId?: string | undefined;
  readonly relation?: string | undefined;
  readonly subjectNamespace?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
}

type RelationTupleRow = typeof relationTuples.$inferSelect;

/** What callers see: a direct subject reads as `subjectRelation: null`. */
export type RelationTuple = Omit<RelationTupleRow, "subjectRelation"> & { readonly subjectRelation: string | null };

/** Storage keeps the `""` sentinel (so idx_tuples_unique can enforce it); the API edge keeps `null`. */
function toApiTuple(row: RelationTupleRow): RelationTuple {
  return { ...row, subjectRelation: row.subjectRelation === DIRECT_SUBJECT ? null : row.subjectRelation };
}

function duplicateTuple(): ValidationError {
  return new ValidationError("Duplicate tuple", { tuple: "A relation tuple with the same key already exists" });
}

function validateTupleInput(input: CreateTupleInput): void {
  const ns = getNamespace(input.namespace);
  if (!ns) {
    throw new ValidationError("Invalid namespace", { namespace: `Unknown namespace: ${input.namespace}` });
  }

  if (input.namespace !== "user") {
    const validRelations = getValidRelations(input.namespace);
    if (validRelations.length > 0 && !validRelations.includes(input.relation)) {
      throw new ValidationError("Invalid relation", {
        relation: `Invalid relation '${input.relation}' for namespace '${input.namespace}'. Valid: ${validRelations.join(", ")}`,
      });
    }
  }

  const subjectNs = getNamespace(input.subjectNamespace);
  if (!subjectNs) {
    throw new ValidationError("Invalid subject namespace", { subjectNamespace: `Unknown namespace: ${input.subjectNamespace}` });
  }

  if (input.subjectRelation) {
    const subjectRelations = getValidRelations(input.subjectNamespace);
    if (subjectRelations.length > 0 && !subjectRelations.includes(input.subjectRelation)) {
      throw new ValidationError("Invalid subject relation", {
        subjectRelation: `Invalid relation '${input.subjectRelation}' for namespace '${input.subjectNamespace}'`,
      });
    }
  }
}

export async function getTupleById(db: AppDatabase, id: string): Promise<RelationTuple | undefined> {
  const row = await db.select().from(relationTuples).where(eq(relationTuples.id, id)).get();
  return row && toApiTuple(row);
}

export async function createTuple(db: AppDatabase, input: CreateTupleInput, createdBy: string): Promise<RelationTuple> {
  validateTupleInput(input);

  const id = nanoid();
  const now = new Date().toISOString();
  const values = {
    id,
    namespace: input.namespace,
    objectId: input.objectId,
    relation: input.relation,
    subjectNamespace: input.subjectNamespace,
    subjectId: input.subjectId,
    subjectRelation: input.subjectRelation ?? DIRECT_SUBJECT,
    createdBy,
    createdAt: now,
  };

  // idx_tuples_unique is the whole duplicate guard now that a direct subject
  // is stored as "" rather than NULL.
  try {
    await db.insert(relationTuples).values(values).run();
  }
  catch (err) {
    throw isUniqueViolation(err) ? duplicateTuple() : err;
  }

  return toApiTuple(values);
}

/**
 * Rewrite a tuple's relation. Validation runs before anything is touched,
 * and the delete + insert share one BEGIN IMMEDIATE transaction, so a
 * rejected relation (unknown for the namespace, or colliding with an
 * existing row) leaves the original tuple in place instead of silently
 * revoking it. Returns undefined when `id` does not exist.
 */
export async function updateTupleRelation(db: AppDatabase, id: string, relation: string, createdBy: string): Promise<RelationTuple | undefined> {
  const existing = await getTupleById(db, id);
  if (!existing)
    return undefined;

  const input: CreateTupleInput = {
    namespace: existing.namespace,
    objectId: existing.objectId,
    relation,
    subjectNamespace: existing.subjectNamespace,
    subjectId: existing.subjectId,
    subjectRelation: existing.subjectRelation,
  };
  validateTupleInput(input);

  const values = {
    id: nanoid(),
    namespace: input.namespace,
    objectId: input.objectId,
    relation: input.relation,
    subjectNamespace: input.subjectNamespace,
    subjectId: input.subjectId,
    subjectRelation: existing.subjectRelation ?? DIRECT_SUBJECT,
    createdBy,
    createdAt: new Date().toISOString(),
  };

  try {
    await db.transaction(async (tx) => {
      // Delete first so rewriting to the same relation is not a self-collision;
      // a real collision trips idx_tuples_unique and rolls the delete back.
      await tx.delete(relationTuples).where(eq(relationTuples.id, id)).run();
      await tx.insert(relationTuples).values(values).run();
    });
  }
  catch (err) {
    throw isUniqueViolation(err) ? duplicateTuple() : err;
  }

  return toApiTuple(values);
}

export async function deleteTuple(db: AppDatabase, id: string): Promise<boolean> {
  const existing = await db.select({ id: relationTuples.id }).from(relationTuples).where(eq(relationTuples.id, id)).get();
  if (!existing)
    return false;
  await db.delete(relationTuples).where(eq(relationTuples.id, id)).run();
  return true;
}

/**
 * Delete a single tuple identified by its composite key
 * (namespace, objectId, relation, subjectNamespace, subjectId, subjectRelation).
 * Returns true if a row was removed, false if no matching tuple existed.
 * Used by the action-based permission wrapper to revoke a specific grant
 * without the caller having to remember the tuple id.
 */
export async function deleteTupleByKey(
  db: AppDatabase,
  key: {
    readonly namespace: string;
    readonly objectId: string;
    readonly relation: string;
    readonly subjectNamespace: string;
    readonly subjectId: string;
    readonly subjectRelation?: string | null | undefined;
  },
): Promise<boolean> {
  const subjectRelationCondition = eq(relationTuples.subjectRelation, key.subjectRelation ?? DIRECT_SUBJECT);

  const existing = await db
    .select({ id: relationTuples.id })
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, key.namespace),
        eq(relationTuples.objectId, key.objectId),
        eq(relationTuples.relation, key.relation),
        eq(relationTuples.subjectNamespace, key.subjectNamespace),
        eq(relationTuples.subjectId, key.subjectId),
        subjectRelationCondition,
      ),
    )
    .get();

  if (!existing)
    return false;
  await db.delete(relationTuples).where(eq(relationTuples.id, existing.id)).run();
  return true;
}

export async function batchCreateTuples(db: AppDatabase, inputs: readonly CreateTupleInput[], createdBy: string): Promise<readonly RelationTuple[]> {
  // idx_tuples_unique would reject a repeated input too, but only after the
  // transaction has started; a pre-check turns it into a clean 422 before
  // anything is written.
  const seen = new Set<string>();
  for (const input of inputs) {
    validateTupleInput(input);
    const key = `${input.namespace}:${input.objectId}#${input.relation}@${input.subjectNamespace}:${input.subjectId}#${input.subjectRelation ?? ""}`;
    if (seen.has(key)) {
      throw new ValidationError("Duplicate tuple", {
        tuple: "The batch contains the same relation tuple more than once",
      });
    }
    seen.add(key);
  }

  const now = new Date().toISOString();
  const tuples: RelationTupleRow[] = [];

  try {
    await db.transaction(async (tx) => {
      for (const input of inputs) {
        const id = nanoid();
        const values = {
          id,
          namespace: input.namespace,
          objectId: input.objectId,
          relation: input.relation,
          subjectNamespace: input.subjectNamespace,
          subjectId: input.subjectId,
          subjectRelation: input.subjectRelation ?? DIRECT_SUBJECT,
          createdBy,
          createdAt: now,
        };
        await tx.insert(relationTuples).values(values).run();
        tuples.push(values);
      }
    });
  }
  catch (err) {
    throw isUniqueViolation(err) ? duplicateTuple() : err;
  }
  return tuples.map(toApiTuple);
}

export async function batchDeleteTuples(db: AppDatabase, ids: readonly string[]): Promise<number> {
  if (ids.length === 0)
    return 0;
  // Single transactional DELETE … RETURNING avoids N round-trips and the
  // per-row existence pre-check the previous loop performed.
  const removed = await db.transaction(async (tx) => {
    return await tx
      .delete(relationTuples)
      .where(inArray(relationTuples.id, [...ids]))
      .returning({ id: relationTuples.id });
  });
  return removed.length;
}

export async function listTuples(db: AppDatabase, filter: TupleFilter): Promise<{ data: readonly RelationTuple[]; total: number }> {
  const conditions = [];

  if (filter.namespace)
    conditions.push(eq(relationTuples.namespace, filter.namespace));
  if (filter.objectId)
    conditions.push(eq(relationTuples.objectId, filter.objectId));
  if (filter.relation)
    conditions.push(eq(relationTuples.relation, filter.relation));
  if (filter.subjectNamespace)
    conditions.push(eq(relationTuples.subjectNamespace, filter.subjectNamespace));
  if (filter.subjectId)
    conditions.push(eq(relationTuples.subjectId, filter.subjectId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(relationTuples)
    .where(where)
    .get();

  const total = countResult?.count ?? 0;
  const page = filter.page ?? 1;
  const limit = Math.min(filter.limit ?? 50, 100);
  const offset = (page - 1) * limit;

  const data = await db
    .select()
    .from(relationTuples)
    .where(where)
    .limit(limit)
    .offset(offset)
    .all();

  return { data, total };
}

export async function getTuplesByObject(db: AppDatabase, namespace: string, objectId: string): Promise<readonly RelationTuple[]> {
  return (await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, namespace),
        eq(relationTuples.objectId, objectId),
      ),
    )
    .all()).map(toApiTuple);
}

export async function getTuplesBySubject(db: AppDatabase, subjectNamespace: string, subjectId: string): Promise<readonly RelationTuple[]> {
  return (await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.subjectNamespace, subjectNamespace),
        eq(relationTuples.subjectId, subjectId),
      ),
    )
    .all()).map(toApiTuple);
}

/**
 * Cross-module helper: delete every tuple that references the given namespace
 * + id, either as object or subject. Used to cascade tuple cleanup when an
 * external module (document, item, …) deletes its underlying entity.
 *
 * Note: `group:<id>#member@…` rows live in `account.group_members`, not here —
 * `groups.service.deleteGroup` cleans those separately before calling this.
 */
export async function deleteTuplesForEntity(
  db: AppDatabase,
  namespace: string,
  id: string,
): Promise<void> {
  await db.delete(relationTuples)
    .where(
      or(
        and(eq(relationTuples.namespace, namespace), eq(relationTuples.objectId, id)),
        and(eq(relationTuples.subjectNamespace, namespace), eq(relationTuples.subjectId, id)),
      ),
    )
    .run();
}
