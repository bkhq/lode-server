import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  oauthSub: text("oauth_sub").notNull(),
  username: text("username").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  avatar: text("avatar"),
  role: text("role", {
    enum: ["admin", "user"],
  }).notNull().default("user"),
  status: text("status", {
    enum: ["active", "disabled"],
  }).notNull().default("active"),
  // Set for accounts that sign in with a password (LOCAL_LOGIN): created by an
  // admin or seeded from the environment. Null for accounts that only sign in
  // through the identity provider. Never leaves the server.
  passwordHash: text("password_hash"),
  lastLoginAt: text("last_login_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_users_oauth_sub").on(t.oauthSub),
  uniqueIndex("idx_users_username").on(t.username),
  uniqueIndex("idx_users_email").on(t.email),
  index("idx_users_status").on(t.status),
]);

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  primaryKey({
    columns: [t.userId, t.key],
  }),
]);

export const userTotpDevices = sqliteTable("user_totp_devices", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  secret: text("secret").notNull(),
  verified: integer("verified", { mode: "boolean" }).notNull().default(false),
  lastUsedTimestep: integer("last_used_timestep").notNull().default(0),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  index("idx_totp_user").on(t.userId),
]);

export const totpChallenges = sqliteTable("totp_challenges", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresIn: integer("expires_in"),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, t => [
  index("idx_totp_challenge_expires").on(t.expiresAt),
]);
