import type { AppDatabase } from "@/db";
import { and, asc, count, eq, inArray, like, or } from "drizzle-orm";
import {
  listGroupMembershipsForUser,
  listGroupMembershipsForUsers,
  listUserIdsInGroup,
} from "@/modules/account/groups/group-members.service";
import { groups } from "@/modules/account/groups/schema";
import { users } from "@/modules/account/users/schema";

type UserRole = "admin" | "user";
type UserStatus = "active" | "disabled";

const userColumns = {
  id: users.id,
  username: users.username,
  name: users.name,
  email: users.email,
  avatar: users.avatar,
  role: users.role,
  status: users.status,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

interface ListUsersParams {
  readonly q?: string | undefined;
  readonly role?: UserRole | undefined;
  readonly status?: UserStatus | undefined;
  readonly groupId?: string | undefined;
  readonly page: number;
  readonly limit: number;
}

export async function listUsers(db: AppDatabase, params: ListUsersParams) {
  const { q, role, status, groupId, page, limit } = params;
  const offset = (page - 1) * limit;
  const conditions = [];

  if (q) {
    const pattern = `%${q}%`;
    conditions.push(or(like(users.name, pattern), like(users.email, pattern), like(users.username, pattern)));
  }
  if (role) {
    conditions.push(eq(users.role, role));
  }
  if (status) {
    conditions.push(eq(users.status, status));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  if (groupId) {
    const memberIds = await listUserIdsInGroup(db, groupId);
    if (memberIds.length === 0) {
      return { data: [], total: 0, page, limit, totalPages: 0 };
    }

    const groupWhere = where
      ? and(where, inArray(users.id, [...memberIds]))
      : inArray(users.id, [...memberIds]);

    const totalResult = await db
      .select({ count: count() })
      .from(users)
      .where(groupWhere)
      .get();
    const total = totalResult?.count ?? 0;

    const data = await db
      .select(userColumns)
      .from(users)
      .where(groupWhere)
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(limit)
      .offset(offset)
      .all();

    const dataWithGroups = await attachUserGroups(db, data);
    return { data: dataWithGroups, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  const totalResult = await db.select({ count: count() }).from(users).where(where).get();
  const total = totalResult?.count ?? 0;

  const data = await db
    .select(userColumns)
    .from(users)
    .where(where)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(limit)
    .offset(offset)
    .all();

  const dataWithGroups = await attachUserGroups(db, data);
  return { data: dataWithGroups, total, page, limit, totalPages: Math.ceil(total / limit) };
}

async function attachUserGroups<T extends { id: string }>(db: AppDatabase, data: T[]) {
  const userIds = data.map(u => u.id);
  if (userIds.length === 0)
    return data.map(u => ({ ...u, groups: [] as Array<{ id: string; name: string }> }));

  const memberships = await listGroupMembershipsForUsers(db, userIds);
  if (memberships.length === 0)
    return data.map(u => ({ ...u, groups: [] as Array<{ id: string; name: string }> }));

  const groupIds = [...new Set(memberships.map(m => m.groupId))];
  const groupRows = await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(inArray(groups.id, groupIds))
    .all();
  const groupMap = new Map(groupRows.map(g => [g.id, g.name]));

  const groupsByUser = new Map<string, Array<{ id: string; name: string }>>();
  for (const m of memberships) {
    const name = groupMap.get(m.groupId);
    if (!name)
      continue;
    const list = groupsByUser.get(m.userId) ?? [];
    list.push({ id: m.groupId, name });
    groupsByUser.set(m.userId, list);
  }

  return data.map(u => ({ ...u, groups: groupsByUser.get(u.id) ?? [] }));
}

export async function getUserById(db: AppDatabase, id: string) {
  return await db.select(userColumns).from(users).where(eq(users.id, id)).get();
}

export async function updateUser(db: AppDatabase, id: string, data: { role?: UserRole | undefined; status?: UserStatus | undefined }) {
  const now = new Date().toISOString();
  const setData: Record<string, unknown> = { updatedAt: now };
  if (data.role !== undefined)
    setData.role = data.role;
  if (data.status !== undefined)
    setData.status = data.status;
  await db.update(users)
    .set(setData)
    .where(eq(users.id, id))
    .run();
  return await db.select(userColumns).from(users).where(eq(users.id, id)).get();
}

export async function getUserGroups(db: AppDatabase, userId: string) {
  const memberships = await listGroupMembershipsForUser(db, userId);
  if (memberships.length === 0)
    return [];

  const groupIds = memberships.map(m => m.groupId);
  const joinedAtMap = new Map(memberships.map(m => [m.groupId, m.joinedAt]));

  const groupRows = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      createdAt: groups.createdAt,
    })
    .from(groups)
    .where(inArray(groups.id, groupIds))
    .all();

  return groupRows.map(g => ({
    ...g,
    joinedAt: joinedAtMap.get(g.id) ?? "",
  }));
}

export async function listActiveUsers(db: AppDatabase) {
  return await db
    .select({ id: users.id, name: users.name, username: users.username })
    .from(users)
    .where(eq(users.status, "active"))
    .orderBy(users.name)
    .all();
}
