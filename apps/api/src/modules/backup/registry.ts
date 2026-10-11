import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableName } from "drizzle-orm";

/**
 * Description of a single logical "data module" — the unit that the backup
 * UI exposes to operators (one checkbox each). Modules register their own
 * contribution via `registerBackupContribution()` from their `index.ts`,
 * which keeps `apps/api/src/modules/backup/` from owning a central list of
 * everyone else's tables.
 *
 * - `name`: stable identifier that ends up in `backupData.modules` and in
 *   the `/api/backup/modules` response. Renaming breaks compatibility with
 *   existing backup files.
 * - `tables`: every table the module wants exported / restored. Order
 *   determines the per-module insert order; combined with the topological
 *   `deps` walk, the global insert order respects foreign keys.
 * - `deps`: names of other modules whose tables must come before this one
 *   on insert (and after on delete). String-based so registration is order-
 *   independent and free of import cycles.
 */
export interface BackupContribution {
  readonly name: string;
  readonly tables: readonly SQLiteTable[];
  readonly deps: readonly string[];
}

const contributions = new Map<string, BackupContribution>();

export function registerBackupContribution(c: BackupContribution): void {
  // Idempotent: re-importing a module index during dev HMR / test reruns
  // must not double-register tables. Last write wins so the most recent
  // module-load result is the source of truth.
  contributions.set(c.name, c);
}

/** Test-only helper. Production never clears the registry. */
export function __resetBackupRegistryForTests(): void {
  contributions.clear();
}

export function getDataModules(): Record<string, BackupContribution> {
  return Object.fromEntries(contributions);
}

/** Sorted alphabetically so the `/api/backup/modules` payload is stable. */
export function getModuleNames(): readonly string[] {
  return [...contributions.keys()].sort();
}

/**
 * Topologically expand `selected` to include every transitive dependency.
 * Order in the result is dependency-first, so the same array can be used
 * for inserts; reverse for deletes.
 */
export function resolveModulesWithDeps(selected: readonly string[]): string[] {
  const resolved = new Set<string>();

  function visit(name: string): void {
    if (resolved.has(name))
      return;
    const mod = contributions.get(name);
    if (!mod)
      return;
    for (const dep of mod.deps)
      visit(dep);
    resolved.add(name);
  }

  for (const name of selected)
    visit(name);

  return [...resolved];
}

/** Flatten the resolved module list into a deduplicated, ordered table list. */
export function getTablesForModules(modules: readonly string[]): SQLiteTable[] {
  const tables: SQLiteTable[] = [];
  const seen = new Set<string>();

  for (const mod of modules) {
    const def = contributions.get(mod);
    if (!def)
      continue;
    for (const table of def.tables) {
      const tableName = getTableName(table);
      if (!seen.has(tableName)) {
        seen.add(tableName);
        tables.push(table);
      }
    }
  }

  return tables;
}
