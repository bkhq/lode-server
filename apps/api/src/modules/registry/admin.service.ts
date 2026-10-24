import type { RegistryNamespace, RegistryPackage } from "./access";
import type { AppDatabase } from "@/db";
import { asc, eq } from "drizzle-orm";
import { users } from "@/modules/account/users/schema";
import { findNamespaceBySlug } from "./access";
import { getStorageByPackage } from "./registry.service";
import { registryNamespaces, registryPackages, registryQuotas } from "./schema";

export interface Owner {
  readonly id: string;
  readonly username: string;
  readonly name: string;
}

const ownerColumns = { id: users.id, username: users.username, name: users.name };

export interface AdminPackage {
  readonly namespace: RegistryNamespace;
  readonly package: RegistryPackage;
  readonly owner: Owner;
  readonly storageBytes: number;
}

/** Every package on the platform with its owner and the bytes it holds. */
export async function listAllPackages(db: AppDatabase): Promise<AdminPackage[]> {
  const rows = await db
    .select({ namespace: registryNamespaces, package: registryPackages, owner: ownerColumns })
    .from(registryPackages)
    .innerJoin(registryNamespaces, eq(registryNamespaces.id, registryPackages.namespaceId))
    .innerJoin(users, eq(users.id, registryNamespaces.ownerUserId))
    .orderBy(asc(registryNamespaces.slug), asc(registryPackages.slug))
    .all();
  const storage = await getStorageByPackage(db);
  return rows.map(row => ({ ...row, storageBytes: storage.get(row.package.id) ?? 0 }));
}

export interface AdminNamespace {
  readonly namespace: RegistryNamespace;
  readonly owner: Owner;
  readonly packages: number;
  readonly storageBytes: number;
}

/** Every namespace with its owner, package count and the bytes its packages hold. */
export async function listAllNamespaces(db: AppDatabase): Promise<AdminNamespace[]> {
  const rows = await db
    .select({ namespace: registryNamespaces, owner: ownerColumns })
    .from(registryNamespaces)
    .innerJoin(users, eq(users.id, registryNamespaces.ownerUserId))
    .orderBy(asc(registryNamespaces.slug))
    .all();
  const packages = await listAllPackages(db);
  return rows.map((row) => {
    const own = packages.filter(p => p.namespace.id === row.namespace.id);
    return {
      ...row,
      packages: own.length,
      storageBytes: own.reduce((total, p) => total + p.storageBytes, 0),
    };
  });
}

/**
 * Suspend or restore a namespace. `changed` is false when it already had
 * that status; undefined when there is no such namespace.
 */
export async function setNamespaceStatus(
  db: AppDatabase,
  slug: string,
  status: RegistryNamespace["status"],
): Promise<{ namespace: RegistryNamespace; changed: boolean } | undefined> {
  const namespace = await findNamespaceBySlug(db, slug);
  if (!namespace)
    return undefined;
  if (namespace.status === status)
    return { namespace, changed: false };
  await db.update(registryNamespaces).set({ status }).where(eq(registryNamespaces.id, namespace.id)).run();
  return {
    namespace: { ...namespace, status },
    changed: true,
  };
}

export interface QuotaOverride {
  readonly maxPackages: number | null;
  readonly maxStorageBytes: number | null;
  readonly maxAssetBytes: number | null;
}

export async function getQuotaOverride(db: AppDatabase, userId: string): Promise<QuotaOverride> {
  const row = await db.select().from(registryQuotas).where(eq(registryQuotas.userId, userId)).get();
  return { maxPackages: row?.maxPackages ?? null, maxStorageBytes: row?.maxStorageBytes ?? null, maxAssetBytes: row?.maxAssetBytes ?? null };
}

/** Replace a user's override. All nulls removes the row, leaving the platform defaults. */
export async function setQuotaOverride(db: AppDatabase, userId: string, override: QuotaOverride): Promise<void> {
  if (override.maxPackages === null && override.maxStorageBytes === null && override.maxAssetBytes === null) {
    await db.delete(registryQuotas).where(eq(registryQuotas.userId, userId)).run();
    return;
  }
  await db.insert(registryQuotas).values({ userId, ...override }).onConflictDoUpdate({ target: registryQuotas.userId, set: override }).run();
}
