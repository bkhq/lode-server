import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "@/modules/account/users/schema";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});
