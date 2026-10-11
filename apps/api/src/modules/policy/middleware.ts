import type { Context, MiddlewareHandler } from "hono";
import type { ResourceAccess } from "./permission";
import type { PolicyContext, PolicyRequest, ResourceRouteSpec } from "./registry";
import type { RouteBinding } from "./route-registry";
import type { AppEnv } from "@/shared/lib/types";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/shared/lib/errors";
import { getAuthProvider } from "@/shared/middleware/auth-registry";
import { createPermissionCache, getAccessByName } from "./permission";
import { getResource } from "./registry";
import { getAllRouteBindings } from "./route-registry";

function buildPolicyRequest(c: Context<AppEnv>): PolicyRequest {
  const userAgent = c.req.header("user-agent");
  const correlationId = c.get("requestId");
  // `+?` preserves the optional modifier; the default mapped type drops `?`
  // and `exactOptionalPropertyTypes` then rejects `string | undefined`.
  const req: { -readonly [K in keyof PolicyRequest]+?: PolicyRequest[K] } = { ip: getClientIp(c) };
  if (userAgent !== undefined)
    req.userAgent = userAgent;
  if (correlationId !== undefined)
    req.correlationId = correlationId;
  return req;
}

export function policyContext(c: Context<AppEnv>): PolicyContext | null {
  const user = c.get("user");
  if (!user)
    return null;
  return {
    db: c.get("db"),
    logger: c.get("logger"),
    actor: { id: user.id, type: "user", role: user.role, name: user.name },
    request: buildPolicyRequest(c),
    cache: createPermissionCache(),
  };
}

/**
 * objectId resolution:
 * 1. `route.idFrom(c, params)` — per-route override.
 * 2. `hooks.resolveObjectId(c, params)` — module-wide rule.
 * 3. `params[route.idParam ?? "id"]` — raw URL param.
 */
async function resolveObjectIdFor<T extends string>(
  c: Context<AppEnv>,
  params: Readonly<Record<string, string>>,
  resource: ResourceAccess<T>,
  route: Pick<ResourceRouteSpec<T>, "idFrom" | "idParam">,
): Promise<string | null> {
  if (route.idFrom)
    return await route.idFrom(c, params);
  if (resource.definition.hooks?.resolveObjectId)
    return await resource.definition.hooks.resolveObjectId(c, params);
  return params[route.idParam ?? "id"] ?? null;
}

/**
 * Per-route gate. Reach for this when a route can't fit the global
 * middleware (composite URLs, route-specific id resolver). The default
 * is `policyMiddleware()` plus `defineResource.routes`.
 */
export function requirePermission<T extends string>(
  resource: ResourceAccess<T>,
  action: T,
  options: { readonly idParam?: string; readonly idFrom?: (c: Context<AppEnv>, params: Readonly<Record<string, string>>) => Promise<string | null> } = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ctx = policyContext(c);
    if (!ctx)
      throw new UnauthorizedError();

    const params: Readonly<Record<string, string>> = c.req.param() ?? {};
    const route: Pick<ResourceRouteSpec<T>, "idFrom" | "idParam"> = {
      ...(options.idFrom !== undefined && { idFrom: options.idFrom }),
      ...(options.idParam !== undefined && { idParam: options.idParam }),
    };
    const objectId = await resolveObjectIdFor(c, params, resource, route);

    if (objectId == null)
      throw new NotFoundError(resource.name, params[options.idParam ?? "id"] ?? "");

    if (!(await resource.can(ctx, action, objectId)))
      throw new ForbiddenError();

    await next();
  };
}

interface CompiledBinding {
  readonly binding: RouteBinding;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
}

function compileBinding(basePath: string, b: RouteBinding): CompiledBinding {
  const fullPath = `${basePath}${b.path}`;
  const paramNames: string[] = [];
  const escaped = fullPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(/:([a-z_]\w*)/gi, (_, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  return { binding: b, regex: new RegExp(`^${pattern}$`), paramNames };
}

// Idempotent actor load: reuse `c.var.user` when `authRequired` already
// ran upstream, otherwise call the provider so policy enforcement does
// not depend on middleware ordering.
async function loadActor(c: Context<AppEnv>): Promise<{ id: string; role: string; name: string } | null> {
  const existing = c.get("user");
  if (existing)
    return { id: existing.id, role: existing.role, name: existing.name };
  const provider = getAuthProvider();
  const user = await provider(c.get("db"), c);
  if (!user)
    return null;
  c.set("user", user);
  return { id: user.id, role: user.role, name: user.name };
}

/**
 * Global permission enforcement. Mount once at the API root; every
 * route declared in `defineResource.routes` is auto-gated. Undeclared
 * routes pass through. Admin actors short-circuit before any DB query.
 *
 * See `docs/develop/module/policy-standard.md`.
 */
export function policyMiddleware(options: { readonly basePath?: string } = {}): MiddlewareHandler<AppEnv> {
  const basePath = options.basePath ?? "";
  let compiled: readonly CompiledBinding[] | null = null;
  let lastBindingCount = 0;

  function getCompiled(): readonly CompiledBinding[] {
    const all = getAllRouteBindings();
    if (compiled === null || all.length !== lastBindingCount) {
      compiled = all.map(b => compileBinding(basePath, b));
      lastBindingCount = all.length;
    }
    return compiled;
  }

  return async (c, next) => {
    const table = getCompiled();
    if (table.length === 0)
      return next();

    const method = c.req.method;
    const path = c.req.path;

    let match: CompiledBinding | undefined;
    let captures: RegExpExecArray | null = null;
    for (const entry of table) {
      if (entry.binding.method !== method)
        continue;
      const m = entry.regex.exec(path);
      if (m) {
        match = entry;
        captures = m;
        break;
      }
    }

    if (!match || !captures)
      return next();

    const actor = await loadActor(c);
    if (!actor)
      throw new UnauthorizedError();

    if (actor.role === "admin")
      return next();

    const access = getAccessByName(match.binding.resourceName);
    const def = getResource(match.binding.resourceName);
    // A binding only exists because defineResource() wrote it, so this
    // cannot happen by construction — but a permission gate's fallback
    // must be to deny, never to let the handler run unchecked.
    if (!access || !def)
      throw new AppError(`Policy binding for resource '${match.binding.resourceName}' has no registered definition`);

    const params: Record<string, string> = {};
    for (let i = 0; i < match.paramNames.length; i++)
      params[match.paramNames[i]!] = captures[i + 1]!;

    const route = def.routes?.find(r => r.method === match!.binding.method && r.path === match!.binding.path);
    const objectId = await resolveObjectIdFor(c, params, access, route ?? {});
    // When the URL segment for `:id` doesn't resolve to a known resource
    // row, fall through to the route handler. This covers two cases at
    // once: (a) sibling static paths like `/documents/tree` that the
    // resource's binding (`/documents/:id`) accidentally captures —
    // letting the handler run is correct; (b) a genuinely bogus id —
    // the handler runs its own existence check and surfaces the same
    // 404 it would have otherwise. The handler is the single source of
    // truth for "does this id exist", which keeps the gate from
    // double-querying and from accidentally hiding non-resource routes.
    if (objectId == null)
      return next();

    const ctx = policyContext(c);
    if (!ctx)
      throw new UnauthorizedError();

    if (!(await access.can(ctx, match.binding.action, objectId)))
      throw new ForbiddenError();

    await next();
  };
}
