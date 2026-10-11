/**
 * Scopes for personal API tokens. A module registers each scope with the
 * routes it opens; a token reaches a route only when one of its scopes lists
 * that route, so everything unlisted — token management included — is closed
 * to tokens by default.
 *
 * Paths are relative to `/api`. `:name` matches one segment; a trailing `*`
 * matches one or more segments.
 */

export type TokenScopeMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface TokenScopeRoute {
  readonly method: TokenScopeMethod;
  readonly path: string;
}

export interface TokenScopeDefinition {
  /** `<area>:<access>`, e.g. `issues:read`. */
  readonly name: string;
  readonly description: string;
  readonly routes: readonly TokenScopeRoute[];
}

interface CompiledScope {
  readonly definition: TokenScopeDefinition;
  readonly routes: readonly { readonly method: string; readonly regex: RegExp }[];
}

const RE_SCOPE_NAME = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/;
const RE_REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

let scopes = new Map<string, CompiledScope>();

function compile(path: string): RegExp {
  const segments = path.split("/").filter(Boolean).map((segment, i, all) => {
    if (segment === "*" && i === all.length - 1)
      return "[^/]+(?:/[^/]+)*";
    if (segment.startsWith(":"))
      return "[^/]+";
    return segment.replace(RE_REGEX_SPECIAL, "\\$&");
  });
  return new RegExp(`^/${segments.join("/")}$`);
}

export function registerTokenScope(definition: TokenScopeDefinition): void {
  if (!RE_SCOPE_NAME.test(definition.name))
    throw new Error(`[token-scopes] "${definition.name}" is not a valid scope name (<area>:<access>)`);
  if (scopes.has(definition.name))
    throw new Error(`[token-scopes] scope "${definition.name}" is already registered`);
  scopes.set(definition.name, {
    definition,
    routes: definition.routes.map(r => ({ method: r.method, regex: compile(r.path) })),
  });
}

/** Registered scopes, for the token UI. */
export function getTokenScopes(): { name: string; description: string }[] {
  return [...scopes.values()].map(({ definition }) => ({ name: definition.name, description: definition.description }));
}

export function isTokenScope(name: string): boolean {
  return scopes.has(name);
}

/** Whether a token holding `granted` may call `method apiPath` (`apiPath` relative to `/api`). */
export function tokenScopesAllow(granted: readonly string[], method: string, apiPath: string): boolean {
  return granted.some(name => scopes.get(name)?.routes.some(r => r.method === method && r.regex.test(apiPath)) === true);
}

/** Test hook: start from an empty registry, returning a function that puts the old one back. */
export function __isolateTokenScopesForTests(): () => void {
  const saved = scopes;
  scopes = new Map();
  return () => {
    scopes = saved;
  };
}
