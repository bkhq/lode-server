import type { GrantLevel } from "./access";
import type { AppDatabase } from "@/db";
import type { PolicyContext } from "@/modules/policy";
import { asc, eq, inArray } from "drizzle-orm";
import { apiTokens } from "@/modules/account/tokens/schema";
import { createApiToken, deleteApiToken } from "@/modules/account/tokens/tokens.service";
import { AppError } from "@/shared/lib/errors";
import { findPackage, packageAccess } from "./access";
import { registryNamespaces, registryPackages, registryTokenGrants } from "./schema";

/** One level on every package the owner has, future ones included, or a level per named package (`<namespace id>/<package slug>`). */
export type TokenGrants = { readonly all: GrantLevel } | readonly { readonly package: string; readonly access: GrantLevel }[];

export interface RegistryToken {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly prefix: string;
  readonly grants: TokenGrants;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

const SCOPE_PREFIX = "packages:";

/**
 * The template scopes a set of grants needs. Scopes decide which routes a
 * token may call and grants decide on which packages, so the scopes follow
 * the highest level granted anywhere.
 */
export function deriveScopes(grants: TokenGrants): string[] {
  const levels = new Set("all" in grants ? [grants.all] : grants.map(g => g.access));
  if (levels.size === 0)
    return [];
  const scopes = ["packages:read"];
  if (levels.has("write") || levels.has("admin"))
    scopes.push("packages:write");
  if (levels.has("admin"))
    scopes.push("packages:admin");
  return scopes;
}

type GrantRow = Pick<typeof registryTokenGrants.$inferInsert, "packageId" | "access">;

/**
 * Turn grants into rows, checking that every named package exists and is one
 * the actor may manage. The two failures answer alike, so a grant cannot be
 * used to probe for another user's private packages.
 */
async function resolveGrants(ctx: PolicyContext, grants: TokenGrants): Promise<GrantRow[]> {
  if ("all" in grants)
    return [{ packageId: null, access: grants.all }];
  const rows: GrantRow[] = [];
  for (const grant of grants) {
    const [namespace = "", slug = "", ...rest] = grant.package.split("/");
    const resolved = rest.length === 0 ? await findPackage(ctx.db, namespace, slug) : undefined;
    if (!resolved || !(await packageAccess.can(ctx, "package:manage", resolved.package.id)))
      throw new AppError(`Package ${grant.package} does not exist or is not yours to grant`, 422, "INVALID_GRANT");
    rows.push({ packageId: resolved.package.id, access: grant.access });
  }
  return rows;
}

/** Tokens with their grants, oldest first: one user's, or everyone's. */
export async function listTokens(db: AppDatabase, userId?: string): Promise<RegistryToken[]> {
  const tokens = await db
    .select()
    .from(apiTokens)
    .where(userId === undefined ? undefined : eq(apiTokens.userId, userId))
    .orderBy(asc(apiTokens.createdAt), asc(apiTokens.id))
    .all();
  if (tokens.length === 0)
    return [];
  const grants = await db
    .select({ tokenId: registryTokenGrants.tokenId, access: registryTokenGrants.access, namespace: registryNamespaces.slug, slug: registryPackages.slug })
    .from(registryTokenGrants)
    .leftJoin(registryPackages, eq(registryPackages.id, registryTokenGrants.packageId))
    .leftJoin(registryNamespaces, eq(registryNamespaces.id, registryPackages.namespaceId))
    .where(userId === undefined ? undefined : inArray(registryTokenGrants.tokenId, tokens.map(t => t.id)))
    .all();
  return tokens.map((token) => {
    const mine = grants.filter(g => g.tokenId === token.id);
    const all = mine.find(g => g.slug === null);
    return {
      id: token.id,
      userId: token.userId,
      name: token.name,
      prefix: token.prefix,
      grants: all
        ? { all: all.access }
        : mine.map(g => ({ package: `${g.namespace}/${g.slug}`, access: g.access })).sort((a, b) => a.package.localeCompare(b.package)),
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      createdAt: token.createdAt,
    };
  });
}

export async function getToken(db: AppDatabase, id: string): Promise<RegistryToken | undefined> {
  const row = await db.select({ userId: apiTokens.userId }).from(apiTokens).where(eq(apiTokens.id, id)).get();
  return row && (await listTokens(db, row.userId)).find(t => t.id === id);
}

/**
 * Create a personal API token for the actor, narrowed to `grants`. The
 * returned `token` is the only copy of the secret.
 */
export async function createToken(
  ctx: PolicyContext,
  input: { readonly name: string; readonly expiresAt: string | null; readonly grants: TokenGrants },
): Promise<{ token: string; record: RegistryToken }> {
  const { db } = ctx;
  const rows = await resolveGrants(ctx, input.grants);
  const { token, record } = await createApiToken(db, ctx.actor.id, {
    name: input.name,
    scopes: deriveScopes(input.grants),
    expiresAt: input.expiresAt,
  });
  try {
    if (rows.length > 0)
      await db.insert(registryTokenGrants).values(rows.map(row => ({ ...row, tokenId: record.id }))).run();
  }
  catch (err) {
    // A token whose grants were not stored must not be handed out.
    await deleteApiToken(db, ctx.actor.id, record.id);
    throw err;
  }
  return { token, record: (await getToken(db, record.id))! };
}

/**
 * Replace the grants of one of the actor's tokens; the secret stays. The
 * token's `packages:*` scopes are derived again, any other scope it holds is
 * kept. Undefined when the actor has no such token.
 */
export async function replaceGrants(ctx: PolicyContext, id: string, grants: TokenGrants, name?: string): Promise<RegistryToken | undefined> {
  const { db } = ctx;
  const existing = await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get();
  if (existing?.userId !== ctx.actor.id)
    return undefined;
  const rows = await resolveGrants(ctx, grants);
  const kept = (JSON.parse(existing.scopes) as string[]).filter(scope => !scope.startsWith(SCOPE_PREFIX));
  await db.transaction(async (tx) => {
    await tx.delete(registryTokenGrants).where(eq(registryTokenGrants.tokenId, id)).run();
    if (rows.length > 0)
      await tx.insert(registryTokenGrants).values(rows.map(row => ({ ...row, tokenId: id }))).run();
    // The tokens service has no update, and the scopes have to change with
    // the grants in one step, so the row is written here.
    await tx.update(apiTokens).set({ scopes: JSON.stringify([...kept, ...deriveScopes(grants)]), ...(name === undefined ? {} : { name }) }).where(eq(apiTokens.id, id)).run();
  });
  return await getToken(db, id);
}

/**
 * Revoke a token, returning what it was. With `ownerId` only that user's
 * token is revoked; without, anyone's. Undefined when there is no such token.
 */
export async function revokeToken(db: AppDatabase, id: string, ownerId?: string): Promise<RegistryToken | undefined> {
  const token = await getToken(db, id);
  if (!token || (ownerId !== undefined && token.userId !== ownerId))
    return undefined;
  await deleteApiToken(db, token.userId, id);
  return token;
}
