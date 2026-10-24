import type { AppDatabase } from "@/db";
import type { User } from "@/shared/lib/types";
import { Buffer } from "node:buffer";
import { and, count, eq } from "drizzle-orm";
import { users } from "@/modules/account/users/schema";
import { AppError } from "@/shared/lib/errors";
import { nanoid } from "@/shared/lib/id";
import { apiTokens } from "./schema";

export const TOKEN_PREFIX = "pat_";
const MAX_TOKENS_PER_USER = 50;
// Writing last_used_at on every call would make each token request a write;
// once a minute is as precise as the UI needs.
const LAST_USED_RESOLUTION_MS = 60_000;

export interface ApiTokenRecord {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: string[];
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

function toRecord(row: typeof apiTokens.$inferSelect): ApiTokenRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: JSON.parse(row.scopes) as string[],
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

async function newSecret(): Promise<{ token: string; prefix: string; tokenHash: string }> {
  const token = `${TOKEN_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  return {
    token,
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
    tokenHash: await sha256Hex(token),
  };
}

/** Create a token for `userId`. The returned `token` is the only copy of the secret. */
export async function createApiToken(
  db: AppDatabase,
  userId: string,
  input: { readonly name: string; readonly scopes: readonly string[]; readonly expiresAt: string | null },
): Promise<{ token: string; record: ApiTokenRecord }> {
  const held = await db.select({
    n: count(),
  }).from(apiTokens).where(eq(apiTokens.userId, userId)).get();
  if ((held?.n ?? 0) >= MAX_TOKENS_PER_USER)
    throw new AppError(`A user can hold at most ${MAX_TOKENS_PER_USER} API tokens`, 409, "TOKEN_LIMIT");

  const { token, prefix, tokenHash } = await newSecret();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id,
    userId,
    name: input.name,
    prefix,
    tokenHash,
    scopes: JSON.stringify([
      ...new Set(input.scopes),
    ]),
    expiresAt: input.expiresAt,
    createdAt: new Date().toISOString(),
  }).run();
  const row = (await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get())!;
  return {
    token,
    record: toRecord(row),
  };
}

export async function listApiTokens(db: AppDatabase, userId: string): Promise<ApiTokenRecord[]> {
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, userId)).all();
  return rows.map(toRecord);
}

/**
 * Rename or rescope one of `userId`'s tokens, returning it before and after;
 * undefined when there is no such token of theirs. The secret is unchanged,
 * and new scopes apply from the token's next request.
 */
export async function updateApiToken(
  db: AppDatabase,
  userId: string,
  id: string,
  input: { readonly name?: string | undefined; readonly scopes?: readonly string[] | undefined },
): Promise<{ before: ApiTokenRecord; after: ApiTokenRecord } | undefined> {
  const mine = and(eq(apiTokens.id, id), eq(apiTokens.userId, userId));
  const row = await db.select().from(apiTokens).where(mine).get();
  if (!row)
    return undefined;
  const patch: Partial<typeof apiTokens.$inferInsert> = {};
  if (input.name !== undefined)
    patch.name = input.name;
  if (input.scopes !== undefined) {
    patch.scopes = JSON.stringify([
      ...new Set(input.scopes),
    ]);
  }
  const [updated] = await db.update(apiTokens).set(patch).where(mine).returning();
  return updated
    ? {
        before: toRecord(row),
        after: toRecord(updated),
      }
    : undefined;
}

/**
 * Give one of `userId`'s tokens a new secret, returned once like at
 * creation; undefined when there is no such token of theirs. The old secret
 * stops working at once. Name and scopes are kept; the expiry is set anew
 * and the last-used time cleared, as for a fresh token.
 */
export async function rotateApiToken(
  db: AppDatabase,
  userId: string,
  id: string,
  expiresAt: string | null,
): Promise<{ token: string; record: ApiTokenRecord } | undefined> {
  const { token, prefix, tokenHash } = await newSecret();
  const [row] = await db.update(apiTokens)
    .set({
      prefix,
      tokenHash,
      expiresAt,
      lastUsedAt: null,
    })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
    .returning();
  return row
    ? {
        token,
        record: toRecord(row),
      }
    : undefined;
}

/** Delete one of `userId`'s tokens, returning it; undefined when there is no such token of theirs. */
export async function deleteApiToken(db: AppDatabase, userId: string, id: string): Promise<ApiTokenRecord | undefined> {
  const mine = and(eq(apiTokens.id, id), eq(apiTokens.userId, userId));
  const row = await db.select().from(apiTokens).where(mine).get();
  if (!row)
    return undefined;
  await db.delete(apiTokens).where(mine).run();
  return toRecord(row);
}

/**
 * The live token and its active user, or undefined when the token is
 * unknown, expired, or belongs to a disabled user.
 */
export async function resolveApiToken(db: AppDatabase, token: string): Promise<{ user: User; scopes: string[] } | undefined> {
  const row = await db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, await sha256Hex(token)))
    .get();
  if (!row || row.user.status !== "active")
    return undefined;
  const now = Date.now();
  if (row.token.expiresAt !== null && Date.parse(row.token.expiresAt) <= now)
    return undefined;
  if (row.token.lastUsedAt === null || now - Date.parse(row.token.lastUsedAt) >= LAST_USED_RESOLUTION_MS) {
    await db.update(apiTokens).set({
      lastUsedAt: new Date(now).toISOString(),
    }).where(eq(apiTokens.id, row.token.id)).run();
  }
  return {
    user: row.user,
    scopes: JSON.parse(row.token.scopes) as string[],
  };
}
