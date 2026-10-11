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

/** Create a token for `userId`. The returned `token` is the only copy of the secret. */
export async function createApiToken(
  db: AppDatabase,
  userId: string,
  input: { readonly name: string; readonly scopes: readonly string[]; readonly expiresAt: string | null },
): Promise<{ token: string; record: ApiTokenRecord }> {
  const held = await db.select({ n: count() }).from(apiTokens).where(eq(apiTokens.userId, userId)).get();
  if ((held?.n ?? 0) >= MAX_TOKENS_PER_USER)
    throw new AppError(`A user can hold at most ${MAX_TOKENS_PER_USER} API tokens`, 409, "TOKEN_LIMIT");

  const token = `${TOKEN_PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  const id = nanoid();
  await db.insert(apiTokens).values({
    id,
    userId,
    name: input.name,
    prefix: token.slice(0, TOKEN_PREFIX.length + 6),
    tokenHash: await sha256Hex(token),
    scopes: JSON.stringify([...new Set(input.scopes)]),
    expiresAt: input.expiresAt,
    createdAt: new Date().toISOString(),
  }).run();
  const row = (await db.select().from(apiTokens).where(eq(apiTokens.id, id)).get())!;
  return { token, record: toRecord(row) };
}

export async function listApiTokens(db: AppDatabase, userId: string): Promise<ApiTokenRecord[]> {
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, userId)).all();
  return rows.map(toRecord);
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
    await db.update(apiTokens).set({ lastUsedAt: new Date(now).toISOString() }).where(eq(apiTokens.id, row.token.id)).run();
  }
  return { user: row.user, scopes: JSON.parse(row.token.scopes) as string[] };
}
