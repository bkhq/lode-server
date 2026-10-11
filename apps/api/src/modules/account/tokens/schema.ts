import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "@/modules/account/users/schema";

// Personal API tokens. Only a SHA-256 of the token is stored: tokens carry
// 256 bits of randomness, so a plain hash is enough to make a leaked row
// useless, and it keeps lookup a single indexed equality. `prefix` is the
// first few characters, shown in the UI so a user can tell tokens apart.
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  prefix: text("prefix").notNull(),
  tokenHash: text("token_hash").notNull(),
  // JSON array of scope names (see shared/lib/token-scopes.ts).
  scopes: text("scopes").notNull(),
  expiresAt: text("expires_at"),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_api_tokens_hash").on(t.tokenHash),
  index("idx_api_tokens_user").on(t.userId),
]);
