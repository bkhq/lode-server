import type { Context } from "hono";
import type { AppDatabase } from "@/db";
import type { AppEnv, User } from "@/shared/lib/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { __isolateAuthProvidersForTests, getAuthProvider, registerAuthProvider } from "./auth-registry";

const db = {} as AppDatabase;
const c = {} as Context<AppEnv>;
const userNamed = (id: string) => ({ id }) as unknown as User;

const cleanups: (() => void)[] = [];
function register(...args: Parameters<typeof registerAuthProvider>): void {
  cleanups.push(registerAuthProvider(...args));
}

// The account module registers the session provider on import, and other
// test files may have loaded it; run each test against an empty chain.
let restore: () => void;
beforeEach(() => {
  restore = __isolateAuthProvidersForTests();
});

afterEach(() => {
  for (const undo of cleanups.splice(0).reverse())
    undo();
  restore();
});

describe("auth provider chain", () => {
  test("a second provider adds to the chain instead of replacing the first", async () => {
    // Each provider only knows its own credential: a session provider and a
    // token provider must both keep working once both are registered.
    register(async (_db, ctx) => (ctx as unknown as { cred?: string }).cred === "session" ? userNamed("by-session") : undefined);
    register(async (_db, ctx) => (ctx as unknown as { cred?: string }).cred === "token" ? userNamed("by-token") : undefined);

    const provider = getAuthProvider();
    expect((await provider(db, { cred: "session" } as unknown as Context<AppEnv>))?.id).toBe("by-session");
    expect((await provider(db, { cred: "token" } as unknown as Context<AppEnv>))?.id).toBe("by-token");
    expect(await provider(db, { cred: "none" } as unknown as Context<AppEnv>)).toBeUndefined();
  });

  test("providers are asked in registration order and the first user wins", async () => {
    const asked: string[] = [];
    register(async () => {
      asked.push("a");
      return userNamed("a");
    });
    register(async () => {
      asked.push("b");
      return userNamed("b");
    });
    expect((await getAuthProvider()(db, c))?.id).toBe("a");
    expect(asked).toEqual(["a"]);
  });

  test("a provider that throws fails the request instead of falling through to the next", async () => {
    register(async () => {
      throw new Error("session store down");
    });
    register(async () => userNamed("fallback"));
    await expect(getAuthProvider()(db, c)).rejects.toThrow("session store down");
  });

  test("registering the same provider twice asks it once", async () => {
    let calls = 0;
    const p = async () => {
      calls++;
      return undefined;
    };
    register(p);
    register(p);
    await getAuthProvider()(db, c);
    expect(calls).toBe(1);
  });

  test("the returned function unregisters the provider", async () => {
    const undo = registerAuthProvider(async () => userNamed("temp"));
    expect((await getAuthProvider()(db, c))?.id).toBe("temp");
    undo();
    expect(() => getAuthProvider()).toThrow("not registered");
  });
});
