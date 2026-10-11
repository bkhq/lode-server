import type { RelationTuple } from "./policy.service";
import type { GrantParams, PermissionCache, PolicyContext, ResourceDefinition, Subject, TupleKey } from "./registry";
import type { AppDatabase } from "@/db";
import { DIRECT_SUBJECT } from "@/modules/policy/schema";
import { ForbiddenError } from "@/shared/lib/errors";
import { createTuple, deleteTupleByKey, deleteTuplesForEntity } from "./policy.service";
import { registerResource } from "./registry";
import { registerRouteBinding } from "./route-registry";
import { check, listUserResources, resolveUserGroups } from "./zanzibar.engine";

export function createPermissionCache(): PermissionCache {
  const cache: PermissionCache = {
    checks: new Map(),
    clear() {
      cache.checks.clear();
      cache.groupClosure = undefined;
    },
  };
  return cache;
}

/**
 * The one engine entry point for the facade. Hooks (`bypass`, `onChecked`)
 * stay outside so their per-call contract is untouched; only the graph
 * resolution is memoised. Group closure is resolved once per request and
 * handed to the engine so `group:G#member` usersets become set lookups.
 */
async function resolveAllowed(ctx: PolicyContext, namespace: string, objectId: string, relation: string): Promise<boolean> {
  const { cache } = ctx;
  if (!cache)
    return (await check(ctx.db, namespace, objectId, relation, ctx.actor.type, ctx.actor.id)).allowed;

  const key = `${namespace}:${objectId}#${relation}@${ctx.actor.type}:${ctx.actor.id}`;
  const hit = cache.checks.get(key);
  if (hit !== undefined)
    return hit;

  if (cache.groupClosure === undefined && ctx.actor.type === "user")
    cache.groupClosure = new Set(await resolveUserGroups(ctx.db, ctx.actor.id));

  const result = await check(ctx.db, namespace, objectId, relation, ctx.actor.type, ctx.actor.id, {
    ...(cache.groupClosure && { groupClosure: cache.groupClosure }),
  });
  cache.checks.set(key, result.allowed);
  return result.allowed;
}

/**
 * Action-based permission client for one resource. Business code calls
 * verbs (`"document:update"`); the action → relation mapping lives in
 * the resource definition.
 */
export class ResourceAccess<TAction extends string> {
  constructor(public readonly definition: ResourceDefinition<TAction>) {}

  get name(): string {
    return this.definition.name;
  }

  get namespace(): string {
    return this.definition.namespace;
  }

  actionToRelation(action: TAction): string {
    return this.definition.actions[action];
  }

  /**
   * `hooks.bypass` → engine.check. `onChecked` fires after either path
   * so audit code records bypass and engine outcomes uniformly.
   */
  async can(ctx: PolicyContext, action: TAction, objectId: string): Promise<boolean> {
    const hooks = this.definition.hooks;

    if (hooks?.bypass) {
      const bypassed = await hooks.bypass(ctx, action, objectId);
      if (bypassed) {
        await hooks.onChecked?.(ctx, { action, objectId, allowed: true, bypassed: true });
        return true;
      }
    }

    const allowed = await resolveAllowed(ctx, this.definition.namespace, objectId, this.definition.actions[action]);
    await hooks?.onChecked?.(ctx, { action, objectId, allowed, bypassed: false });
    return allowed;
  }

  // No bypass: that's a property of the request actor, not of an
  // arbitrary subject the caller is testing.
  async canSubject(db: AppDatabase, subject: Subject, action: TAction, objectId: string): Promise<boolean> {
    const result = await check(db, this.definition.namespace, objectId, this.definition.actions[action], subject.type, subject.id);
    return result.allowed;
  }

  // Today this resolves only user subjects, matching the engine's
  // `listUserResources` signature. Extend the engine for group-side
  // enumeration when a module needs it.
  async listObjectsFor(db: AppDatabase, userId: string, action: TAction): Promise<readonly string[]> {
    return await listUserResources(db, userId, this.definition.namespace, this.definition.actions[action]);
  }

  async assert(ctx: PolicyContext, action: TAction, objectId: string): Promise<void> {
    if (!(await this.can(ctx, action, objectId)))
      throw new ForbiddenError();
  }

  /** `canGrant?` → write tuple → `onGranted?`. */
  async grant(ctx: PolicyContext, params: { readonly subject: Subject; readonly relation: string; readonly objectId: string }): Promise<RelationTuple> {
    const hooks = this.definition.hooks;
    const grantParams: GrantParams = { subject: params.subject, relation: params.relation, objectId: params.objectId };

    if (hooks?.canGrant) {
      const allowed = await hooks.canGrant(ctx, grantParams);
      if (!allowed)
        throw new ForbiddenError();
    }

    const tuple = await createTuple(
      ctx.db,
      {
        namespace: this.definition.namespace,
        objectId: params.objectId,
        relation: params.relation,
        subjectNamespace: params.subject.type,
        subjectId: params.subject.id,
        subjectRelation: defaultSubjectRelation(params.subject),
      },
      ctx.actor.id,
    );
    ctx.cache?.clear();

    await hooks?.onGranted?.(ctx, tuple);
    return tuple;
  }

  async revoke(ctx: PolicyContext, params: { readonly subject: Subject; readonly relation: string; readonly objectId: string }): Promise<boolean> {
    const hooks = this.definition.hooks;
    const grantParams: GrantParams = { subject: params.subject, relation: params.relation, objectId: params.objectId };

    if (hooks?.canRevoke) {
      const allowed = await hooks.canRevoke(ctx, grantParams);
      if (!allowed)
        throw new ForbiddenError();
    }

    const key: TupleKey = {
      namespace: this.definition.namespace,
      objectId: params.objectId,
      relation: params.relation,
      subjectNamespace: params.subject.type,
      subjectId: params.subject.id,
      subjectRelation: defaultSubjectRelation(params.subject),
    };
    const removed = await deleteTupleByKey(ctx.db, key);
    ctx.cache?.clear();

    if (removed)
      await hooks?.onRevoked?.(ctx, key);
    return removed;
  }

  // Does not fire `onRevoked` per tuple — that would flood the audit
  // pipeline on bulk cleanup. Iterate `revoke()` if per-tuple events
  // are required.
  async cascadeDelete(db: AppDatabase, objectId: string): Promise<void> {
    await deleteTuplesForEntity(db, this.definition.namespace, objectId);
  }

  async canReadField(ctx: PolicyContext, field: string, objectId: string): Promise<boolean> {
    return await this.canFieldOp(ctx, "read", field, objectId);
  }

  async canWriteField(ctx: PolicyContext, field: string, objectId: string): Promise<boolean> {
    return await this.canFieldOp(ctx, "write", field, objectId);
  }

  private async canFieldOp(ctx: PolicyContext, op: "read" | "write", field: string, objectId: string): Promise<boolean> {
    const required = this.definition.fields?.[op]?.[field];
    if (required === undefined)
      return true;

    const hooks = this.definition.hooks;
    if (hooks?.bypass) {
      const bypassed = await hooks.bypass(ctx, `${this.definition.name}:field.${op}:${field}`, objectId);
      if (bypassed)
        return true;
    }

    return await resolveAllowed(ctx, this.definition.namespace, objectId, required);
  }

  /**
   * Drop read-restricted fields the actor cannot see. Returns a new
   * object; never mutates `row`.
   */
  async projectFields<TRow extends Record<string, unknown>>(
    ctx: PolicyContext,
    objectId: string,
    row: TRow,
  ): Promise<Partial<TRow>> {
    const restricted = this.definition.fields?.read;
    if (!restricted)
      return { ...row };

    const out: Partial<TRow> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!(k in restricted)) {
        out[k as keyof TRow] = v as TRow[keyof TRow];
        continue;
      }
      if (await this.canFieldOp(ctx, "read", k, objectId))
        out[k as keyof TRow] = v as TRow[keyof TRow];
    }
    return out;
  }

  /**
   * Filter write-restricted fields. `"strip"` (default) silently drops
   * unauthorised fields; `"reject"` throws `ForbiddenError` listing them.
   */
  async filterWritable<TPayload extends Record<string, unknown>>(
    ctx: PolicyContext,
    objectId: string,
    payload: TPayload,
    options: { readonly onForbidden?: "strip" | "reject" } = {},
  ): Promise<Partial<TPayload>> {
    const restricted = this.definition.fields?.write;
    if (!restricted)
      return { ...payload };

    const mode = options.onForbidden ?? "strip";
    const out: Partial<TPayload> = {};
    const denied: string[] = [];

    for (const [k, v] of Object.entries(payload)) {
      if (!(k in restricted)) {
        out[k as keyof TPayload] = v as TPayload[keyof TPayload];
        continue;
      }
      if (await this.canFieldOp(ctx, "write", k, objectId))
        out[k as keyof TPayload] = v as TPayload[keyof TPayload];
      else
        denied.push(k);
    }

    if (denied.length > 0 && mode === "reject")
      throw new ForbiddenError(`Cannot write field(s): ${denied.join(", ")}`);
    return out;
  }
}

// Access instances live in their own map so `policyMiddleware` (which
// only knows the resource name from the request match) can look them
// up without importing every module's permission file.
const accessInstances = new Map<string, ResourceAccess<string>>();

export function getAccessByName(name: string): ResourceAccess<string> | undefined {
  return accessInstances.get(name);
}

export function __resetAccessInstancesForTests(): void {
  accessInstances.clear();
}

/**
 * Register a resource and return its access client. Call once at
 * module load from `index.ts`; export the result so handlers and
 * services share the same vocabulary.
 */
export function defineResource<T extends string>(definition: ResourceDefinition<T>): ResourceAccess<T> {
  registerResource(definition);
  if (definition.routes) {
    for (const r of definition.routes) {
      registerRouteBinding({
        resourceName: definition.name,
        method: r.method,
        path: r.path,
        action: r.action,
      });
    }
  }
  const access = new ResourceAccess(definition);
  accessInstances.set(definition.name, access as ResourceAccess<string>);
  return access;
}

function defaultSubjectRelation(subject: Subject): string {
  if (subject.relation !== undefined)
    return subject.relation;
  return subject.type === "group" ? "member" : DIRECT_SUBJECT;
}
