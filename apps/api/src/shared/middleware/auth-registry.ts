import type { Context } from "hono";
import type { AppDatabase } from "@/db";
import type { AppEnv, User } from "@/shared/lib/types";

/**
 * AuthProvider resolves the authenticated user for a request, or returns
 * undefined if the request carries no credential it recognises.
 *
 * Providers are registered by modules (the session provider by
 * `apps/api/src/modules/account/index.ts`) so that the shared middleware can
 * stay free of imports from them (avoids a layering cycle).
 */
export type AuthProvider = (db: AppDatabase, c: Context<AppEnv>) => Promise<User | undefined>;

const providers: AuthProvider[] = [];

/**
 * Add a provider to the chain. Providers are asked in registration order and
 * the first to return a user wins, so each one should return undefined for a
 * request whose credential is not its own. A provider that throws fails the
 * request — it is not skipped.
 *
 * Registering the same function again is a no-op. Returns a function that
 * removes the provider.
 */
export function registerAuthProvider(p: AuthProvider): () => void {
  if (!providers.includes(p))
    providers.push(p);
  return () => {
    const i = providers.indexOf(p);
    if (i !== -1)
      providers.splice(i, 1);
  };
}

async function chain(db: AppDatabase, c: Context<AppEnv>): Promise<User | undefined> {
  for (const provider of providers) {
    const user = await provider(db, c);
    if (user)
      return user;
  }
  return undefined;
}

/** The registered providers, as one provider that walks the chain. */
export function getAuthProvider(): AuthProvider {
  if (providers.length === 0) {
    throw new Error("AuthProvider not registered — ensure account module is loaded before auth middleware runs");
  }
  return chain;
}

/** Test hook: swap the chain out, returning a function that puts it back. */
export function __isolateAuthProvidersForTests(): () => void {
  const saved = providers.splice(0);
  return () => {
    providers.splice(0, providers.length, ...saved);
  };
}
