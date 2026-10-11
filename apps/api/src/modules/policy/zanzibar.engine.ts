import type { AppDatabase } from "@/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  findDirectMember,
  listAllMembers,
  listGroupIdsForUser,
  listParentGroupsForGroup,
  listUsersetMembers,
} from "@/modules/account/groups/group-members.service";
import { DIRECT_SUBJECT, relationTuples } from "@/modules/policy/schema";
import { getParentRelations, getTupleToUsersetRules } from "./namespace-config";

const MAX_DEPTH = 10;

/**
 * Hard cap on the total number of graph nodes a single top-level resolution
 * (`check` / `expand` / `listUserResources`) may visit, summed across *all* recursion
 * branches. `MAX_DEPTH` only bounds a single path; a wide permission graph can
 * still fan out into an exponential number of paths within that depth. This
 * shared counter bounds the aggregate work and short-circuits a pathological
 * (or maliciously crafted) graph instead of letting it run unbounded.
 *
 * 5000 is far above what any legitimate graph reaches (real resolutions touch
 * a handful to low-hundreds of nodes) while still capping DoS-shaped inputs.
 */
const MAX_NODE_BUDGET = 5000;

/**
 * Mutable budget threaded through every recursion branch of a single
 * resolution. `spend()` returns false once the cap is hit so callers can
 * short-circuit that branch (treated as "not allowed" — fail closed).
 */
interface NodeBudget {
  remaining: number;
}

function makeBudget(): NodeBudget {
  return { remaining: MAX_NODE_BUDGET };
}

function spend(budget: NodeBudget): boolean {
  if (budget.remaining <= 0)
    return false;
  budget.remaining -= 1;
  return true;
}

export interface CheckResult {
  readonly allowed: boolean;
  readonly resolvedThrough: readonly string[];
}

/**
 * Per-resolution state for `check()`. Callers normally pass nothing; the
 * engine fills in fresh recursion state. `groupClosure` is the one
 * caller-facing knob: the full set of group ids the subject belongs to
 * (nested groups already flattened). When supplied, a `group:G#member`
 * userset resolves as a set lookup instead of recursing into the group's
 * membership one group at a time — a request that checks many objects
 * resolves the closure once and reuses it.
 */
export interface CheckOptions {
  readonly depth?: number;
  readonly visited?: Set<string>;
  readonly budget?: NodeBudget;
  readonly groupClosure?: ReadonlySet<string>;
  /**
   * Per-resolution row cache: every tuple on a `(namespace, objectId)` is
   * fetched once and the direct / userset / tuple_to_userset branches for
   * all* relations on that object are answered from memory. The
   * computed_userset ladder (viewer ← editor ← owner) recurses on the same
   * object, so without this each rung re-queried the table.
   */
  readonly objectRows?: Map<string, readonly TupleRow[]>;
}

type TupleRow = typeof relationTuples.$inferSelect;

async function rowsForObject(
  db: AppDatabase,
  namespace: string,
  objectId: string,
  cache: Map<string, readonly TupleRow[]>,
): Promise<readonly TupleRow[]> {
  const key = `${namespace}:${objectId}`;
  const hit = cache.get(key);
  if (hit)
    return hit;
  const rows = await db
    .select()
    .from(relationTuples)
    .where(and(eq(relationTuples.namespace, namespace), eq(relationTuples.objectId, objectId)))
    .all();
  cache.set(key, rows);
  return rows;
}

export interface SubjectNode {
  readonly namespace: string;
  readonly id: string;
  readonly relation?: string;
  readonly children?: readonly SubjectNode[];
}

function formatTuple(ns: string, objId: string, rel: string, subNs: string, subId: string, subRel?: string | null): string {
  const subject = subRel ? `${subNs}:${subId}#${subRel}` : `${subNs}:${subId}`;
  return `${ns}:${objId}#${rel}@${subject}`;
}

function checkKey(ns: string, objId: string, rel: string, subNs: string, subId: string): string {
  return `${ns}:${objId}#${rel}@${subNs}:${subId}`;
}

function expandKey(ns: string, objId: string, rel: string): string {
  return `${ns}:${objId}#${rel}`;
}

/**
 * Group-membership rows for `group:<objectId>#member` live in
 * `account.group_members`, not `relation_tuples`. The engine routes those
 * reads through this branch so a deployment can drop the policy module
 * without losing user-group features.
 */
function isGroupMembership(namespace: string, relation: string): boolean {
  return namespace === "group" && relation === "member";
}

export async function check(
  db: AppDatabase,
  namespace: string,
  objectId: string,
  relation: string,
  subjectNs: string,
  subjectId: string,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const depth = options.depth ?? 0;
  const visited = options.visited ?? new Set<string>();
  const budget = options.budget ?? makeBudget();
  const objectRows = options.objectRows ?? new Map<string, readonly TupleRow[]>();
  const { groupClosure } = options;
  const recurse: CheckOptions = { depth: depth + 1, visited, budget, objectRows, ...(groupClosure && { groupClosure }) };

  if (depth > MAX_DEPTH) {
    return { allowed: false, resolvedThrough: [] };
  }

  // Shared global node budget across all recursion branches — bounds
  // pathological permission-graph fan-out. Fail closed when exhausted.
  if (!spend(budget)) {
    return { allowed: false, resolvedThrough: [] };
  }

  const key = checkKey(namespace, objectId, relation, subjectNs, subjectId);
  if (visited.has(key)) {
    return { allowed: false, resolvedThrough: [] };
  }
  visited.add(key);

  // Group membership lives in its own table; everything else is answered
  // from the object's single row fetch.
  const membership = isGroupMembership(namespace, relation);
  const rows = membership ? [] : await rowsForObject(db, namespace, objectId, objectRows);

  // 1. Direct tuple match (subject_relation is the direct-subject sentinel;
  // group_members keeps NULL for the same meaning)
  const direct = membership
    ? await findDirectMember(db, objectId, subjectNs, subjectId, null)
    : rows.find(r => r.relation === relation && r.subjectNamespace === subjectNs && r.subjectId === subjectId && r.subjectRelation === DIRECT_SUBJECT);

  if (direct) {
    return {
      allowed: true,
      resolvedThrough: [formatTuple(namespace, objectId, relation, subjectNs, subjectId)],
    };
  }

  // 2. Userset indirect match — tuples with subject_relation set.
  const usersetTuples = membership
    ? await listUsersetMembers(db, objectId)
    : rows.filter(r => r.relation === relation && r.subjectRelation !== DIRECT_SUBJECT);

  for (const tuple of usersetTuples) {
    // Membership answered from the supplied closure: no per-group recursion.
    if (groupClosure && isGroupMembership(tuple.subjectNamespace, tuple.subjectRelation!)) {
      if (groupClosure.has(tuple.subjectId)) {
        return {
          allowed: true,
          resolvedThrough: [formatTuple(namespace, objectId, relation, tuple.subjectNamespace, tuple.subjectId, tuple.subjectRelation)],
        };
      }
      continue;
    }

    const innerResult = await check(
      db,
      tuple.subjectNamespace,
      tuple.subjectId,
      tuple.subjectRelation!,
      subjectNs,
      subjectId,
      recurse,
    );
    if (innerResult.allowed) {
      return {
        allowed: true,
        resolvedThrough: [
          formatTuple(namespace, objectId, relation, tuple.subjectNamespace, tuple.subjectId, tuple.subjectRelation),
          ...innerResult.resolvedThrough,
        ],
      };
    }
  }

  // 3. Computed userset — check parent relations
  const parentRelations = getParentRelations(namespace, relation);
  for (const parentRel of parentRelations) {
    const parentResult = await check(db, namespace, objectId, parentRel, subjectNs, subjectId, recurse);
    if (parentResult.allowed) {
      return {
        allowed: true,
        resolvedThrough: parentResult.resolvedThrough,
      };
    }
  }

  // 4. Tuple-to-userset — follow tupleset relation to another object, then check computed_userset there
  const ttuRules = getTupleToUsersetRules(namespace, relation);
  for (const rule of ttuRules) {
    const tuplesetTuples = rows.filter(r => r.relation === rule.tupleset);

    for (const tuple of tuplesetTuples) {
      const innerResult = await check(
        db,
        tuple.subjectNamespace,
        tuple.subjectId,
        rule.computed_userset,
        subjectNs,
        subjectId,
        recurse,
      );
      if (innerResult.allowed) {
        return {
          allowed: true,
          resolvedThrough: [
            formatTuple(namespace, objectId, rule.tupleset, tuple.subjectNamespace, tuple.subjectId, tuple.subjectRelation),
            ...innerResult.resolvedThrough,
          ],
        };
      }
    }
  }

  return { allowed: false, resolvedThrough: [] };
}

export async function expand(
  db: AppDatabase,
  namespace: string,
  objectId: string,
  relation: string,
  depth = 0,
  visited: Set<string> = new Set(),
  budget: NodeBudget = makeBudget(),
): Promise<SubjectNode[]> {
  if (depth > MAX_DEPTH)
    return [];

  // Same shared budget as check(): depth alone does not bound a wide graph,
  // and expand walks every branch rather than short-circuiting on the first
  // hit, so it is the path most exposed to fan-out.
  if (!spend(budget))
    return [];

  const key = expandKey(namespace, objectId, relation);
  if (visited.has(key))
    return [];
  visited.add(key);

  const tuples = isGroupMembership(namespace, relation)
    ? await listAllMembers(db, objectId)
    : await db
        .select()
        .from(relationTuples)
        .where(
          and(
            eq(relationTuples.namespace, namespace),
            eq(relationTuples.objectId, objectId),
            eq(relationTuples.relation, relation),
          ),
        )
        .all();

  const nodes: SubjectNode[] = [];

  for (const tuple of tuples) {
    if (tuple.subjectRelation) {
      const children = await expand(db, tuple.subjectNamespace, tuple.subjectId, tuple.subjectRelation, depth + 1, visited, budget);
      nodes.push({
        namespace: tuple.subjectNamespace,
        id: tuple.subjectId,
        relation: tuple.subjectRelation,
        children,
      });
    }
    else {
      nodes.push({
        namespace: tuple.subjectNamespace,
        id: tuple.subjectId,
      });
    }
  }

  // Expand parent relations (computed_userset)
  const parentRelations = getParentRelations(namespace, relation);
  for (const parentRel of parentRelations) {
    const parentNodes = await expand(db, namespace, objectId, parentRel, depth + 1, visited, budget);
    nodes.push(...parentNodes);
  }

  // Expand tuple_to_userset
  const ttuRules = getTupleToUsersetRules(namespace, relation);
  for (const rule of ttuRules) {
    const tuplesetTuples = await db
      .select()
      .from(relationTuples)
      .where(
        and(
          eq(relationTuples.namespace, namespace),
          eq(relationTuples.objectId, objectId),
          eq(relationTuples.relation, rule.tupleset),
        ),
      )
      .all();

    for (const tuple of tuplesetTuples) {
      const children = await expand(db, tuple.subjectNamespace, tuple.subjectId, rule.computed_userset, depth + 1, visited, budget);
      nodes.push({
        namespace: tuple.subjectNamespace,
        id: tuple.subjectId,
        relation: rule.computed_userset,
        children,
      });
    }
  }

  return nodes;
}

export async function listUserResources(
  db: AppDatabase,
  userId: string,
  namespace: string,
  relation: string,
  budget: NodeBudget = makeBudget(),
  visited: Set<string> = new Set(),
): Promise<readonly string[]> {
  // Shared global budget across the tuple_to_userset recursion below. Fail
  // closed (return what we have) once exhausted. `visited` guards a
  // (namespace, relation) pair from re-entering itself through a
  // cross-namespace tupleset cycle.
  if (!spend(budget))
    return [];
  const selfKey = `${namespace}#${relation}`;
  if (visited.has(selfKey))
    return [];
  visited.add(selfKey);

  const objectIds = new Set<string>();
  const effectiveRelations = collectEffectiveRelations(namespace, relation);

  // 1. Direct user tuples
  const directTuples = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, namespace),
        inArray(relationTuples.relation, effectiveRelations),
        eq(relationTuples.subjectNamespace, "user"),
        eq(relationTuples.subjectId, userId),
        eq(relationTuples.subjectRelation, DIRECT_SUBJECT),
      ),
    )
    .all();

  for (const t of directTuples) {
    objectIds.add(t.objectId);
  }

  // 2. Through groups — recursively resolve all group memberships
  const allGroupIds = await resolveUserGroups(db, userId, budget);

  for (const groupId of allGroupIds) {
    const groupResourceTuples = await db
      .select()
      .from(relationTuples)
      .where(
        and(
          eq(relationTuples.namespace, namespace),
          inArray(relationTuples.relation, effectiveRelations),
          eq(relationTuples.subjectNamespace, "group"),
          eq(relationTuples.subjectId, groupId),
          eq(relationTuples.subjectRelation, "member"),
        ),
      )
      .all();

    for (const t of groupResourceTuples) {
      objectIds.add(t.objectId);
    }
  }

  // 3. Through tuple_to_userset — the reverse of check()'s step 4. A rule
  // `tupleset → computed_userset` means: an object O grants `relation` if
  // some tuple `O#tupleset@S:x` exists and the user holds `computed_userset`
  // on S:x. check() follows each tuple's subjectNamespace at resolve time;
  // here we group the tupleset edges by subject namespace and reverse each
  // group with that namespace's own rules.
  for (const rel of effectiveRelations) {
    for (const rule of getTupleToUsersetRules(namespace, rel)) {
      const subjectNamespaces = await db
        .selectDistinct({ subjectNamespace: relationTuples.subjectNamespace })
        .from(relationTuples)
        .where(and(eq(relationTuples.namespace, namespace), eq(relationTuples.relation, rule.tupleset)))
        .all();

      for (const { subjectNamespace } of subjectNamespaces) {
        if (subjectNamespace === namespace && rule.computed_userset === rel) {
          // Self-referential (item.parent_item): everything found so far is a
          // root; walk the edge downward to a fixpoint. This is the recursive
          // CTE the document module used to own, generalised to any namespace.
          let frontier = [...objectIds];
          while (frontier.length > 0) {
            if (!spend(budget))
              break;
            const children = await db
              .select({ objectId: relationTuples.objectId })
              .from(relationTuples)
              .where(
                and(
                  eq(relationTuples.namespace, namespace),
                  eq(relationTuples.relation, rule.tupleset),
                  eq(relationTuples.subjectNamespace, namespace),
                  inArray(relationTuples.subjectId, frontier),
                ),
              )
              .all();
            frontier = [];
            for (const { objectId } of children) {
              if (!objectIds.has(objectId)) {
                objectIds.add(objectId);
                frontier.push(objectId);
              }
            }
          }
          continue;
        }

        const reachable = await listUserResources(db, userId, subjectNamespace, rule.computed_userset, budget, visited);
        if (reachable.length === 0)
          continue;
        const viaEdge = await db
          .select({ objectId: relationTuples.objectId })
          .from(relationTuples)
          .where(
            and(
              eq(relationTuples.namespace, namespace),
              eq(relationTuples.relation, rule.tupleset),
              eq(relationTuples.subjectNamespace, subjectNamespace),
              inArray(relationTuples.subjectId, [...reachable]),
            ),
          )
          .all();
        for (const { objectId } of viaEdge)
          objectIds.add(objectId);
      }
    }
  }

  return [...objectIds];
}

/**
 * Recursively resolve all groups a user belongs to (handles nested groups).
 * Exported so a request can compute the closure once and hand it to
 * `check()` via `CheckOptions.groupClosure`.
 */
export async function resolveUserGroups(db: AppDatabase, userId: string, budget: NodeBudget = makeBudget()): Promise<readonly string[]> {
  const allGroups = new Set<string>();

  // Direct group memberships
  const directGroupIds = await listGroupIdsForUser(db, userId);

  const queue: string[] = [];
  for (const groupId of directGroupIds) {
    allGroups.add(groupId);
    queue.push(groupId);
  }

  // Resolve nested: groups that include other groups as members
  while (queue.length > 0) {
    if (!spend(budget))
      break;
    const groupId = queue.shift()!;
    const parentIds = await listParentGroupsForGroup(db, groupId);

    for (const parentId of parentIds) {
      if (!allGroups.has(parentId)) {
        allGroups.add(parentId);
        queue.push(parentId);
      }
    }
  }

  return [...allGroups];
}

/**
 * Collect all relations that effectively grant the target relation.
 * e.g. for app:viewer → [viewer, manager, admin]
 */
const MAX_EFFECTIVE_RELATIONS = 50;

function collectEffectiveRelations(namespace: string, relation: string): string[] {
  const result = [relation];
  const visited = new Set<string>([relation]);
  const queue = [relation];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const higherRelations = getParentRelations(namespace, current);
    for (const higher of higherRelations) {
      if (!visited.has(higher)) {
        if (result.length >= MAX_EFFECTIVE_RELATIONS) {
          throw new Error(`Effective relations exceeded limit of ${MAX_EFFECTIVE_RELATIONS} for ${namespace}:${relation}`);
        }
        visited.add(higher);
        result.push(higher);
        queue.push(higher);
      }
    }
  }

  return result;
}
