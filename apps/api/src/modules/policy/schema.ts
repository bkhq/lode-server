import { index, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "@/modules/account/users/schema";

/**
 * `subject_relation` uses the empty string — never NULL — for a direct
 * subject. SQLite treats every NULL as distinct under UNIQUE, so a nullable
 * column would leave `idx_tuples_unique` unable to stop duplicate direct
 * grants; the sentinel makes the index the single point of enforcement.
 * The service layer maps `""` ↔ `null` at the API edge so callers still see
 * `subjectRelation: null`.
 */
export const DIRECT_SUBJECT = "";

export const relationTuples = sqliteTable("relation_tuples", {
  id: text("id").primaryKey(),
  namespace: text("namespace").notNull(),
  objectId: text("object_id").notNull(),
  relation: text("relation").notNull(),
  subjectNamespace: text("subject_namespace").notNull(),
  subjectId: text("subject_id").notNull(),
  subjectRelation: text("subject_relation").notNull().default(DIRECT_SUBJECT),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  unique("idx_tuples_unique").on(t.namespace, t.objectId, t.relation, t.subjectNamespace, t.subjectId, t.subjectRelation),
  index("idx_tuples_object").on(t.namespace, t.objectId, t.relation),
  index("idx_tuples_subject").on(t.subjectNamespace, t.subjectId, t.subjectRelation),
]);

// Resource groups are real rows, not `__meta__` tuples smuggled into
// relation_tuples. Membership edges (`<ns>:<id>#parent@resource_group:<gid>`)
// and access grants on the group stay in relation_tuples.
export const resourceGroups = sqliteTable("resource_groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_resource_groups_name").on(t.name),
]);
