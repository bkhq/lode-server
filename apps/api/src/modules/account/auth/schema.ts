import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "@/modules/account/users/schema";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  index("idx_sessions_user").on(t.userId),
  index("idx_sessions_expires").on(t.expiresAt),
]);

export const pkceChallenges = sqliteTable("pkce_challenges", {
  state: text("state").primaryKey(),
  // HMAC of the original code verifier (hex). Storing only the digest
  // means that an at-rest dump of the DB during an active login flow
  // does not yield a usable verifier. See `auth.service.ts` for the
  // matching HMAC keyed by a process-derived secret.
  codeVerifier: text("code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, t => [
  index("idx_pkce_expires").on(t.expiresAt),
]);

// Per-key failure counter + lockout window. Used by single-user login
// (key = `single-user:<username-lower>`) and TOTP step-up
// (key = `totp:<user-id>`). Persisted because the in-memory variant
// resets on every process restart and fragments across replicas — both
// of which materially weaken the brute-force defence the lockout
// promises. A single shared shape keeps the migration cheap.
export const authLockouts = sqliteTable("auth_lockouts", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  // Epoch milliseconds. NULL means "tracking failures but not yet locked".
  lockedUntil: integer("locked_until"),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  index("idx_auth_lockouts_locked_until").on(t.lockedUntil),
]);
