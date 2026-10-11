/**
 * Route → action bindings. Populated by `defineResource({ routes })`,
 * consumed by `policyMiddleware` and `/policy/manifest`.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteBinding {
  readonly resourceName: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly action: string;
}

const bindings: RouteBinding[] = [];

export function registerRouteBinding(b: RouteBinding): void {
  // Two bindings on one (method, path) would gate the route twice with
  // whichever action each declared — a definition bug, so refuse it at
  // registration instead of letting it silently double-check at runtime.
  const clash = bindings.find(x => x.method === b.method && x.path === b.path);
  if (clash)
    throw new Error(`Route ${b.method} ${b.path} is already bound to resource '${clash.resourceName}' (action '${clash.action}')`);
  bindings.push(b);
}

export function getAllRouteBindings(): readonly RouteBinding[] {
  return [...bindings];
}

export function getRouteBindingsForResource(name: string): readonly RouteBinding[] {
  return bindings.filter(b => b.resourceName === name);
}

export function __resetRouteBindingsForTests(): void {
  bindings.length = 0;
}
