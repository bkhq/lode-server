/**
 * Backup RESTORE — table rows only.
 *
 * SCOPE CAVEAT: file blob bytes are **out of backup scope** (see the header
 * of `export.service.ts`). A backup never carries the objects behind
 * `files` rows; it only replays the rows. After a restore onto a
 * deployment whose storage backend does not already hold those blobs, the
 * `files` / `file_references` rows would point at absent objects and every
 * download would 500.
 *
 * {@link reconcileRestoredFiles} runs post-restore: it asks the active
 * storage driver whether each restored `files` blob actually exists and
 * **quarantines** (does not delete) the rows whose backing object is gone,
 * so a restored deployment fails loudly/visibly (a clean 404 on download
 * via the existing `FILE_BACKEND_MISMATCH` path) instead of 500ing — and
 * the operator keeps the row for diagnosis.
 */
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { BackupData } from "./export.service";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { getActiveDriver } from "@/modules/file/storage/registry";
import { AppError } from "@/shared/lib/errors";
import { CURRENT_BACKUP_VERSION } from "./export.service";
import { getDataModules, resolveModulesWithDeps } from "./registry";

/**
 * Sentinel written into `files.storage_driver` for a quarantined row. It
 * can never equal a real driver name, so `buildDownloadResponse`'s
 * `driver.name !== file.storage_driver` guard turns every download attempt
 * into the existing clean `404 FILE_BACKEND_MISMATCH` instead of a 500 — and
 * the unreferenced-files GC's identical guard refuses to touch the row, so
 * the quarantine is non-destructive.
 */
const QUARANTINE_DRIVER = "quarantined:backup-restore-missing-blob";

export interface ReconcileResult {
  /** `files` rows inspected (those still on a real, active driver). */
  readonly checked: number;
  /** `files` rows quarantined because their blob was absent on the backend. */
  readonly quarantined: number;
}

const MAX_FILE_SIZE = 50 * 1024 * 1024;

const INSERT_BATCH_SIZE = 500;

/**
 * Hard caps to bound an admin-supplied backup. A 50 MB JSON can otherwise
 * contain millions of rows of one table; a single SQLite transaction holding
 * that long would lock writes process-wide. The numbers are conservative —
 * legitimate exports for the use cases this template targets stay well below.
 */
const MAX_TOTAL_ROWS = 1_000_000;
const MAX_ROWS_PER_TABLE = 500_000;
const MAX_STRING_LENGTH = 1_000_000;
const MAX_OBJECT_DEPTH = 16;

type BackupMigrator = (data: BackupData) => BackupData;

/**
 * v1 → v2: `relation_tuples.subjectRelation` became NOT NULL with the
 * empty-string sentinel for direct subjects, and resource-group identity
 * moved out of `__meta__` tuples into the `resource_groups` table.
 */
const migrateV1ToV2: BackupMigrator = (data) => {
  const tuples = data.tables.relation_tuples;
  if (!tuples)
    return { ...data, version: 2 };

  const lifted: Record<string, unknown>[] = [];
  const kept: Record<string, unknown>[] = [];
  for (const row of tuples) {
    if (row.namespace === "resource_group" && row.relation === "__meta__") {
      lifted.push({
        id: row.objectId,
        name: row.subjectId,
        description: row.subjectRelation ?? null,
        createdBy: row.createdBy ?? null,
        createdAt: row.createdAt,
      });
      continue;
    }
    kept.push({ ...row, subjectRelation: row.subjectRelation ?? "" });
  }

  const tables: BackupData["tables"] = { ...data.tables, relation_tuples: kept };
  if (lifted.length > 0)
    tables.resource_groups = [...(tables.resource_groups ?? []), ...lifted];
  return { ...data, version: 2, tables };
};

/**
 * Forward-version migrators: index N-1 transforms version N into N+1.
 * Never break old backups outright.
 */
/** v2 → v3: `group_members.subjectRelation` became NOT NULL with the empty-string sentinel. */
const migrateV2ToV3: BackupMigrator = (data) => {
  const rows = data.tables.group_members;
  if (!rows)
    return { ...data, version: 3 };
  return {
    ...data,
    version: 3,
    tables: { ...data.tables, group_members: rows.map(r => ({ ...r, subjectRelation: r.subjectRelation ?? "" })) },
  };
};

const MIGRATIONS: ReadonlyArray<BackupMigrator> = [migrateV1ToV2, migrateV2ToV3];

/**
 * Walk a parsed JSON tree and reject pathological shapes (unbounded
 * recursion / megabyte strings) before we hand the rows to drizzle.
 */
function assertSane(value: unknown, depth = 0): void {
  if (depth > MAX_OBJECT_DEPTH) {
    throw new AppError("Backup nesting too deep", 400, "INVALID_BACKUP_ROW");
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH)
      throw new AppError("Backup contains an oversized string field", 400, "INVALID_BACKUP_ROW");
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) assertSane(v, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) assertSane(v, depth + 1);
  }
}

// Identifier alphabet covers nanoid (8 chars) and session ids (64-char hex).
// Both are URL-safe / base62-style. Reject anything carrying control chars,
// path separators, or quotes.
const RE_SAFE_ID = /^[\w-]{1,128}$/;

/**
 * Validate id-like fields (where present) match the URL-safe id alphabet
 * so a malicious backup cannot smuggle SQL-meta or path-traversal payloads
 * through `id` / FK columns that we later interpolate into filesystem
 * paths or audit messages.
 */
function assertIdShape(row: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined || typeof v !== "string")
      continue;
    if (k === "id" || k.endsWith("Id") || k.endsWith("_id")) {
      if (!RE_SAFE_ID.test(v))
        throw new AppError(`Invalid id format on field ${k}`, 400, "INVALID_BACKUP_ROW");
    }
  }
}

export function validateBackupData(data: unknown): BackupData {
  if (!data || typeof data !== "object") {
    throw new AppError("Invalid backup file format", 400, "INVALID_FORMAT");
  }

  const obj = data as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : 0;

  if (version <= 0 || !Number.isFinite(version)) {
    throw new AppError("Invalid backup version", 400, "UNSUPPORTED_VERSION");
  }
  if (version > CURRENT_BACKUP_VERSION) {
    throw new AppError(
      `Backup version ${version} is newer than this build supports (max ${CURRENT_BACKUP_VERSION}). Upgrade the server before restoring.`,
      400,
      "UNSUPPORTED_VERSION",
    );
  }

  if (!Array.isArray(obj.modules) || obj.modules.length === 0) {
    throw new AppError("Backup file contains no modules", 400, "NO_MODULES");
  }

  if (!obj.tables || typeof obj.tables !== "object") {
    throw new AppError("Backup file contains no table data", 400, "NO_TABLES");
  }

  // Run forward migrations one at a time so old backups do not break when
  // the schema evolves. The list is empty in v1 — chain entries land here
  // on version-2 ship.
  //
  // `unknown` first, then `BackupData`: the four checks above prove
  // `obj.version` is a finite positive integer, `obj.modules` is a
  // non-empty array, and `obj.tables` is an object. Per-row inspection
  // happens after the migration chain via `assertSane(current.tables)`
  // and the row-count caps that follow. TypeScript can't narrow the
  // generic Record without that runtime work, so the assertion is the
  // bridge between validated shape and typed code.
  let current: BackupData = obj as unknown as BackupData;
  for (let v = version; v < CURRENT_BACKUP_VERSION; v++) {
    const m = MIGRATIONS[v - 1];
    if (!m)
      throw new AppError(`Missing migrator for backup v${v} → v${v + 1}`, 500, "MIGRATOR_MISSING");
    current = m(current);
  }

  // Pathological-shape rejection AFTER migration so the migrator can rely
  // on bounded input.
  assertSane(current.tables);

  // Row-count caps.
  let total = 0;
  for (const [table, rows] of Object.entries(current.tables)) {
    if (!Array.isArray(rows))
      throw new AppError(`Invalid table payload for ${table}`, 400, "INVALID_BACKUP_ROW");
    if (rows.length > MAX_ROWS_PER_TABLE)
      throw new AppError(`Table ${table} exceeds ${MAX_ROWS_PER_TABLE}-row cap`, 400, "INVALID_BACKUP_ROW");
    total += rows.length;
  }
  if (total > MAX_TOTAL_ROWS)
    throw new AppError(`Backup exceeds ${MAX_TOTAL_ROWS}-row cap`, 400, "INVALID_BACKUP_ROW");

  return current;
}

export function validateFileSize(size: number): void {
  if (size > MAX_FILE_SIZE) {
    throw new AppError(`File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`, 400, "FILE_TOO_LARGE");
  }
}

function getDeleteOrder(modules: string[]): SQLiteTable[] {
  const tables: SQLiteTable[] = [];
  const resolved = resolveModulesWithDeps(modules);
  const registry = getDataModules();

  for (const modName of [...resolved].reverse()) {
    const mod = registry[modName];
    if (!mod)
      continue;
    for (const table of [...mod.tables].reverse()) {
      tables.push(table);
    }
  }

  return tables;
}

function getInsertOrder(modules: string[]): SQLiteTable[] {
  const tables: SQLiteTable[] = [];
  const resolved = resolveModulesWithDeps(modules);
  const registry = getDataModules();

  for (const modName of resolved) {
    const mod = registry[modName];
    if (!mod)
      continue;
    for (const table of mod.tables) {
      tables.push(table);
    }
  }

  return tables;
}

/**
 * Validate that every key in `row` is a known column on `table`. Drops the
 * row entirely if a foreign key is present that the schema does not expect.
 */
function validateRowShape(table: SQLiteTable, tableName: string, row: Record<string, unknown>): void {
  const allowed = new Set(Object.keys(getTableColumns(table)));
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) {
      throw new AppError(`Invalid row in ${tableName}`, 400, "INVALID_BACKUP_ROW");
    }
  }
}

/**
 * Post-restore reconciliation for the blob-out-of-scope caveat.
 *
 * Walks every `files` row whose `storage_driver` matches the active driver
 * and asks the driver whether the backing object exists. Rows whose blob is
 * absent are **quarantined** — `storage_driver` is rewritten to
 * {@link QUARANTINE_DRIVER} and `ref_count` is zeroed — not deleted: the row
 * survives for operator diagnosis, every download deterministically returns
 * the existing clean `404 FILE_BACKEND_MISMATCH`, and the unreferenced-files
 * GC skips it (its `driver.name !== storage_driver` guard).
 *
 * Rows already on a different/inactive driver are left untouched (the same
 * pre-existing `FILE_BACKEND_MISMATCH` path already covers them); only rows
 * the active driver *should* be able to serve are verified.
 *
 * Exported so the restore flow and tests can invoke it directly. Throws
 * nothing — a backend probe failure is treated as "blob missing" so the
 * restore degrades safely to the loud path rather than masking the leak.
 */
export async function reconcileRestoredFiles(db: AppDatabase, logger?: Logger): Promise<ReconcileResult> {
  let driverName: string;
  let driver: { exists: (key: string) => Promise<boolean> };
  try {
    const d = getActiveDriver();
    driverName = d.name;
    driver = d;
  }
  catch {
    // No active driver selected (e.g. a restore harness with the file
    // module uninitialised). Nothing we can verify; leave rows as-is.
    return { checked: 0, quarantined: 0 };
  }

  const rows = await db.all<{ id: string; storage_key: string }>(sql`
    SELECT id, storage_key FROM files WHERE storage_driver = ${driverName}
  `);

  let quarantined = 0;
  for (const row of rows) {
    let present: boolean;
    try {
      present = await driver.exists(row.storage_key);
    }
    catch (err) {
      // Treat an unreadable backend as missing: fail loud, never silently
      // serve a row we could not verify.
      present = false;
      logger?.warn(
        { err: err instanceof Error ? err.message : String(err), fileId: row.id },
        "restore reconciliation: storage existence probe failed; quarantining",
      );
    }
    if (present)
      continue;

    await db.run(sql`
      UPDATE files
      SET storage_driver = ${QUARANTINE_DRIVER}, ref_count = 0
      WHERE id = ${row.id}
    `);
    quarantined++;
    logger?.warn(
      { fileId: row.id, storageKey: row.storage_key },
      "restore reconciliation: backing blob absent on storage backend; row quarantined (downloads will 404, not 500)",
    );
  }

  if (quarantined > 0) {
    logger?.error(
      { checked: rows.length, quarantined },
      "restore reconciliation: file blobs are out of backup scope and some restored rows have no backing object; quarantined them — re-seed the storage backend or accept the loss",
    );
  }

  return { checked: rows.length, quarantined };
}

export async function importJsonBackup(db: AppDatabase, data: BackupData, logger?: Logger): Promise<{ tablesImported: number; rowsImported: number }> {
  const modules = data.modules;
  const deleteOrder = getDeleteOrder(modules);
  const insertOrder = getInsertOrder(modules);
  const restoredFilesTable = insertOrder.some(t => getTableName(t) === "files");

  let tablesImported = 0;
  let rowsImported = 0;

  await db.transaction(async (tx) => {
    // defer_foreign_keys is checked at COMMIT time only and applies for the
    // life of the current transaction. Unlike `PRAGMA foreign_keys = OFF`
    // which is a process-level flag, this never leaks to other connections.
    await tx.run(sql`PRAGMA defer_foreign_keys = 1`);

    for (const table of deleteOrder) {
      await tx.delete(table).run();
    }

    for (const table of insertOrder) {
      const tableName = getTableName(table);
      const rows = data.tables[tableName];
      if (!rows || rows.length === 0)
        continue;

      tablesImported++;

      const sanitized: Record<string, unknown>[] = rows.map((raw) => {
        const row = { ...raw };
        validateRowShape(table, tableName, row);
        assertIdShape(row);
        return row;
      });

      for (let i = 0; i < sanitized.length; i += INSERT_BATCH_SIZE) {
        const batch = sanitized.slice(i, i + INSERT_BATCH_SIZE);
        try {
          // Drizzle accepts an array of values for a single multi-row INSERT.
          await tx.insert(table).values(batch).run();
        }
        catch (err) {
          // Identify the offending row by re-inserting the batch one row at a
          // time. Slow path, but it only runs on the failure case and gives
          // operators a clear pointer to the bad row instead of a generic
          // "FOREIGN KEY constraint failed" against the whole table.
          for (let j = 0; j < batch.length; j++) {
            const row = batch[j]!;
            try {
              await tx.insert(table).values(row).run();
            }
            catch (rowErr) {
              const rowId = typeof row.id === "string" ? row.id : `index ${i + j}`;
              throw new AppError(
                `Failed to insert into ${tableName} (row ${rowId}): ${rowErr instanceof Error ? rowErr.message : String(rowErr)}`,
                400,
                "INVALID_BACKUP_ROW",
              );
            }
          }
          // Single-row replay succeeded somehow; report the aggregate error.
          throw new AppError(
            `Failed to insert into ${tableName}: ${err instanceof Error ? err.message : String(err)}`,
            400,
            "INVALID_BACKUP_ROW",
          );
        }
        rowsImported += batch.length;
      }
    }
  });

  // Blobs are out of backup scope (see header). If this restore replayed
  // the `files` table, verify the rows against the active storage backend
  // and quarantine any whose object is absent so downloads fail loudly
  // (clean 404) instead of 500ing. Runs after COMMIT — the backend probe
  // is async I/O that must not be held inside the write transaction; the
  // quarantine writes are small, idempotent, and part of this same flow.
  if (restoredFilesTable)
    await reconcileRestoredFiles(db, logger);

  return { tablesImported, rowsImported };
}
