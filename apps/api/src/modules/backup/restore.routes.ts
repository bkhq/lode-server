import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { deleteUserSessions } from "@/modules/account/auth/auth.service";
import { users } from "@/modules/account/users/schema";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError } from "@/shared/lib/errors";
import { describeRoute, errors, resolver, SECURITY, TAGS } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { verifyDek } from "./export.service";
import { importJsonBackup, validateBackupData, validateFileSize } from "./restore.service";

const USER_TABLES = ["users", "groups", "user_preferences"] as const;

interface UserRowLike {
  readonly id: string;
  readonly role?: string;
  readonly status?: string;
}

/**
 * When the operator chooses `includeUsers=false`, the user table is left
 * intact but other tables still reference user ids via FK. Pre-flight scan:
 * collect every `*Id`/`*_id` value in the dropped-but-FK-pointing rows and
 * confirm a matching user exists in the live DB. Surfacing this *before*
 * the transaction commits gives a useful error instead of "FOREIGN KEY
 * constraint failed" at COMMIT time.
 */
async function assertUserFkIntegrity(
  liveUserIds: ReadonlySet<string>,
  backupTables: Record<string, unknown[]>,
): Promise<void> {
  // Tables that hold FK references to `users.id`. Centralised here so adding
  // a new module is a one-line edit. The corresponding column may use either
  // camelCase (drizzle output) or snake_case (raw SQL dumps).
  const userFkColumns = new Set([
    "creatorId",
    "creator_id",
    "uploadedBy",
    "uploaded_by",
    "actorId",
    "actor_id",
    "userId",
    "user_id",
    "assigneeId",
    "assignee_id",
    "authorId",
    "author_id",
  ]);

  const referenced = new Set<string>();
  for (const rows of Object.values(backupTables)) {
    if (!Array.isArray(rows))
      continue;
    for (const row of rows) {
      if (!row || typeof row !== "object")
        continue;
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        if (userFkColumns.has(k) && typeof v === "string" && v.length > 0)
          referenced.add(v);
      }
    }
  }
  const missing = [...referenced].filter(id => !liveUserIds.has(id));
  if (missing.length > 0) {
    throw new AppError(
      `Restore would orphan ${missing.length} foreign key reference(s) to users that aren't in the current DB. Re-run with includeUsers=true or restore from a backup that contains the matching users.`,
      400,
      "RESTORE_FK_MISSING_USERS",
    );
  }
}

/**
 * Drop the user-related tables from a parsed backup. We mutate a shallow
 * copy so the parsed JSON in memory is not aliased.
 */
function stripUserTables<T extends { tables: Record<string, unknown[]>; modules: string[] }>(data: T): T {
  const tables = { ...data.tables };
  for (const t of USER_TABLES)
    delete tables[t];
  const modules = data.modules.filter(m => m !== "users");
  return { ...data, tables, modules };
}

export function backupImportRoutes() {
  const router = new Hono<AppEnv>();

  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/backup/import/*", authRequired);

  router.post(
    "/backup/import",
    describeRoute({
      tags: [TAGS.Backup],
      summary: "Import backup",
      description: "Restores a JSON backup archive from a multipart upload (`file`). Optionally includes users (`includeUsers`) and requires DEK verification when encryption is enabled. Admin only.",
      security: SECURITY.session,
      responses: {
        200: {
          description: "Restore summary",
          content: {
            "application/json": {
              schema: resolver(z.object({
                success: z.literal(true),
                modules: z.array(z.string()),
                tablesImported: z.number(),
                rowsImported: z.number(),
              })),
            },
          },
        },
        ...errors(400, 401, 403, 413),
      },
    }),
    adminRequired,
    async (c) => {
      const config = c.get("config");
      const db = c.get("db");
      const user = c.get("user")!;

      const formData = await c.req.formData();

      const file = formData.get("file");
      if (!file || !(file instanceof File)) {
        throw new AppError("No file uploaded", 400, "NO_FILE");
      }

      validateFileSize(file.size);

      const includeUsersRaw = formData.get("includeUsers");
      const includeUsers = typeof includeUsersRaw === "string"
        ? includeUsersRaw === "true" || includeUsersRaw === "1"
        : false;

      const enc = c.get("encryption");
      if (!enc.isEncryptionDisabled()) {
        const challengeId = formData.get("challengeId");
        const encryptedDek = formData.get("encryptedDek");

        if (!challengeId || !encryptedDek) {
          throw new AppError("Encryption verification required", 400, "ENCRYPTION_REQUIRED");
        }

        const { eciesDecrypt, hexToBytes } = await import("@app/shared");

        const ephPrivKey = enc.consumeChallenge(String(challengeId));
        if (!ephPrivKey) {
          throw new AppError("Challenge expired or invalid. Refresh and try again.", 400, "INVALID_CHALLENGE");
        }

        const encryptedBytes = hexToBytes(String(encryptedDek));
        let dekHex: string;
        try {
          const dekBytes = await eciesDecrypt(ephPrivKey, encryptedBytes);
          dekHex = Array.from(dekBytes, b => b.toString(16).padStart(2, "0")).join("");
        }
        catch {
          throw new AppError("Invalid decryption key", 403, "INVALID_KEY");
        }

        try {
          await verifyDek(config.DB_PATH, dekHex);
        }
        catch {
          throw new AppError("Invalid decryption key", 403, "INVALID_KEY");
        }
      }

      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      }
      catch {
        throw new AppError("Invalid JSON file", 400, "INVALID_JSON");
      }

      const backupData = validateBackupData(parsed);

      // Snapshot the live users so we can detect role/status changes after the
      // restore and force-revoke sessions for affected users.
      const liveUsers: UserRowLike[] = await db
        .select({ id: users.id, role: users.role, status: users.status })
        .from(users)
        .all();
      const liveById = new Map(liveUsers.map(u => [u.id, u]));

      let effectiveData = backupData;
      let importedUserRows: UserRowLike[] = [];

      if (!includeUsers) {
        effectiveData = stripUserTables(backupData);
        // FK pre-flight: everything pointing at users.id must resolve in the
        // live DB. Catching it here is cheaper than tearing down the partial
        // transaction with `defer_foreign_keys` at COMMIT.
        const liveIds = new Set(liveUsers.map(u => u.id));
        await assertUserFkIntegrity(liveIds, effectiveData.tables);
      }
      else {
        const incoming = (backupData.tables.users ?? []) as unknown as UserRowLike[];
        // Refuse if the importing admin would be locked out: their row must be
        // present, admin, and active.
        const me = incoming.find(r => r.id === user.id);
        if (!me || me.role !== "admin" || (me.status !== undefined && me.status !== "active")) {
          throw new AppError(
            "Restore would lock out the importing admin",
            400,
            "RESTORE_WOULD_LOCK_OUT",
          );
        }
        importedUserRows = incoming;
      }

      const result = await importJsonBackup(db, effectiveData, c.get("logger"));

      if (includeUsers) {
        // Force-revoke sessions for any user whose role or status changed.
        const changedIds: string[] = [];
        for (const row of importedUserRows) {
          const before = liveById.get(row.id);
          if (!before) {
            changedIds.push(row.id);
            continue;
          }
          if (before.role !== row.role || before.status !== row.status) {
            changedIds.push(row.id);
          }
        }
        for (const uid of changedIds) {
          await deleteUserSessions(db, uid);
        }

        // Per-row audit entries so the audit log captures each restored user.
        for (const row of importedUserRows) {
          await audit(db, c.get("logger"), {
            actorId: user.id,
            actorName: user.name,
            action: "user.restored",
            resourceType: "user",
            resourceId: row.id,
            resourceName: row.id,
            ip: getClientIp(c),
            userAgent: c.req.header("user-agent") ?? "unknown",
            result: "success",
          });
        }
      }

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "backup.import",
        resourceType: "system",
        resourceId: "database",
        resourceName: "database-backup-import",
        detail: {
          modules: effectiveData.modules,
          tablesImported: result.tablesImported,
          rowsImported: result.rowsImported,
          includeUsers,
        },
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });

      return c.json({
        success: true,
        modules: effectiveData.modules,
        tablesImported: result.tablesImported,
        rowsImported: result.rowsImported,
      });
    },
  );

  return router;
}
