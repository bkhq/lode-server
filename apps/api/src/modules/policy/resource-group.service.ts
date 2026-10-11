import type { AppDatabase } from "@/db";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { DIRECT_SUBJECT, relationTuples, resourceGroups } from "@/modules/policy/schema";
import { isUniqueViolation, NotFoundError, ValidationError } from "@/shared/lib/errors";
import { getAllNamespaces } from "./namespace-config";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

function duplicateName(): ValidationError {
  return new ValidationError("Duplicate resource group", { name: "A resource group with this name already exists" });
}

export interface ResourceGroup {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
}

export interface ResourceGroupMember {
  readonly tupleId: string;
  readonly namespace: string;
  readonly objectId: string;
}

/**
 * Resource groups are rows in `resource_groups`; only their edges live in
 * relation_tuples.
 *
 * - Group identity:  resource_groups (id, name, description)
 * - Group members:   <resource-ns>:<resource-id>#parent@resource_group:<groupId>
 * - Access grants:   resource_group:<groupId>#<relation>@<subject>
 *
 * Member namespaces must be registered via `registerNamespace`. In this template the
 * default registry only ships the `user`, `group`, and `resource_group`
 * namespaces — register your own resource namespaces to make them groupable.
 */

export async function createResourceGroup(
  db: AppDatabase,
  input: { readonly name: string; readonly description?: string | null },
  createdBy: string,
): Promise<ResourceGroup> {
  if (!input.name.trim()) {
    throw new ValidationError("Name is required", { name: "Name cannot be empty" });
  }

  const id = nanoid();
  const now = new Date().toISOString();
  const name = input.name.trim();
  const description = input.description?.trim() || null;

  // idx_resource_groups_name is the duplicate-name guard; surface the
  // constraint as the same 422 callers always got.
  try {
    await db.insert(resourceGroups).values({ id, name, description, createdBy, createdAt: now }).run();
  }
  catch (err) {
    throw isUniqueViolation(err) ? duplicateName() : err;
  }

  return { id, name, description, createdAt: now };
}

export async function updateResourceGroup(
  db: AppDatabase,
  id: string,
  input: { readonly name: string; readonly description?: string | null },
): Promise<ResourceGroup> {
  if (!input.name.trim()) {
    throw new ValidationError("Name is required", { name: "Name cannot be empty" });
  }

  const name = input.name.trim();
  const description = input.description?.trim() || null;

  const row = await db.select().from(resourceGroups).where(eq(resourceGroups.id, id)).get();
  if (!row)
    throw new NotFoundError("ResourceGroup", id);

  try {
    await db.update(resourceGroups).set({ name, description }).where(eq(resourceGroups.id, id)).run();
  }
  catch (err) {
    throw isUniqueViolation(err) ? duplicateName() : err;
  }

  return { id, name, description, createdAt: row.createdAt };
}

export async function deleteResourceGroup(db: AppDatabase, id: string): Promise<boolean> {
  const row = await db.select({ id: resourceGroups.id }).from(resourceGroups).where(eq(resourceGroups.id, id)).get();
  if (!row)
    return false;

  await db.transaction(async (tx) => {
    await tx.delete(resourceGroups).where(eq(resourceGroups.id, id)).run();

    // Delete all member tuples (<resource>:<id>#parent@resource_group:<id>)
    await tx.delete(relationTuples).where(
      and(
        eq(relationTuples.relation, "parent"),
        eq(relationTuples.subjectNamespace, "resource_group"),
        eq(relationTuples.subjectId, id),
      ),
    ).run();

    // Delete all access tuples on this resource group
    await tx.delete(relationTuples).where(
      and(
        eq(relationTuples.namespace, "resource_group"),
        eq(relationTuples.objectId, id),
      ),
    ).run();
  });

  return true;
}

export async function listResourceGroups(db: AppDatabase): Promise<readonly ResourceGroup[]> {
  const rows = await db.select().from(resourceGroups).all();
  return rows.map(r => ({ id: r.id, name: r.name, description: r.description, createdAt: r.createdAt }));
}

export async function getResourceGroupMembers(db: AppDatabase, groupId: string): Promise<readonly ResourceGroupMember[]> {
  const tuples = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.relation, "parent"),
        eq(relationTuples.subjectNamespace, "resource_group"),
        eq(relationTuples.subjectId, groupId),
      ),
    )
    .all();

  return tuples.map(t => ({
    tupleId: t.id,
    namespace: t.namespace,
    objectId: t.objectId,
  }));
}

export async function addResourceGroupMember(
  db: AppDatabase,
  groupId: string,
  memberNamespace: string,
  memberId: string,
  createdBy: string,
): Promise<ResourceGroupMember> {
  const reserved = new Set(["user", "group", "resource_group"]);
  const validNamespaces = [...getAllNamespaces().keys()].filter(n => !reserved.has(n));
  if (!validNamespaces.includes(memberNamespace)) {
    throw new ValidationError("Invalid member namespace", {
      namespace: validNamespaces.length
        ? `Must be one of: ${validNamespaces.join(", ")}`
        : "No resource namespaces registered. Register them with registerNamespace().",
    });
  }

  const group = await db.select({ id: resourceGroups.id }).from(resourceGroups).where(eq(resourceGroups.id, groupId)).get();
  if (!group)
    throw new NotFoundError("ResourceGroup", groupId);

  // Check duplicate
  const existing = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.namespace, memberNamespace),
        eq(relationTuples.objectId, memberId),
        eq(relationTuples.relation, "parent"),
        eq(relationTuples.subjectNamespace, "resource_group"),
        eq(relationTuples.subjectId, groupId),
      ),
    )
    .get();

  if (existing) {
    throw new ValidationError("Duplicate member", { member: "This resource is already a member of this group" });
  }

  const tupleId = nanoid();
  const now = new Date().toISOString();

  await db.insert(relationTuples).values({
    id: tupleId,
    namespace: memberNamespace,
    objectId: memberId,
    relation: "parent",
    subjectNamespace: "resource_group",
    subjectId: groupId,
    subjectRelation: DIRECT_SUBJECT,
    createdBy,
    createdAt: now,
  }).run();

  return { tupleId, namespace: memberNamespace, objectId: memberId };
}

export async function removeResourceGroupMember(db: AppDatabase, tupleId: string): Promise<boolean> {
  const existing = await db
    .select()
    .from(relationTuples)
    .where(
      and(
        eq(relationTuples.id, tupleId),
        eq(relationTuples.relation, "parent"),
      ),
    )
    .get();

  if (!existing)
    return false;

  await db.delete(relationTuples).where(eq(relationTuples.id, tupleId)).run();
  return true;
}
