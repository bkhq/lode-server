import type { AppEnv } from "@/shared/lib/types";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { sessions } from "@/modules/account/auth/schema";
import { userPreferences, users } from "@/modules/account/users/schema";
import { audit, auditMeta } from "@/modules/audit/audit.service";
import { isLocalLogin } from "@/shared/lib/app-config";
import { AppError, NotFoundError, UnauthorizedError } from "@/shared/lib/errors";
import { describeRoute, errors, jsonCreated, jsonOk, jsonPaged, SECURITY, TAGS, validator } from "@/shared/lib/openapi";
import { adminRequired, authRequired } from "@/shared/middleware/auth";
import { rateLimit } from "@/shared/middleware/rate-limit";
import { createLocalUser, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, setUserPassword } from "./local-users.service";
import {
  confirmTotpDevice,
  createTotpDevice,
  deleteTotpDevice,
  hasVerifiedTotp,
  issueStepUpToken,
  listTotpDevices,
  validateStepUpToken,
  verifyTotpCode,
} from "./totp.service";
import { getUserById, getUserGroups, listActiveUsers, listUsers } from "./users.service";

const listQuerySchema = z.object({
  q: z.string().optional(),
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  group_id: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

const createUserSchema = z.object({
  username: z.string().trim().regex(/^[a-z0-9][\w.-]{1,63}$/i, "Letters, digits, dot, dash and underscore; 2 to 64 characters"),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  role: z.enum(["admin", "user"]).default("user"),
  password: passwordSchema,
});

const updateBodySchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine(d => d.role !== undefined || d.status !== undefined, {
  message: "At least one of role or status must be provided",
});

const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string(),
  avatar: z.string().nullable(),
  role: z.enum(["admin", "user"]),
  status: z.enum(["active", "disabled"]),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export function userRoutes() {
  const router = new Hono<AppEnv>();

  // Scoped to this module's own paths. `use("*")` here would become a
  // guard on every router mounted after this one, not just on these.
  router.use("/account/me/*", authRequired);
  router.use("/account/users/*", authRequired);
  router.use("/account/visible-users/*", authRequired);

  // ── /me — current user endpoints ──

  router.get(
    "/account/me",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Get current user",
      description: "The authenticated user's profile and group memberships.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(userSchema.extend({
          groups: z.array(z.unknown()),
        }), "Current user"),
        ...errors(401),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const userGroupsList = await getUserGroups(db, user.id);

      return c.json({
        success: true,
        data: {
          id: user.id,
          username: user.username,
          name: user.name,
          email: user.email,
          avatar: user.avatar,
          role: user.role,
          status: user.status,
          lastLoginAt: user.lastLoginAt,
          createdAt: user.createdAt,
          groups: userGroupsList,
        },
      });
    },
  );

  router.get(
    "/account/me/groups",
    describeRoute({
      tags: [TAGS.Account],
      summary: "List current user groups",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(z.unknown()), "Groups"),
        ...errors(401),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const userGroupsList = await getUserGroups(db, user.id);
      return c.json({ success: true, data: userGroupsList });
    },
  );

  router.get(
    "/account/me/preferences/:key",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Get a user preference",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          key: z.string(),
          value: z.string(),
        }).nullable(), "Preference"),
        ...errors(401),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const key = c.req.param("key");

      const row = await db.select()
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, key)))
        .get();

      return c.json({
        success: true,
        data: row
          ? { key: row.key, value: row.value }
          : null,
      });
    },
  );

  const preferenceBodySchema = z.object({
    // value may be any JSON-serialisable shape; we only require an object body
    // with a `value` field — null/array/scalar root bodies are rejected.
    value: z.unknown(),
  }).strict();

  router.put(
    "/account/me/preferences/:key",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Set a user preference",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Preference saved"),
        ...errors(401, 422),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const key = c.req.param("key");

      let raw: unknown;
      try {
        raw = await c.req.json();
      }
      catch {
        throw new AppError("Invalid JSON body", 422, "VALIDATION_ERROR");
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new AppError("Body must be a JSON object with a `value` field", 422, "VALIDATION_ERROR");
      }
      const body = preferenceBodySchema.parse(raw);
      const value = typeof body.value === "string"
        ? body.value
        : JSON.stringify(body.value);

      await db.insert(userPreferences).values({
        userId: user.id,
        key,
        value,
        updatedAt: new Date().toISOString(),
      }).onConflictDoUpdate({
        target: [userPreferences.userId, userPreferences.key],
        set: {
          value,
          updatedAt: new Date().toISOString(),
        },
      }).run();

      return c.json({ success: true, data: null });
    },
  );

  // ── /me/totp — TOTP device management ──

  router.get(
    "/account/me/totp",
    describeRoute({
      tags: [TAGS.Account],
      summary: "List TOTP devices",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(z.unknown()), "TOTP devices"),
        ...errors(401),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const devices = await listTotpDevices(db, user.id);
      return c.json({ success: true, data: devices });
    },
  );

  const createTotpSchema = z.object({
    name: z.string().min(1).max(100),
  });

  router.post(
    "/account/me/totp",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Create TOTP device",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(z.unknown(), "TOTP device created"),
        ...errors(401, 422),
      },
    }),
    validator("json", createTotpSchema),
    async (c) => {
      const db = c.get("db");
      const config = c.get("config");
      const user = c.get("user")!;
      const body = c.req.valid("json");
      const result = await createTotpDevice(db, user.id, body.name, user.username, config.APP_DISPLAY_NAME);
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "totp.device.created",
        resourceType: "totp_device",
        resourceId: result.id,
        resourceName: body.name,
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: result }, 201);
    },
  );

  router.post(
    "/account/me/totp/:deviceId/confirm",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Confirm TOTP device",
      description: "Verifies the device's first code. Requires a fresh step-up token once any device is verified.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "TOTP device confirmed"),
        ...errors(400, 401, 429),
      },
    }),
    rateLimit({ windowMs: 5 * 60 * 1000, max: 10, bucket: "totp-stepup" }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const deviceId = c.req.param("deviceId");

      // Bootstrap exception: if the user has no verified device yet, the very
      // first confirm has nothing to step up against. Once any device is
      // verified, every subsequent confirm requires a fresh step-up token so an
      // attacker who hijacks a session cannot enroll their own device.
      const alreadyHasTotp = await hasVerifiedTotp(db, user.id);
      if (alreadyHasTotp) {
        const header = c.req.header("x-totp-token");
        if (!header || !(await validateStepUpToken(header, user.id))) {
          throw new UnauthorizedError("STEP_UP_REQUIRED");
        }
      }

      const body = z.object({
        code: z.string().length(6),
      }).parse(await c.req.json());
      const ok = await confirmTotpDevice(db, deviceId, user.id, body.code);
      if (!ok) {
        await audit(db, c.get("logger"), {
          actorId: user.id,
          actorName: user.name,
          action: "totp.device.confirm",
          resourceType: "totp_device",
          resourceId: deviceId,
          resourceName: deviceId,
          ...auditMeta(c),
          result: "failure",
        });
        throw new AppError("Invalid TOTP code or device", 400, "TOTP_VERIFY_FAILED");
      }
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "totp.device.confirmed",
        resourceType: "totp_device",
        resourceId: deviceId,
        resourceName: deviceId,
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );

  router.delete(
    "/account/me/totp/:deviceId",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Delete TOTP device",
      description: "Requires a fresh step-up token once any device is verified.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "TOTP device deleted"),
        ...errors(401, 404),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const deviceId = c.req.param("deviceId");

      // Once any device is verified, deletion is a sensitive op and must be
      // gated by a fresh step-up token. Pre-bootstrap (no verified device) we
      // allow plain deletion so a botched setup can be cleaned up.
      if (await hasVerifiedTotp(db, user.id)) {
        const header = c.req.header("x-totp-token");
        if (!header || !(await validateStepUpToken(header, user.id))) {
          throw new UnauthorizedError("STEP_UP_REQUIRED");
        }
      }

      const ok = await deleteTotpDevice(db, deviceId, user.id);
      if (!ok)
        throw new NotFoundError("TOTP device", deviceId);
      await audit(db, c.get("logger"), {
        actorId: user.id,
        actorName: user.name,
        action: "totp.device.deleted",
        resourceType: "totp_device",
        resourceId: deviceId,
        resourceName: deviceId,
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );

  router.post(
    "/account/me/totp/verify",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Verify TOTP and issue step-up token",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.object({
          token: z.string(),
        }), "Step-up token"),
        ...errors(400, 401, 422, 429),
      },
    }),
    rateLimit({ windowMs: 5 * 60 * 1000, max: 10, bucket: "totp-stepup" }),
    validator("json", z.object({
      code: z.string().length(6),
    })),
    async (c) => {
      const db = c.get("db");
      const user = c.get("user")!;
      const body = c.req.valid("json");
      const ok = await verifyTotpCode(db, user.id, body.code);
      if (!ok)
        throw new AppError("Invalid TOTP code", 400, "TOTP_VERIFY_FAILED");
      const token = await issueStepUpToken(user.id);
      return c.json({
        success: true,
        data: { token },
      });
    },
  );

  // GET /account/visible-users — directory of active users exposed to every
  // authenticated caller. Intentionally NOT admin-gated: the document /
  // issue sharing and assignment pickers need it on the user-facing UI.
  // Lives outside the `/account/users/*` namespace (which is admin-only)
  // so the public-vs-admin boundary is legible from the URL alone.
  router.get(
    "/account/visible-users",
    describeRoute({
      tags: [TAGS.Account],
      summary: "List visible users",
      description: "Directory of active users for sharing/assignment pickers. Any authenticated user.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(z.unknown()), "Visible users"),
        ...errors(401),
      },
    }),
    async (c) => {
      const db = c.get("db");
      const data = await listActiveUsers(db);
      return c.json({
        success: true,
        data,
        meta: { total: data.length },
      });
    },
  );

  // ── /account/users — admin endpoints ──

  // GET /users — list with pagination, search, filter
  router.get(
    "/account/users",
    describeRoute({
      tags: [TAGS.Account],
      summary: "List users",
      description: "Paginated, filterable user list. Admin only.",
      security: SECURITY.session,
      responses: {
        ...jsonPaged(userSchema, "Users"),
        ...errors(401, 403, 422),
      },
    }),
    adminRequired,
    validator("query", listQuerySchema),
    async (c) => {
      const db = c.get("db");
      const query = c.req.valid("query");
      const result = await listUsers(db, {
        ...query.q
          ? { q: query.q }
          : {},
        ...query.role
          ? { role: query.role }
          : {},
        ...query.status
          ? { status: query.status }
          : {},
        ...query.group_id
          ? { groupId: query.group_id }
          : {},
        page: query.page,
        limit: query.limit,
      });

      return c.json({
        success: true,
        data: result.data,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      });
    },
  );

  // POST /users — create an account that signs in with a password
  router.post(
    "/account/users",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Create user",
      description: "Admin only; needs LOCAL_LOGIN. Creates an account that signs in with a username and password, so a deployment does not depend on an identity provider. If the person later signs in through the IdP with a verified email matching this account's, the two are linked.",
      security: SECURITY.session,
      responses: {
        ...jsonCreated(userSchema, "User created"),
        ...errors(401, 403, 409, 422),
      },
    }),
    adminRequired,
    validator("json", createUserSchema),
    async (c) => {
      if (!isLocalLogin(c.get("config")))
        throw new AppError("Password accounts are disabled; set LOCAL_LOGIN=true", 409, "LOCAL_LOGIN_DISABLED");
      const db = c.get("db");
      const actor = c.get("user")!;
      const created = await createLocalUser(db, c.req.valid("json"));
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "user.created",
        resourceType: "user",
        resourceId: created.id,
        resourceName: created.username,
        detail: { role: created.role },
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: created }, 201);
    },
  );

  // POST /users/:id/password — set or reset a password
  router.post(
    "/account/users/:id/password",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Set a user's password",
      description: "Admin only; needs LOCAL_LOGIN. Replaces the password and ends the user's sessions. On an account that signed in only through the IdP it adds password sign-in.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.null(), "Password set"),
        ...errors(401, 403, 404, 409, 422),
      },
    }),
    adminRequired,
    validator("param", z.object({
      id: z.string(),
    })),
    validator("json", z.object({ password: passwordSchema })),
    async (c) => {
      if (!isLocalLogin(c.get("config")))
        throw new AppError("Password accounts are disabled; set LOCAL_LOGIN=true", 409, "LOCAL_LOGIN_DISABLED");
      const db = c.get("db");
      const actor = c.get("user")!;
      const { id } = c.req.valid("param");
      const target = await getUserById(db, id);
      if (!target || !(await setUserPassword(db, id, c.req.valid("json").password)))
        throw new NotFoundError("User", id);
      await audit(db, c.get("logger"), {
        actorId: actor.id,
        actorName: actor.name,
        action: "user.password_set",
        resourceType: "user",
        resourceId: id,
        resourceName: target.username,
        ...auditMeta(c),
        result: "success",
      });
      return c.json({ success: true, data: null });
    },
  );

  // GET /users/:id — user detail
  router.get(
    "/account/users/:id",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Get user",
      security: SECURITY.session,
      responses: {
        ...jsonOk(userSchema, "User"),
        ...errors(401, 403, 404),
      },
    }),
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const user = await getUserById(db, c.req.param("id"));
      if (!user) {
        throw new NotFoundError("User", c.req.param("id"));
      }
      return c.json({ success: true, data: user });
    },
  );

  // PATCH /users/:id — update role/status
  router.patch(
    "/account/users/:id",
    describeRoute({
      tags: [TAGS.Account],
      summary: "Update user",
      description: "Change a user's role and/or status. Admin only; cannot modify own account.",
      security: SECURITY.session,
      responses: {
        ...jsonOk(userSchema, "User updated"),
        ...errors(401, 403, 404, 422),
      },
    }),
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const id = c.req.param("id");

      const currentUser = c.get("user")!;
      if (id === currentUser.id) {
        throw new AppError("Cannot modify your own account", 403, "FORBIDDEN");
      }

      const existing = await getUserById(db, id);
      if (!existing) {
        throw new NotFoundError("User", id);
      }

      const body = updateBodySchema.parse(await c.req.json());
      const roleChanged = body.role !== undefined && body.role !== existing.role;
      const statusChanged = body.status !== undefined && body.status !== existing.status;

      // Atomic: either both the user mutation AND the session purge land, or
      // neither does. Without a tx an admin demote could persist while the
      // user keeps an existing admin session live.
      const updated = await db.transaction(async (tx) => {
        const now = new Date().toISOString();
        const setData: Record<string, unknown> = { updatedAt: now };
        if (body.role !== undefined)
          setData.role = body.role;
        if (body.status !== undefined)
          setData.status = body.status;

        await tx.update(users).set(setData).where(eq(users.id, id)).run();

        if (roleChanged || statusChanged) {
          await tx.delete(sessions).where(eq(sessions.userId, id)).run();
        }

        return await tx.select({
          id: users.id,
          username: users.username,
          name: users.name,
          email: users.email,
          avatar: users.avatar,
          role: users.role,
          status: users.status,
          lastLoginAt: users.lastLoginAt,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        }).from(users).where(eq(users.id, id)).get();
      });

      // Re-validate the acting admin's authority post-commit. If their role was
      // revoked concurrently we must not report success on a privileged op.
      const refreshedActor = await getUserById(db, currentUser.id);
      if (!refreshedActor || refreshedActor.role !== "admin") {
        throw new AppError("Admin privileges revoked during operation", 403, "FORBIDDEN");
      }

      const { ip, userAgent } = auditMeta(c);

      if (roleChanged) {
        await audit(db, c.get("logger"), {
          actorId: currentUser.id,
          actorName: currentUser.name,
          action: "user.role_changed",
          resourceType: "user",
          resourceId: id,
          resourceName: existing.username,
          detail: { previousRole: existing.role, newRole: body.role },
          ip,
          userAgent,
          result: "success",
        });
      }
      if (statusChanged) {
        const action = body.status === "disabled"
          ? "user.disabled"
          : "user.enabled";
        await audit(db, c.get("logger"), {
          actorId: currentUser.id,
          actorName: currentUser.name,
          action,
          resourceType: "user",
          resourceId: id,
          resourceName: existing.username,
          ip,
          userAgent,
          result: "success",
        });
      }

      return c.json({ success: true, data: updated });
    },
  );

  // GET /users/:id/groups — user's groups
  router.get(
    "/account/users/:id/groups",
    describeRoute({
      tags: [TAGS.Account],
      summary: "List user groups",
      security: SECURITY.session,
      responses: {
        ...jsonOk(z.array(z.unknown()), "User groups"),
        ...errors(401, 403, 404),
      },
    }),
    adminRequired,
    async (c) => {
      const db = c.get("db");
      const id = c.req.param("id");

      const user = await getUserById(db, id);
      if (!user) {
        throw new NotFoundError("User", id);
      }

      const userGroupsList = await getUserGroups(db, id);
      return c.json({ success: true, data: userGroupsList });
    },
  );

  return router;
}
