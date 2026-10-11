import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  actorName: text("actor_name").notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  resourceName: text("resource_name").notNull(),
  detail: text("detail"),
  ip: text("ip").notNull(),
  userAgent: text("user_agent").notNull(),
  result: text("result", { enum: ["success", "failure"] }).notNull(),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  // `idx_audit_created` is kept as a single-column index because the
  // retention sweep deletes by `created_at` alone — the planner picks this
  // index over a compound one whose leading column is something else.
  index("idx_audit_created").on(t.createdAt),
  // Compound `(filter, created_at)` indexes serve the audit query patterns
  // (filter by actor / action / resource, sorted by createdAt DESC) without
  // a separate sort step.
  index("idx_audit_actor_created").on(t.actorId, t.createdAt),
  index("idx_audit_action_created").on(t.action, t.createdAt),
  index("idx_audit_resource_created").on(t.resourceType, t.resourceId, t.createdAt),
]);
