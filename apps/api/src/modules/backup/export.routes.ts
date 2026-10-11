import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { buildContentDisposition } from "@/shared/lib/content-disposition";
import { AppError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonOk, raw, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { serviceTokenRequired } from "@/shared/middleware/service-token";
import { streamJsonBackup, verifyDek } from "./export.service";
import { getDataModules, getModuleNames } from "./registry";

const exportBodySchema = z.object({
  modules: z.array(z.string()).min(1),
  challengeId: z.string().uuid().optional(),
  encryptedDek: z.string().min(1).optional(),
});

// Per-token in-flight semaphore + minimum-interval gate. A leaked
// backup token must not double as a DOS lever: each token can have
// at most one streaming export in progress at a time, and successive
// successful exports are spaced at least `BACKUP_EXPORT_MIN_INTERVAL_SECONDS`
// apart. State is process-local — for HA pairs, set the env var on every
// replica.
const backupExportInFlight = new Set<string>();
const backupExportLastSuccess = new Map<string, number>();
const RE_NON_ALNUM = /\W+/g;

function tokenBucketKey(token: string): string {
  return `t:${token.slice(0, 8).replace(RE_NON_ALNUM, "_")}`;
}

const RE_TIMESTAMP_CHARS = /[:.]/g;

export function backupExportRoutes() {
  const router = new Hono<AppEnv>();

  // Service-token export — for automated sidecar / cron jobs. Skips the
  // session-cookie + DEK-challenge dance (the sidecar has no master
  // password) and instead trusts a long-lived bearer issued out-of-band.
  // The route is intentionally minimal: the caller picks all modules and
  // the API streams everything currently in the running, unlocked DB.
  router.post(
    "/backup/export-via-token",
    describeRoute({
      tags: [TAGS.Backup],
      summary: "Export backup via service token",
      description: "Streams a JSON backup archive of all modules. Authorized by the `backup` service token; throttled per token.",
      security: SECURITY.serviceToken,
      responses: {
        ...raw(200, "application/json", "Backup archive (attachment)"),
        ...errors(401, 403, 429),
      },
    }),
    serviceTokenRequired("backup"),
    async (c) => {
      const db = c.get("db");
      const config = c.get("config");

      const authz = c.req.header("authorization") ?? "";
      const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
      const bucket = tokenBucketKey(token);

      // Already streaming for this token → reject loudly so a misbehaving
      // sidecar cannot run 10 exports in parallel and pin the WAL.
      if (backupExportInFlight.has(bucket)) {
        c.header("Retry-After", "60");
        await audit(db, c.get("logger"), {
          actorId: "system",
          actorName: "system:backup-sidecar",
          action: "backup.export",
          resourceType: "system",
          resourceId: "database",
          resourceName: "database-backup-export",
          detail: { reason: "in-flight" },
          ip: getClientIp(c),
          userAgent: c.req.header("user-agent") ?? "service-token",
          result: "failure",
        });
        return c.json({ success: false, error: { code: "RATE_LIMITED", message: "Another export is in progress for this token." } }, 429);
      }

      // Min-interval gate. Counted from the moment the previous export
      // returned a response — leaves the WAL room to be reclaimed.
      const minIntervalMs = config.BACKUP_EXPORT_MIN_INTERVAL_SECONDS * 1000;
      if (minIntervalMs > 0) {
        const last = backupExportLastSuccess.get(bucket);
        if (last !== undefined) {
          const elapsed = Date.now() - last;
          if (elapsed < minIntervalMs) {
            const retryAfter = Math.ceil((minIntervalMs - elapsed) / 1000);
            c.header("Retry-After", String(retryAfter));
            await audit(db, c.get("logger"), {
              actorId: "system",
              actorName: "system:backup-sidecar",
              action: "backup.export",
              resourceType: "system",
              resourceId: "database",
              resourceName: "database-backup-export",
              detail: { reason: "min-interval", retryAfter },
              ip: getClientIp(c),
              userAgent: c.req.header("user-agent") ?? "service-token",
              result: "failure",
            });
            return c.json({ success: false, error: { code: "RATE_LIMITED", message: `Backup export throttled. Retry after ${retryAfter}s.` } }, 429);
          }
        }
      }

      backupExportInFlight.add(bucket);
      const { modules, body } = streamJsonBackup(db, [...getModuleNames()]);
      const timestamp = new Date().toISOString().replace(RE_TIMESTAMP_CHARS, "-").slice(0, 19);
      await audit(db, c.get("logger"), {
        actorId: "system",
        actorName: "system:backup-sidecar",
        action: "backup.export",
        resourceType: "system",
        resourceId: "database",
        resourceName: "database-backup-export",
        detail: { modules, via: "service-token" },
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "service-token",
        result: "success",
      });
      backupExportLastSuccess.set(bucket, Date.now());
      // Clear the in-flight marker after the stream actually drains. We
      // wrap the underlying ReadableStream so a client disconnect mid-
      // stream still releases the semaphore.
      const released = new ReadableStream({
        async start(controller) {
          const reader = body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done)
                break;
              controller.enqueue(value);
            }
            controller.close();
          }
          catch (err) {
            controller.error(err);
          }
          finally {
            backupExportInFlight.delete(bucket);
          }
        },
        cancel() {
          backupExportInFlight.delete(bucket);
        },
      });
      return new Response(released, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": buildContentDisposition("attachment", `${c.get("config").APP_NAME}-backup-${timestamp}.json`),
          "Cache-Control": "no-store",
          "Pragma": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  );

  // Everything else under this router is session-auth gated.
  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/backup/export/*", authRequired);
  router.use("/backup/modules/*", authRequired);

  router.get(
    "/backup/modules",
    describeRoute({
      tags: [TAGS.Backup],
      summary: "List backup modules",
      description: "Returns the available data modules and their dependencies. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(z.object({ name: z.string(), deps: z.array(z.string()) })), "Available modules"),
        ...errors(401, 403),
      },
    }),
    adminRequired,
    (c) => {
      const registry = getDataModules();
      return c.json({
        modules: getModuleNames().map(name => ({
          name,
          deps: registry[name]!.deps,
        })),
      });
    },
  );

  router.post(
    "/backup/export",
    describeRoute({
      tags: [TAGS.Backup],
      summary: "Export backup",
      description: "Streams a JSON backup archive of the selected modules. Requires DEK verification when encryption is enabled. Admin only.",
      security: SECURITY.session,
      responses: {
        ...raw(200, "application/json", "Backup archive (attachment)"),
        ...errors(400, 401, 403, 422),
      },
    }),
    adminRequired,
    validator("json", exportBodySchema),
    async (c) => {
      const config = c.get("config");
      const db = c.get("db");
      const user = c.get("user")!;

      const body = c.req.valid("json");

      const known = new Set(getModuleNames());
      const invalidModules = body.modules.filter(m => !known.has(m));
      if (invalidModules.length > 0) {
        throw new AppError(`Unknown modules: ${invalidModules.join(", ")}`, 400, "INVALID_MODULES");
      }

      const enc = c.get("encryption");
      if (!enc.isEncryptionDisabled()) {
        if (!body.challengeId || !body.encryptedDek) {
          throw new AppError("Encryption verification required", 400, "ENCRYPTION_REQUIRED");
        }

        const { eciesDecrypt, hexToBytes } = await import("@app/shared");

        const ephPrivKey = enc.consumeChallenge(body.challengeId);
        if (!ephPrivKey) {
          throw new AppError("Challenge expired or invalid. Refresh and try again.", 400, "INVALID_CHALLENGE");
        }

        const encryptedBytes = hexToBytes(body.encryptedDek);
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

      const { modules, body: stream } = streamJsonBackup(db, body.modules);
      const timestamp = new Date().toISOString().replace(RE_TIMESTAMP_CHARS, "-").slice(0, 19);

      // Emit the audit row before the stream starts — once the response body
      // begins flowing, the request is committed; failure mid-stream still
      // wants the "export attempted" row in the audit log.
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "backup.export",
        resourceType: "system",
        resourceId: "database",
        resourceName: "database-backup-export",
        detail: { modules },
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": buildContentDisposition("attachment", `${c.get("config").APP_NAME}-backup-${timestamp}.json`),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  );

  return router;
}
