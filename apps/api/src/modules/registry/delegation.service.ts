import type { Manifest } from "./feed.service";
import type { AppDatabase } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { AppError } from "@/shared/lib/errors";
import { deriveKeyId, parsePublicKey } from "./key.service";
import { registryDelegations, registryKeys, registryRevocationLists } from "./schema";
import { delegationMessage, encodeBase64Url, revocationMessage, verifyEd25519 } from "./signature";

// lode's delegated signing: a registered key of the package (a root) lets a
// sub-key sign for it during a window, and a signed revocation list takes
// sub-keys out early. The registry checks both as lode does and serves them
// as the publisher sent them; it holds no private key.

export type Delegation = typeof registryDelegations.$inferSelect;
export type RevocationList = typeof registryRevocationLists.$inferSelect;

/**
 * Whether a stored delegation is in force:
 * - `live`: inside its window, its root active, its sub-key not revoked;
 * - `pending`: its window has not started;
 * - `expired`: its window has passed;
 * - `revoked`: its root key was revoked, or the revocation list names its sub-key.
 */
export type DelegationStatus = "live" | "pending" | "expired" | "revoked";

/** A delegation as `lode-cli delegate` writes it and the manifest carries it. */
export interface DelegationDocument {
  readonly key: string;
  readonly name: string;
  readonly not_before: number;
  readonly not_after: number;
  readonly issuer?: string | undefined;
  readonly sig: string;
}

/** A revocation list as `lode-cli revoke` writes it and the feed serves it. */
export interface RevocationListDocument {
  readonly schema: "lode-revocations/v1";
  readonly issued_at: number;
  readonly revoked: readonly string[];
  readonly key_id: string;
  readonly delegation?: DelegationDocument | undefined;
  readonly sig: string;
}

/** A key a signature of the package may verify under. */
export interface SigningKey {
  readonly keyId: string;
  readonly alg: "ed25519";
  /** Unpadded base64url. */
  readonly publicKey: string;
  /** The delegation's sub-key rather than a registered key. */
  readonly delegated: boolean;
}

// How far ahead of the server's clock a list may be issued: lode refuses
// every later list with an older `issued_at`, forever.
const MAX_ISSUED_AHEAD_SECONDS = 3600;

const unixNow = (now: number) => Math.floor(now / 1000);

async function activeRoots(db: AppDatabase, packageId: string): Promise<SigningKey[]> {
  const rows = await db
    .select()
    .from(registryKeys)
    .where(and(eq(registryKeys.packageId, packageId), eq(registryKeys.alg, "ed25519"), isNull(registryKeys.revokedAt)))
    .all();
  return rows.map(row => ({ keyId: row.keyId, alg: "ed25519", publicKey: row.publicKey, delegated: false }));
}

export async function findDelegation(db: AppDatabase, packageId: string): Promise<Delegation | undefined> {
  return await db.select().from(registryDelegations).where(eq(registryDelegations.packageId, packageId)).get();
}

export async function findRevocationList(db: AppDatabase, packageId: string): Promise<RevocationList | undefined> {
  return await db.select().from(registryRevocationLists).where(eq(registryRevocationLists.packageId, packageId)).get();
}

function revokedIds(list: RevocationList | undefined): Set<string> {
  return new Set(list ? JSON.parse(list.revoked) as string[] : []);
}

export async function delegationStatus(db: AppDatabase, delegation: Delegation, now = Date.now()): Promise<DelegationStatus> {
  const roots = await activeRoots(db, delegation.packageId);
  if (!roots.some(root => root.keyId === delegation.rootKeyId))
    return "revoked";
  if (revokedIds(await findRevocationList(db, delegation.packageId)).has(delegation.keyId))
    return "revoked";
  const seconds = unixNow(now);
  if (seconds < delegation.notBefore)
    return "pending";
  if (seconds >= delegation.notAfter)
    return "expired";
  return "live";
}

/** The package's delegation while it is live, else undefined. */
export async function liveDelegation(db: AppDatabase, packageId: string, now = Date.now()): Promise<Delegation | undefined> {
  const delegation = await findDelegation(db, packageId);
  return delegation && await delegationStatus(db, delegation, now) === "live" ? delegation : undefined;
}

/** The package's active registered keys, and the sub-key of its live delegation. */
export async function signingKeys(db: AppDatabase, packageId: string, now = Date.now()): Promise<SigningKey[]> {
  const keys = await activeRoots(db, packageId);
  const delegation = await liveDelegation(db, packageId, now);
  if (delegation)
    keys.push({ keyId: delegation.keyId, alg: "ed25519", publicKey: delegation.publicKey, delegated: true });
  return keys;
}

/** The first of `keys` the signature verifies under, trying `keyId`'s key first. */
async function verifyingKey(keys: readonly SigningKey[], keyId: string | undefined, sig: string, message: Uint8Array<ArrayBuffer>): Promise<SigningKey | undefined> {
  const ordered = [...keys.filter(key => key.keyId === keyId), ...keys.filter(key => key.keyId !== keyId)];
  for (const key of ordered) {
    if (await verifyEd25519(key.publicKey, sig, message))
      return key;
  }
  return undefined;
}

interface CheckedDelegation {
  readonly keyId: string;
  readonly publicKey: string;
  readonly rootKeyId: string;
}

/**
 * What lode checks of a delegation, except its window: scoped to `slug`, an
 * ed25519 sub-key, signed by one of `roots`. Returns why it fails as a string.
 */
async function checkDelegation(roots: readonly SigningKey[], slug: string, input: DelegationDocument): Promise<CheckedDelegation | string> {
  if (input.name !== slug)
    return `the delegation is for "${input.name}", not this package's slug "${slug}"`;
  let raw: Uint8Array;
  try {
    raw = parsePublicKey(input.key);
  }
  catch (err) {
    return `the delegated key is not usable: ${err instanceof Error ? err.message : String(err)}`;
  }
  const publicKey = encodeBase64Url(raw);
  const root = await verifyingKey(roots, input.issuer, input.sig, delegationMessage(input.name, publicKey, input.not_before, input.not_after));
  if (!root)
    return "the delegation is not signed by an active signing key of the package";
  return { keyId: await deriveKeyId(raw), publicKey, rootKeyId: root.keyId };
}

/**
 * Store the package's delegation, replacing an earlier one, once it verifies:
 * scoped to the slug, signed by an active registered key, not lapsed, its
 * sub-key neither revoked nor a registered key of the package.
 */
export async function putDelegation(db: AppDatabase, pkg: { id: string; slug: string }, input: DelegationDocument, now = Date.now()): Promise<Delegation> {
  if (input.not_before >= input.not_after)
    throw new AppError("not_before must come before not_after", 400, "INVALID_DELEGATION");
  if (input.not_after <= unixNow(now))
    throw new AppError("The delegation has already expired", 400, "DELEGATION_EXPIRED");
  const checked = await checkDelegation(await activeRoots(db, pkg.id), pkg.slug, input);
  if (typeof checked === "string")
    throw new AppError(checked, 400, "INVALID_DELEGATION");
  if (revokedIds(await findRevocationList(db, pkg.id)).has(checked.keyId))
    throw new AppError(`${checked.keyId} is on the package's revocation list`, 400, "KEY_REVOKED");
  const registered = await db.select().from(registryKeys).where(and(eq(registryKeys.packageId, pkg.id), eq(registryKeys.keyId, checked.keyId))).get();
  if (registered) {
    throw new AppError(
      `${checked.keyId} is ${registered.revokedAt === null ? "a registered" : "a revoked"} signing key of the package; delegate to a key of its own`,
      409,
      "KEY_REGISTERED",
    );
  }

  const row = {
    key: input.key,
    keyId: checked.keyId,
    publicKey: checked.publicKey,
    notBefore: input.not_before,
    notAfter: input.not_after,
    issuer: input.issuer ?? null,
    sig: input.sig,
    rootKeyId: checked.rootKeyId,
    updatedAt: new Date(now).toISOString(),
  };
  await db.insert(registryDelegations).values({ packageId: pkg.id, ...row }).onConflictDoUpdate({ target: registryDelegations.packageId, set: row }).run();
  return { packageId: pkg.id, ...row };
}

/** Drop the package's delegation; false when it had none. */
export async function deleteDelegation(db: AppDatabase, packageId: string): Promise<boolean> {
  if (!(await findDelegation(db, packageId)))
    return false;
  await db.delete(registryDelegations).where(eq(registryDelegations.packageId, packageId)).run();
  return true;
}

/** The stored delegation as lode reads it; its `name` is the package slug, checked when it was stored. */
export function delegationDocument(delegation: Delegation, slug: string): DelegationDocument {
  return {
    key: delegation.key,
    name: slug,
    not_before: delegation.notBefore,
    not_after: delegation.notAfter,
    ...(delegation.issuer !== null && { issuer: delegation.issuer }),
    sig: delegation.sig,
  };
}

/** `manifest` with the package's delegation while it is live; otherwise `manifest` as it is. */
export async function withDelegation(db: AppDatabase, pkg: { id: string; slug: string }, manifest: Manifest, now = Date.now()): Promise<Manifest> {
  const delegation = await liveDelegation(db, pkg.id, now);
  if (!delegation)
    return manifest;
  const { channels, versions, ...head } = manifest;
  return { ...head, delegation: delegationDocument(delegation, pkg.slug), channels, versions };
}

/**
 * Store the package's revocation list once it verifies as lode verifies it:
 * signed by an active registered key, or by a sub-key whose own delegation
 * is valid and not revoked. It must be newer than the stored list and keep
 * every id that list has, since hosts never drop one.
 */
export async function putRevocationList(db: AppDatabase, pkg: { id: string; slug: string }, input: RevocationListDocument, now = Date.now()): Promise<RevocationList> {
  const stored = await findRevocationList(db, pkg.id);
  const revoked = revokedIds(stored);
  if (stored && input.issued_at <= stored.issuedAt)
    throw new AppError(`issued_at must be later than the stored list's ${stored.issuedAt}`, 409, "REVOCATIONS_OUTDATED");
  if (input.issued_at > unixNow(now) + MAX_ISSUED_AHEAD_SECONDS)
    throw new AppError("issued_at lies in the future", 400, "REVOCATIONS_FUTURE");
  const dropped = [...revoked].filter(id => !input.revoked.includes(id));
  if (dropped.length > 0)
    throw new AppError(`The list drops revoked ids: ${dropped.join(", ")}`, 400, "REVOCATIONS_SHRINK");

  const keys = await activeRoots(db, pkg.id);
  let rejected: string | undefined;
  if (input.delegation) {
    const checked = await checkDelegation(keys, pkg.slug, input.delegation);
    const seconds = unixNow(now);
    if (typeof checked === "string")
      rejected = checked;
    else if (seconds < input.delegation.not_before || seconds >= input.delegation.not_after)
      rejected = "the delegation is outside its validity window";
    else if (revoked.has(checked.keyId))
      rejected = `the delegated key ${checked.keyId} is revoked`;
    else
      keys.push({ keyId: checked.keyId, alg: "ed25519", publicKey: checked.publicKey, delegated: true });
  }
  if (!(await verifyingKey(keys, input.key_id, input.sig, revocationMessage(input.key_id, input.issued_at, input.revoked)))) {
    throw new AppError(
      `The revocation list does not verify under an active signing key of the package${rejected ? ` (delegation rejected: ${rejected})` : ""}`,
      400,
      "INVALID_SIGNATURE",
    );
  }

  const row = {
    issuedAt: input.issued_at,
    revoked: JSON.stringify(input.revoked),
    keyId: input.key_id,
    delegation: input.delegation ? JSON.stringify(input.delegation) : null,
    sig: input.sig,
    updatedAt: new Date(now).toISOString(),
  };
  await db.insert(registryRevocationLists).values({ packageId: pkg.id, ...row }).onConflictDoUpdate({ target: registryRevocationLists.packageId, set: row }).run();
  return { packageId: pkg.id, ...row };
}

export function revocationListDocument(list: RevocationList): RevocationListDocument {
  return {
    schema: "lode-revocations/v1",
    issued_at: list.issuedAt,
    revoked: JSON.parse(list.revoked) as string[],
    key_id: list.keyId,
    ...(list.delegation !== null && { delegation: JSON.parse(list.delegation) as DelegationDocument }),
    sig: list.sig,
  };
}
