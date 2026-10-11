import type { fileReferences } from "./schema";
import type { AppDatabase } from "@/db";

export type FileReferenceRow = typeof fileReferences.$inferSelect;

export interface FilePermissionActor {
  readonly id: string;
  readonly role: string;
}

/**
 * Consumer-provided permission decisions for one `owner_type`.
 *
 * The file module does not know what an item / avatar / signature is —
 * sub-types register a hook so the file routes can ask "can this actor
 * read / delete the thing this reference is attached to?". Each consumer
 * registers exactly one hook at module-load time via
 * {@link registerFilePermissionHook}.
 *
 * Both methods return `true` to allow and `false` to deny. They run
 * inside the file routes and inside `FileService.releaseReference`'s
 * downstream callers — never inside `FileService` itself, which stays
 * permission-agnostic.
 */
export interface FilePermissionHook {
  canRead: (db: AppDatabase, actor: FilePermissionActor, ref: FileReferenceRow) => Promise<boolean>;
  canDelete: (db: AppDatabase, actor: FilePermissionActor, ref: FileReferenceRow) => Promise<boolean>;
}

const hooks = new Map<string, FilePermissionHook>();

export function registerFilePermissionHook(ownerType: string, hook: FilePermissionHook): void {
  hooks.set(ownerType, hook);
}

/** Test-only: clear hook registrations between cases. */
export function __resetFilePermissionHooksForTests(): void {
  hooks.clear();
}

/**
 * Look up the hook for a given owner_type. Returns `undefined` when no
 * consumer has registered one — callers must treat that as "deny" (the
 * file routes return 404 so the existence of an unclaimed owner_type is
 * not leaked).
 */
export function getFilePermissionHook(ownerType: string): FilePermissionHook | undefined {
  return hooks.get(ownerType);
}

/** Sorted list of registered owner_types. Diagnostic + test helper. */
export function listRegisteredOwnerTypes(): readonly string[] {
  return [...hooks.keys()].sort();
}
