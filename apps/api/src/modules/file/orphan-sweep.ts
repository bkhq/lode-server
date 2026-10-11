import type { FileServiceConfig } from "./file.service";
import type { AppDatabase } from "@/db";
import type { Logger } from "@/shared/lib/logger";
import { sql } from "drizzle-orm";
import { releaseReference } from "./file.service";
import { fileReferences } from "./schema";

/**
 * Background sweep that releases `file_references` rows whose owner row
 * has gone away. The shipped use case is `owner_type =
 * 'item_comment_attachment'`:
 * comment deletes intentionally skip cascading the attachment release
 * (a libsql encrypted-WAL recovery bug surfaces when the cascade runs
 * inside the same transaction), so the leftover rows pile up and are
 * collected out-of-band here. Each orphan reference triggers the
 * normal `releaseReference` path, which decrements `files.ref_count`
 * and lets the existing unreferenced-files GC reclaim the blob.
 *
 * Each pass is bounded by `limit` so a backlog of millions cannot
 * starve the scheduler. Designed to run alongside `runFileGcOnce`.
 */

const ORPHAN_RULES: readonly OrphanRule[] = [
  // Comment attachments — the canonical libsql case.
  {
    ownerType: "item_comment_attachment",
    parentTable: "item_comments",
    parentKey: "id",
  },
];

interface OrphanRule {
  readonly ownerType: string;
  readonly parentTable: string;
  readonly parentKey: string;
}

export async function listOrphanReferences(
  db: AppDatabase,
  rule: OrphanRule,
  limit: number,
): Promise<readonly { id: string }[]> {
  // Parameterise only the values we trust the schema to control.
  // `parentTable` and `parentKey` come from the hard-coded ORPHAN_RULES
  // above, never from user input, so it is safe to interpolate them as
  // identifiers via `sql.raw`. `ownerType` is bound.
  const rows = await db.all<{ id: string }>(sql`
    SELECT fr.id AS id
    FROM ${fileReferences} AS fr
    LEFT JOIN ${sql.raw(rule.parentTable)} AS p
      ON p.${sql.raw(rule.parentKey)} = fr.owner_id
    WHERE fr.owner_type = ${rule.ownerType}
      AND p.${sql.raw(rule.parentKey)} IS NULL
    LIMIT ${limit}
  `);
  return rows;
}

export async function runOrphanSweepOnce(
  db: AppDatabase,
  config: FileServiceConfig,
  limit: number,
  logger?: Logger,
): Promise<number> {
  let total = 0;
  for (const rule of ORPHAN_RULES) {
    const refs = await listOrphanReferences(db, rule, limit);
    for (const ref of refs) {
      try {
        await releaseReference(db, config, { referenceId: ref.id });
        total++;
      }
      catch (err) {
        logger?.warn(
          { err: err instanceof Error ? err.message : String(err), referenceId: ref.id, ownerType: rule.ownerType },
          "orphan reference release failed",
        );
      }
    }
  }
  return total;
}
