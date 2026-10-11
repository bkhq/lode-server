import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { Buffer } from "node:buffer";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { DIRECT_MEMBER, groupMembers, groups } from "./schema";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

// Mirrors the limit on a group name created through the API.
const MAX_GROUP_NAME = 100;
// A claim is attacker-influenced only as far as the IdP is, but a runaway
// directory sync should still not create thousands of groups per login.
const MAX_GROUPS_PER_LOGIN = 200;

function payloadOf(idToken: string | undefined): Record<string, unknown> {
  const part = idToken?.split(".")[1];
  if (!part)
    return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf-8")) as Record<string, unknown>;
  }
  catch {
    return {};
  }
}

/**
 * The group names the IdP asserts for the user, from `claim` in userinfo or,
 * failing that, the id_token. A single string counts as one group. Returns
 * undefined when neither carries the claim — usually a scope the client did
 * not request — so the caller can leave memberships alone rather than read
 * the absence as "member of nothing". An empty array is an empty set.
 */
export function readGroupsClaim(
  claim: string,
  userInfo: Record<string, unknown>,
  idToken: string | undefined,
): string[] | undefined {
  const raw = userInfo[claim] ?? payloadOf(idToken)[claim];
  if (raw === undefined || raw === null)
    return undefined;
  const values = Array.isArray(raw) ? raw : [raw];
  const names = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string")
      continue;
    const name = value.trim();
    if (name !== "" && name.length <= MAX_GROUP_NAME)
      names.add(name);
  }
  return [...names].slice(0, MAX_GROUPS_PER_LOGIN);
}

/**
 * Make the user's IdP-managed group memberships match `names`: create any
 * group that does not exist yet (as `idp`), add the user to each, and remove
 * them from every `idp` group not listed. Local groups are never joined or
 * left — a local group whose name the IdP claims is skipped with a warning,
 * since joining it would let the IdP grant whatever an admin gave that group.
 */
export async function syncIdpGroups(
  db: AppDatabase,
  userId: string,
  names: readonly string[],
  logger: Logger,
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date().toISOString();
    const existing = names.length === 0
      ? []
      : await tx.select().from(groups).where(inArray(groups.name, [...names])).all();
    const byName = new Map(existing.map(g => [g.name, g]));

    const wanted: string[] = [];
    for (const name of names) {
      const group = byName.get(name);
      if (group === undefined) {
        const id = nanoid();
        await tx.insert(groups).values({ id, name, source: "idp", createdAt: now, updatedAt: now }).run();
        wanted.push(id);
      }
      else if (group.source === "idp") {
        wanted.push(group.id);
      }
      else {
        logger.warn({ group: name, userId }, "IdP groups claim names a local group; membership not synced");
      }
    }

    const idpGroupIds = tx.select({ id: groups.id }).from(groups).where(eq(groups.source, "idp"));
    const userRows = and(
      eq(groupMembers.subjectNamespace, "user"),
      eq(groupMembers.subjectId, userId),
      eq(groupMembers.subjectRelation, DIRECT_MEMBER),
    );
    await tx.delete(groupMembers)
      .where(and(
        userRows,
        inArray(groupMembers.groupId, idpGroupIds),
        wanted.length === 0 ? undefined : notInArray(groupMembers.groupId, wanted),
      ))
      .run();

    for (const groupId of wanted) {
      await tx.insert(groupMembers)
        .values({ id: nanoid(), groupId, subjectNamespace: "user", subjectId: userId, subjectRelation: DIRECT_MEMBER, createdBy: userId, createdAt: now })
        .onConflictDoNothing()
        .run();
    }
  });
}

/**
 * Called at OIDC login. With `claim` unset (OAUTH_GROUPS_CLAIM) groups are
 * not managed by the IdP and nothing happens. A configured claim missing
 * from the tokens leaves memberships as they are and logs a warning.
 */
export async function applyIdpGroups(
  db: AppDatabase,
  args: {
    readonly claim: string | undefined;
    readonly userId: string;
    readonly userInfo: Record<string, unknown>;
    readonly idToken: string | undefined;
    readonly logger: Logger;
  },
): Promise<void> {
  if (args.claim === undefined)
    return;
  const names = readGroupsClaim(args.claim, args.userInfo, args.idToken);
  if (names === undefined) {
    args.logger.warn({ claim: args.claim, userId: args.userId }, "IdP sent no groups claim; group memberships left unchanged");
    return;
  }
  await syncIdpGroups(db, args.userId, names, args.logger);
}
