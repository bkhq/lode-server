import type { Context } from "hono";
import type { AppDatabase } from "@/db";
import type { PolicyContext } from "@/modules/policy";
import type { AppEnv } from "@/shared/lib/types";
import { Buffer } from "node:buffer";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { apiTokens } from "@/modules/account/tokens/schema";
import { resolveApiToken, TOKEN_PREFIX } from "@/modules/account/tokens/tokens.service";
import { defineResource, policyContext } from "@/modules/policy";
import { AppError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/shared/lib/errors";
import { registryNamespaces, registryPackages, registryTokenGrants, registryUploads, registryVersions } from "./schema";

export type RegistryNamespace = typeof registryNamespaces.$inferSelect;
export type RegistryPackage = typeof registryPackages.$inferSelect;

export interface ResolvedPackage {
  readonly namespace: RegistryNamespace;
  readonly package: RegistryPackage;
}

/**
 * What a caller may do with one package, lowest first; each level includes
 * the ones before it.
 * - `read`  — package metadata.
 * - `write` — the release routes: versions, uploads, publish, channels.
 * - `admin` — package settings.
 * - `owner` — delete the package.
 */
export type PackageAccessLevel = "read" | "write" | "admin" | "owner";

/** The levels a token grant can carry: everything but `owner`. */
export type GrantLevel = Exclude<PackageAccessLevel, "owner">;

const LEVEL_RANK: Record<PackageAccessLevel, number> = {
  read: 1,
  write: 2,
  admin: 3,
  owner: 4,
};

async function isPublicPackage(db: AppDatabase, packageId: string): Promise<boolean> {
  const row = await db.select({ visibility: registryPackages.visibility }).from(registryPackages).where(eq(registryPackages.id, packageId)).get();
  return row?.visibility === "public";
}

/**
 * The `package` policy resource. Its route table is what the global policy
 * middleware enforces: an ordinary user reaches only packages they hold a
 * relation on — in v1 the owner tuple written at creation — and a platform
 * administrator passes every check. The metadata of a public package is
 * readable by every signed-in user.
 *
 * A private package the caller cannot read is reported to the middleware as
 * unresolved, so the request falls through to the handler and
 * `requirePackageAccess` answers 404: its slug must not be discoverable by
 * probing. Every handler under `/registry/packages/:ns/:pkg` therefore has to
 * call `requirePackageAccess`.
 *
 * `maintainer` and `reader` are declared for the ladder but nothing grants
 * them yet, so `package:manage` stays with the owner until maintainers exist.
 */
export const packageAccess = defineResource({
  name: "package",
  namespace: "package",
  description: "Registry packages. Owned by the user whose namespace they live in.",
  actions: {
    "package:read": "reader",
    "package:release": "maintainer",
    "package:manage": "owner",
    "package:delete": "owner",
  } as const,
  routes: [
    { method: "GET", path: "/registry/packages/:ns/:pkg", action: "package:read" },
    { method: "PATCH", path: "/registry/packages/:ns/:pkg", action: "package:manage" },
    { method: "DELETE", path: "/registry/packages/:ns/:pkg", action: "package:delete" },
  ] as const,
  hooks: {
    bypass: async (ctx, action, objectId) =>
      ctx.actor.role === "admin" || (action === "package:read" && await isPublicPackage(ctx.db, objectId)),
    // null lets the request through to the handler, whose own
    // `requirePackageAccess` answers 404.
    resolveObjectId: async (c, params) => {
      const resolved = await findPackage(c.get("db"), params.ns ?? "", params.pkg ?? "");
      if (!resolved)
        return null;
      if (resolved.package.visibility === "private") {
        const ctx = policyContext(c);
        if (!ctx || !(await canReadPackage(ctx, resolved.package.id)))
          return null;
      }
      return resolved.package.id;
    },
    resolveEntity: async (db, objectId) => {
      const row = await db
        .select({ namespace: registryNamespaces.slug, slug: registryPackages.slug })
        .from(registryPackages)
        .innerJoin(registryNamespaces, eq(registryNamespaces.id, registryPackages.namespaceId))
        .where(eq(registryPackages.id, objectId))
        .get();
      return row
        ? { name: `${row.namespace}/${row.slug}`, type: "package" }
        : null;
    },
  },
});

// The return type is spelled out because a hook of `packageAccess` calls
// this: inferred, the resource's type would depend on itself.
async function canReadPackage(ctx: PolicyContext, packageId: string): Promise<boolean> {
  return await packageAccess.can(ctx, "package:read", packageId);
}

const LEVEL_ACTIONS = {
  read: "package:read",
  write: "package:release",
  admin: "package:manage",
  owner: "package:delete",
} as const satisfies Record<PackageAccessLevel, string>;

/**
 * Look a namespace up by slug. Slugs are unique ignoring letter case and
 * indexed that way, but a URL has to spell the slug exactly.
 */
export async function findNamespaceBySlug(db: AppDatabase, slug: string): Promise<RegistryNamespace | undefined> {
  const row = await db.select().from(registryNamespaces).where(sql`lower(${registryNamespaces.slug}) = ${slug.toLowerCase()}`).get();
  return row?.slug === slug
    ? row
    : undefined;
}

/** Look a package up by the `:ns/:pkg` of a URL: its namespace's slug and its own. */
export async function findPackage(db: AppDatabase, namespaceSlug: string, slug: string): Promise<ResolvedPackage | undefined> {
  const namespace = await findNamespaceBySlug(db, namespaceSlug);
  if (!namespace)
    return undefined;
  const pkg = await db.select().from(registryPackages).where(and(eq(registryPackages.namespaceId, namespace.id), eq(registryPackages.slug, slug))).get();
  return pkg && { namespace, package: pkg };
}

export function namespaceSuspended(): AppError {
  return new AppError("This namespace is suspended", 403, "NAMESPACE_SUSPENDED");
}

// ─── Token requests ───

/** The personal API token a request or a feed download is made with. */
export interface RequestToken {
  readonly id: string;
  readonly userId: string;
  /** Whether the token's owner is a platform administrator. */
  readonly ownerIsAdmin: boolean;
}

const BEARER = `Bearer ${TOKEN_PREFIX}`;

async function findTokenId(db: AppDatabase, authorization: string): Promise<{ id: string; userId: string } | undefined> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization.slice("Bearer ".length).trim()));
  return await db
    .select({ id: apiTokens.id, userId: apiTokens.userId })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, Buffer.from(digest).toString("hex")))
    .get();
}

/**
 * The token the current request carries, or null for a session request.
 *
 * Any `Authorization: Bearer pat_…` header makes the request a token request
 * here, even next to a session cookie: the registry then applies the token's
 * grants, which can only narrow what the caller may do.
 */
export async function requestToken(c: Context<AppEnv>): Promise<RequestToken | null> {
  const header = c.req.header("authorization");
  if (!header?.startsWith(BEARER))
    return null;
  const user = c.get("user");
  const token = await findTokenId(c.get("db"), header);
  if (!user || !token || token.userId !== user.id)
    throw new ForbiddenError("This API token does not belong to the authenticated user");
  return { ...token, ownerIsAdmin: user.role === "admin" };
}

/** A token is of no use to the registry while its owner's namespace is suspended. */
async function ownerIsSuspended(db: AppDatabase, userId: string): Promise<boolean> {
  const row = await db.select({ status: registryNamespaces.status }).from(registryNamespaces).where(eq(registryNamespaces.ownerUserId, userId)).get();
  return row?.status === "suspended";
}

/**
 * The highest level the token's grants give on a package, or undefined when
 * no grant covers it. The "all my packages" grant covers the packages in the
 * owner's namespace; a grant naming a package counts while the token's owner
 * still owns that package or is an administrator.
 */
async function grantedLevel(db: AppDatabase, token: RequestToken, resolved: ResolvedPackage): Promise<GrantLevel | undefined> {
  const owned = resolved.namespace.ownerUserId === token.userId;
  if (!owned && !token.ownerIsAdmin)
    return undefined;
  const grants = await db
    .select({ packageId: registryTokenGrants.packageId, access: registryTokenGrants.access })
    .from(registryTokenGrants)
    .where(and(
      eq(registryTokenGrants.tokenId, token.id),
      or(eq(registryTokenGrants.packageId, resolved.package.id), isNull(registryTokenGrants.packageId)),
    ))
    .all();
  let best: GrantLevel | undefined;
  for (const grant of grants) {
    if (grant.packageId === null && !owned)
      continue;
    if (best === undefined || LEVEL_RANK[grant.access] > LEVEL_RANK[best])
      best = grant.access;
  }
  return best;
}

/** The packages a token has any grant on, for `GET /registry/packages`. */
export async function listGrantedPackages(db: AppDatabase, token: RequestToken): Promise<ResolvedPackage[]> {
  if (await ownerIsSuspended(db, token.userId))
    throw namespaceSuspended();
  const grants = await db.select({ packageId: registryTokenGrants.packageId }).from(registryTokenGrants).where(eq(registryTokenGrants.tokenId, token.id)).all();
  if (grants.length === 0)
    return [];
  const all = grants.some(g => g.packageId === null);
  const named = new Set(grants.map(g => g.packageId));
  const rows = await db
    .select({ namespace: registryNamespaces, package: registryPackages })
    .from(registryPackages)
    .innerJoin(registryNamespaces, eq(registryNamespaces.id, registryPackages.namespaceId))
    .where(token.ownerIsAdmin
      ? undefined
      : eq(registryNamespaces.ownerUserId, token.userId))
    .orderBy(asc(registryNamespaces.slug), asc(registryPackages.slug))
    .all();
  return rows.filter(row => named.has(row.package.id) || (all && row.namespace.ownerUserId === token.userId));
}

/**
 * Whether `authorization` is a live `Bearer pat_…` token holding a read grant
 * on the package. For the read feed, which has no auth middleware: false
 * for a missing or foreign header, an unknown or expired token, a disabled
 * owner, a suspended owner namespace, or a token without a grant.
 */
export async function resolveReadToken(db: AppDatabase, authorization: string | undefined, packageId: string): Promise<boolean> {
  if (!authorization?.startsWith(BEARER))
    return false;
  const live = await resolveApiToken(db, authorization.slice("Bearer ".length).trim());
  const token = live && await findTokenId(db, authorization);
  if (!live || !token || await ownerIsSuspended(db, token.userId))
    return false;
  const resolved = await db
    .select({ namespace: registryNamespaces, package: registryPackages })
    .from(registryPackages)
    .innerJoin(registryNamespaces, eq(registryNamespaces.id, registryPackages.namespaceId))
    .where(eq(registryPackages.id, packageId))
    .get();
  if (!resolved)
    return false;
  return await grantedLevel(db, { ...token, ownerIsAdmin: live.user.role === "admin" }, resolved) !== undefined;
}

/**
 * The live token `authorization` carries, for the OTLP ingest at `/r/otlp`:
 * undefined for a missing or foreign header, an unknown or expired token, a
 * disabled owner or a suspended owner namespace.
 */
export async function resolveReportToken(db: AppDatabase, authorization: string | undefined): Promise<RequestToken | undefined> {
  if (!authorization?.startsWith(BEARER))
    return undefined;
  const live = await resolveApiToken(db, authorization.slice("Bearer ".length).trim());
  const token = live && await findTokenId(db, authorization);
  if (!live || !token || await ownerIsSuspended(db, token.userId))
    return undefined;
  return { ...token, ownerIsAdmin: live.user.role === "admin" };
}

/**
 * The package a reported resource belongs to: `name` (`service.name`) in the
 * namespace `namespace` (`service.namespace`) when given, else in the token
 * owner's namespace. Undefined unless the token holds a grant on it and its
 * namespace is active.
 */
export async function findReportPackage(db: AppDatabase, token: RequestToken, name: string, namespace?: string): Promise<RegistryPackage | undefined> {
  let nsSlug = namespace;
  if (nsSlug === undefined) {
    const own = await db.select({ slug: registryNamespaces.slug }).from(registryNamespaces).where(eq(registryNamespaces.ownerUserId, token.userId)).get();
    nsSlug = own?.slug;
  }
  if (nsSlug === undefined)
    return undefined;
  const resolved = await findPackage(db, nsSlug, name);
  if (!resolved || resolved.namespace.status !== "active")
    return undefined;
  return await grantedLevel(db, token, resolved) === undefined
    ? undefined
    : resolved.package;
}

/** What `requirePackageAccess` hands a handler: the package, and the token the request came with. */
export interface PackageRequest extends ResolvedPackage {
  /** Set for a token request; goes into the audit entry next to the user. */
  readonly tokenId: string | null;
}

/**
 * Resolve the `:ns/:pkg` of the current route to a package and check that
 * the caller may act on it at `level`.
 *
 * - An unknown package is a 404, and so is a private one the caller cannot
 *   read. A package the caller can see but not act on at `level` is a 403.
 * - A token request additionally needs a grant covering the package at
 *   `level` or above; `owner` is never open to a token.
 * - While a namespace is suspended its packages are read-only to everyone
 *   but an administrator, and its owner's tokens are refused altogether.
 */
export async function requirePackageAccess(c: Context<AppEnv>, level: PackageAccessLevel): Promise<PackageRequest> {
  return await requireAccess(c, level, "Package", async db => await findPackage(db, c.req.param("ns") ?? "", c.req.param("pkg") ?? ""));
}

export type RegistryUpload = typeof registryUploads.$inferSelect;

/** What `requireUploadAccess` hands a handler: the upload, and the version and package it belongs to. */
export interface UploadRequest extends PackageRequest {
  readonly upload: RegistryUpload;
  readonly version: typeof registryVersions.$inferSelect;
}

/**
 * Resolve the `:uploadId` of the current route to its upload, version and
 * package, and check the caller against that package the way
 * `requirePackageAccess` does.
 *
 * An upload is not public even when its package is: an unknown id and one in
 * a package the caller has no part in are the same 404. Only a token of the
 * package's own side whose grant is too low is told so with a 403.
 */
export async function requireUploadAccess(c: Context<AppEnv>, level: PackageAccessLevel): Promise<UploadRequest> {
  let found: Omit<UploadRequest, "tokenId"> | undefined;
  const access = await requireAccess(c, level, "Upload", async (db) => {
    found = await db
      .select({
        upload: registryUploads,
        version: registryVersions,
        package: registryPackages,
        namespace: registryNamespaces,
      })
      .from(registryUploads)
      .innerJoin(registryVersions, eq(registryVersions.id, registryUploads.versionId))
      .innerJoin(registryPackages, eq(registryPackages.id, registryVersions.packageId))
      .innerJoin(registryNamespaces, eq(registryNamespaces.id, registryPackages.namespaceId))
      .where(eq(registryUploads.id, c.req.param("uploadId") ?? ""))
      .get();
    return found;
  });
  return { ...found!, tokenId: access.tokenId };
}

async function requireAccess(
  c: Context<AppEnv>,
  level: PackageAccessLevel,
  what: "Package" | "Upload",
  resolve: (db: AppDatabase) => Promise<ResolvedPackage | undefined>,
): Promise<PackageRequest> {
  const ctx = policyContext(c);
  if (!ctx)
    throw new UnauthorizedError();
  const token = await requestToken(c);
  if (token && await ownerIsSuspended(ctx.db, token.userId))
    throw namespaceSuspended();
  const resolved = await resolve(ctx.db);
  if (!resolved)
    throw new NotFoundError(what);

  const granted = token
    ? await grantedLevel(ctx.db, token, resolved)
    : undefined;
  const readable = await canReadPackage(ctx, resolved.package.id) && (!token || granted !== undefined);
  if (!readable) {
    if (what === "Upload" || resolved.package.visibility === "private")
      throw new NotFoundError(what);
    throw new ForbiddenError(token ? "This API token has no grant on this package" : undefined);
  }
  if (what === "Package")
    await packageAccess.assert(ctx, LEVEL_ACTIONS[level], resolved.package.id);
  else if (!(await packageAccess.can(ctx, LEVEL_ACTIONS[level], resolved.package.id)))
    throw new NotFoundError(what);
  if (token && (granted === undefined || LEVEL_RANK[granted] < LEVEL_RANK[level]))
    throw new ForbiddenError(`This API token's grant does not allow ${level} access to this package`);
  if (level !== "read" && resolved.namespace.status !== "active" && ctx.actor.role !== "admin")
    throw namespaceSuspended();
  return { namespace: resolved.namespace, package: resolved.package, tokenId: token?.id ?? null };
}
