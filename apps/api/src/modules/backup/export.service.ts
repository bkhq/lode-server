/**
 * Backup EXPORT — table rows only.
 *
 * SCOPE CAVEAT: file blob bytes are **out of backup scope**. This export
 * streams `files` / `file_references` table *rows*, never the underlying
 * object bytes (which live on the active storage driver — local disk, S3,
 * …). Bundling blobs would balloon the JSON past every cap in
 * `restore.service.ts` and is intentionally not attempted.
 *
 * Consequence: a backup restored onto a deployment whose storage backend
 * does not already hold the referenced blobs will have `files` rows that
 * point at absent objects. `restore.service.ts` runs a post-restore
 * reconciliation that detects and quarantines those rows so a restored
 * deployment fails loudly/visibly instead of 500ing on download. See
 * `reconcileRestoredFiles` there.
 */
import type { AnyColumn } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { createClient } from "@libsql/client";
import { asc, getTableColumns, getTableName, gt } from "drizzle-orm";
import { getDataModules, resolveModulesWithDeps } from "./registry";

export async function verifyDek(dbPath: string, dekHex: string): Promise<void> {
  const client = createClient({ url: `file:${dbPath}`, encryptionKey: dekHex });
  try {
    await client.execute("SELECT count(*) FROM sqlite_master");
  }
  finally {
    client.close();
  }
}

/** Bump together with `MIGRATIONS` in restore.service.ts. */
export const CURRENT_BACKUP_VERSION = 3;

export interface BackupData {
  version: number;
  exportedAt: string;
  modules: string[];
  tables: Record<string, Record<string, unknown>[]>;
}

const STREAM_BATCH_SIZE = 1000;

/**
 * Stream a backup as JSON. Returns a `ReadableStream<Uint8Array>` whose
 * chunks form a single JSON document — `{"version":2,...,"tables":{"a":[...]}}`.
 *
 * Memory cost is ~one batch (≤ STREAM_BATCH_SIZE rows × row size), not the
 * whole DB — important on small VMs once the audit table grows past tens
 * of thousands of rows.
 */
export function streamJsonBackup(db: AppDatabase, selectedModules: string[]): {
  modules: string[];
  body: ReadableStream<Uint8Array>;
} {
  const modules = resolveModulesWithDeps(selectedModules);
  const registry = getDataModules();
  const enc = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(enc.encode(
          `{"version":${CURRENT_BACKUP_VERSION},"exportedAt":${JSON.stringify(new Date().toISOString())},`
          + `"modules":${JSON.stringify(modules)},"tables":{`,
        ));

        let firstTable = true;
        for (const modName of modules) {
          const mod = registry[modName];
          if (!mod)
            continue;

          for (const table of mod.tables) {
            const tableName = getTableName(table);
            controller.enqueue(enc.encode(
              `${firstTable ? "" : ","}${JSON.stringify(tableName)}:[`,
            ));
            firstTable = false;

            // Page through the table with keyset pagination on the
            // primary key. Drizzle tables in this project all use a
            // string `id` PK; we fall back to LIMIT/OFFSET when the
            // table is keyless (e.g. `pkce_challenges` which keys by
            // `state`). Keyset avoids the O(n²) re-scan of `OFFSET`
            // and keeps total work linear in row count, which matters
            // once audit/file tables grow into the hundreds of
            // thousands of rows.
            const columns = getTableColumns(table) as Record<string, AnyColumn>;
            const idColumn: AnyColumn | undefined = columns.id;
            let firstRow = true;
            if (idColumn) {
              let cursor: string | undefined;
              while (true) {
                // `$dynamic()` opts the builder out of compile-time
                // generic checks so we can append `.where(...)`
                // conditionally without re-inferring the row type at
                // each branch. The result still type-checks at the
                // `.all()` call, which we narrow to a record map.
                const baseQuery = db.select().from(table).$dynamic();

                const filtered = cursor === undefined ? baseQuery : baseQuery.where(gt(idColumn, cursor));
                const rows = await filtered.orderBy(asc(idColumn)).limit(STREAM_BATCH_SIZE).all() as Record<string, unknown>[];
                if (rows.length === 0)
                  break;
                for (const row of rows) {
                  controller.enqueue(enc.encode((firstRow ? "" : ",") + JSON.stringify(row)));
                  firstRow = false;
                }
                if (rows.length < STREAM_BATCH_SIZE)
                  break;
                cursor = String(rows[rows.length - 1]!.id);
              }
            }
            else {
              // Fallback: LIMIT/OFFSET when no `id` column exists. The
              // tables that hit this branch (e.g. pkce_challenges,
              // settings) are bounded in row count by design, so the
              // O(n²) cost is irrelevant.
              let offset = 0;
              while (true) {
                const rows = await db.select().from(table).limit(STREAM_BATCH_SIZE).offset(offset).all();
                if (rows.length === 0)
                  break;
                for (const row of rows) {
                  controller.enqueue(enc.encode((firstRow ? "" : ",") + JSON.stringify(row)));
                  firstRow = false;
                }
                if (rows.length < STREAM_BATCH_SIZE)
                  break;
                offset += STREAM_BATCH_SIZE;
              }
            }

            controller.enqueue(enc.encode("]"));
          }
        }

        controller.enqueue(enc.encode("}}"));
        controller.close();
      }
      catch (err) {
        controller.error(err);
      }
    },
  });

  return { modules, body };
}
