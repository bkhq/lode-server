import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { AppError, NotFoundError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonOk, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import {
  deleteSetting,
  getSetting,
  getSettings,
  isSensitiveKey,
  MASKED_VALUE,
  maskSensitiveValue,
  maskValue,
  setSetting,
} from "./settings.service";

const SETTING_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const LIKE_SPECIAL_RE = /[%_]/g;

const putSettingSchema = z.object({
  value: z.string().min(1),
});

const settingSchema = z.object({
  key: z.string(),
  value: z.string(),
});

function validateSettingKey(key: string): void {
  if (!SETTING_KEY_RE.test(key)) {
    throw new NotFoundError("Setting", key);
  }
}

export function settingsRoutes() {
  const router = new Hono<AppEnv>();

  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/settings/*", authRequired);

  // GET /settings — list all settings
  router.get(
    "/settings",
    describeRoute({
      tags: [TAGS.Settings],
      summary: "List settings",
      description: "List all settings, optionally filtered by key prefix. Sensitive values are masked. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(settingSchema), "Settings"),
        ...errors(401, 403),
      },
    }),
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const rawPrefix = c.req.query("prefix");
      const prefix = rawPrefix ? rawPrefix.replace(LIKE_SPECIAL_RE, "\\$&") : undefined;
      const data = (await getSettings(db, prefix)).map(maskSensitiveValue);
      return c.json({ success: true, data });
    },
  );

  // ─── Generic CRUD (wildcard key) ───

  // GET /settings/:key — single setting
  router.get(
    "/settings/:key",
    describeRoute({
      tags: [TAGS.Settings],
      summary: "Get setting",
      description: "Fetch a single setting by key. Sensitive values are masked. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(settingSchema, "Setting"),
        ...errors(401, 403, 404),
      },
    }),
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const key = c.req.param("key");
      validateSettingKey(key);
      const value = await getSetting(db, key);
      if (value === null) {
        throw new NotFoundError("Setting", key);
      }
      return c.json({ success: true, data: { key, value: maskValue(key, value) } });
    },
  );

  // PUT /settings/:key — create or update
  router.put(
    "/settings/:key",
    describeRoute({
      tags: [TAGS.Settings],
      summary: "Set setting",
      description: "Create or update a setting value. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Updated"),
        ...errors(400, 401, 403, 404, 422),
      },
    }),
    adminRequired,
    validator("json", putSettingSchema),
    async (c) => {
      const db = c.get("db");
      const key = c.req.param("key");
      validateSettingKey(key);
      const body = c.req.valid("json");
      const user = c.get("user")!;

      // Reject saving the masked placeholder for sensitive keys
      if (isSensitiveKey(key) && body.value === MASKED_VALUE) {
        throw new AppError("Cannot save masked placeholder as value", 400, "MASKED_VALUE_REJECTED");
      }

      // Capture previous value BEFORE the update so the audit row preserves
      // the change history. Sensitive keys still get masked so the audit log
      // never carries a plaintext OAuth secret etc.
      const previousRaw = await getSetting(db, key);
      const previousValue = previousRaw === null
        ? null
        : maskValue(key, previousRaw);

      await setSetting(db, key, body.value, { updatedBy: user.id });

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "setting.updated",
        resourceType: "setting",
        resourceId: key,
        resourceName: key,
        detail: { previousValue, newValue: maskValue(key, body.value) },
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });

      return c.json({ success: true, data: null });
    },
  );

  // DELETE /settings/:key
  router.delete(
    "/settings/:key",
    describeRoute({
      tags: [TAGS.Settings],
      summary: "Delete setting",
      description: "Delete a setting by key. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Deleted"),
        ...errors(401, 403, 404),
      },
    }),
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const key = c.req.param("key");
      validateSettingKey(key);
      const user = c.get("user")!;

      const deleted = await deleteSetting(db, key);
      if (!deleted) {
        throw new NotFoundError("Setting", key);
      }

      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "setting.deleted",
        resourceType: "setting",
        resourceId: key,
        resourceName: key,
        ip: getClientIp(c),
        userAgent: c.req.header("user-agent") ?? "unknown",
        result: "success",
      });

      return c.json({ success: true, data: null });
    },
  );

  return router;
}
