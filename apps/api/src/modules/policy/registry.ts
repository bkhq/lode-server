import type { Context } from "hono";
import type { RelationTuple } from "./policy.service";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import type { AppEnv } from "@/shared/lib/types";

/**
 * Vocabulary every module uses when wiring into the policy framework.
 * No decision logic lives here; the engine and `permission.ts` read
 * these types and produce decisions.
 */

/**
 * The "who" in a permission grant or check. `type` is any registered
 * namespace from `namespace-config.ts` (user / group / service_account / …).
 * `relation` defaults to `"member"` for groups and `undefined` elsewhere.
 */
export interface Subject {
  readonly type: string;
  readonly id: string;
  readonly relation?: string;
}

export const userSubject = (id: string): Subject => ({ type: "user", id });
export const groupSubject = (id: string, relation = "member"): Subject => ({ type: "group", id, relation });

export interface PolicyActor {
  readonly id: string;
  /** Namespace-aligned: `"user"` for end users, `"system"` for cron / migrations, `"service_account"` for tokens. */
  readonly type: string;
  /** Product role (`"admin"`, `"member"`, …). Distinct from policy relations. */
  readonly role?: string;
  readonly name?: string;
  /** Free-form per-request metadata (tenant id, feature flags, trace ids). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Request-scoped memo for engine results. One object per request; the
 * permission snapshot stays consistent for the request's lifetime and is
 * dropped with it, so there is no cross-request invalidation to get wrong.
 * `grant` / `revoke` / `cascadeDelete` clear it. Code that writes tuples
 * directly (bypassing the facade) must call `clear()` itself if it goes on
 * to check permissions in the same request.
 */
export interface PermissionCache {
  readonly checks: Map<string, boolean>;
  /** Flattened group ids for the actor, resolved once on first use. */
  groupClosure?: ReadonlySet<string> | undefined;
  clear: () => void;
}

export interface PolicyContext {
  readonly db: AppDatabase;
  readonly actor: PolicyActor;
  readonly request?: PolicyRequest;
  /** Absent → every call resolves live (internal helpers, cron actors). */
  readonly cache?: PermissionCache;
  // Threaded through so per-resource onGranted / onRevoked hooks (e.g.
  // document.permission's share-audit emitter) can write to the
  // structured logger without reaching for a process-global handle.
  readonly logger: Logger;
}

export interface PolicyRequest {
  readonly ip?: string;
  readonly userAgent?: string;
  readonly correlationId?: string;
}

export interface TupleKey {
  readonly namespace: string;
  readonly objectId: string;
  readonly relation: string;
  readonly subjectNamespace: string;
  readonly subjectId: string;
  readonly subjectRelation: string | null;
}

export interface EntityDescriptor {
  readonly name: string;
  readonly type?: string;
  readonly url?: string;
}

export interface GrantParams {
  readonly subject: Subject;
  readonly relation: string;
  readonly objectId: string;
}

/**
 * Hooks every module can attach to its resource. All optional. They run
 * inline in the request path — keep them fast and side-effect free
 * except where the name promises otherwise (`onGranted`, `onRevoked`).
 * Errors propagate and fail the request.
 */
export interface ResourceHooks {
  /**
   * Map URL → engine `objectId`. `params` is pre-extracted by the
   * framework because the global middleware runs before Hono dispatches
   * the route, so `c.req.param()` is empty at that point. Set when the
   * URL exposes an external id (short id, slug) different from the
   * engine's id. Return `null` to produce a 404.
   */
  resolveObjectId?: (c: Context<AppEnv>, params: Readonly<Record<string, string>>) => Promise<string | null>;

  /** Map `objectId` to a display descriptor for audit / debug UI. */
  resolveEntity?: (db: AppDatabase, objectId: string) => Promise<EntityDescriptor | null>;

  /**
   * Allow the actor without consulting the engine. Field checks pass
   * `action` as `<resource>:field.<read|write>:<field>`, so a single
   * `ctx.actor.role === "admin"` covers route and field checks.
   */
  bypass?: (ctx: PolicyContext, action: string, objectId: string) => boolean | Promise<boolean>;

  canGrant?: (ctx: PolicyContext, params: GrantParams) => boolean | Promise<boolean>;
  canRevoke?: (ctx: PolicyContext, params: GrantParams) => boolean | Promise<boolean>;

  onGranted?: (ctx: PolicyContext, tuple: RelationTuple) => Promise<void>;
  onRevoked?: (ctx: PolicyContext, key: TupleKey) => Promise<void>;

  // Fires on every can() call. Sparingly — runs per gated request.
  onChecked?: (ctx: PolicyContext, params: { action: string; objectId: string; allowed: boolean; bypassed: boolean }) => Promise<void>;
}

/**
 * One row of the HTTP route table. `path` is relative to the API root
 * (`/documents/:id`, not `/api/v1/documents/:id`).
 */
export interface ResourceRouteSpec<TAction extends string> {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly action: TAction;
  readonly idParam?: string;
  readonly idFrom?: (c: Context<AppEnv>, params: Readonly<Record<string, string>>) => Promise<string | null>;
}

/**
 * Field-level policy: `field → minimum relation`. Fields not listed are
 * unrestricted (anyone the route action admitted may read / write them).
 */
export interface ResourceFieldPolicy {
  readonly read?: Readonly<Record<string, string>>;
  readonly write?: Readonly<Record<string, string>>;
}

export interface ResourceDefinition<TAction extends string = string> {
  readonly name: string;
  readonly namespace: string;
  readonly description?: string;
  readonly actions: Readonly<Record<TAction, string>>;
  // `NoInfer` keeps TAction flowing from `actions` alone — declaring
  // fewer routes than actions does not narrow the action union.
  readonly routes?: ReadonlyArray<ResourceRouteSpec<NoInfer<TAction>>>;
  readonly fields?: ResourceFieldPolicy;
  readonly hooks?: ResourceHooks;
}

const registry = new Map<string, ResourceDefinition>();

export function registerResource<T extends string>(def: ResourceDefinition<T>): void {
  registry.set(def.name, def as ResourceDefinition);
}

export function getResource(name: string): ResourceDefinition | undefined {
  return registry.get(name);
}

export function getAllResources(): readonly ResourceDefinition[] {
  return [...registry.values()];
}

export function __resetResourceRegistryForTests(): void {
  registry.clear();
}

export interface ResourceManifestEntry {
  readonly name: string;
  readonly namespace: string;
  readonly description: string | undefined;
  readonly actions: ReadonlyArray<{ readonly action: string; readonly relation: string }>;
  readonly hooks: ReadonlyArray<keyof ResourceHooks>;
  readonly routes: ReadonlyArray<{ readonly method: string; readonly path: string; readonly action: string }>;
}

// `getRouteBindings` injected at call time so this file stays free of
// route-registry imports, keeping the dependency direction one-way.
export function getPermissionManifest(
  getRouteBindings?: (resourceName: string) => readonly { method: string; path: string; action: string }[],
): readonly ResourceManifestEntry[] {
  return [...registry.values()]
    .map(def => ({
      name: def.name,
      namespace: def.namespace,
      description: def.description,
      actions: Object.entries(def.actions).map(([action, relation]) => ({ action, relation })),
      hooks: def.hooks ? (Object.keys(def.hooks) as Array<keyof ResourceHooks>) : [],
      routes: getRouteBindings ? [...getRouteBindings(def.name)] : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
