import type { Context } from "hono";
import type { AppDatabase } from "@/db";
import type { AppEnv, User } from "@/shared/lib/types";
import { ForbiddenError } from "@/shared/lib/errors";
import { tokenScopesAllow } from "@/shared/lib/token-scopes";
import { resolveApiToken, TOKEN_PREFIX } from "./tokens.service";

/**
 * Auth provider for personal API tokens (`Authorization: Bearer pat_…`).
 *
 * Returns undefined for any other credential, and for a token that is
 * unknown or expired — the request is then unauthenticated. A valid token
 * used on a route none of its scopes lists fails the request with 403, which
 * is what makes token access deny-by-default.
 */
export async function apiTokenAuthProvider(db: AppDatabase, c: Context<AppEnv>): Promise<User | undefined> {
  const header = c.req.header("authorization");
  if (!header?.startsWith(`Bearer ${TOKEN_PREFIX}`))
    return undefined;

  const resolved = await resolveApiToken(db, header.slice("Bearer ".length).trim());
  if (!resolved)
    return undefined;

  // Scope routes are relative to /api; nothing outside it is open to tokens.
  const apiBase = `${c.get("config").BASE_PATH}/api`;
  const underApi = c.req.path.startsWith(`${apiBase}/`);
  if (!underApi || !tokenScopesAllow(resolved.scopes, c.req.method, c.req.path.slice(apiBase.length)))
    throw new ForbiddenError("This API token's scopes do not cover this route");
  return resolved.user;
}
