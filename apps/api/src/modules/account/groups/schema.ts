import { index, sqliteTable, text, unique, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "@/modules/account/users/schema";

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  // Who manages the group's user memberships. `local` groups are edited by
  // admins; `idp` groups are created and kept in step by the identity
  // provider's groups claim at each login (OAUTH_GROUPS_CLAIM), and refuse
  // manual membership edits and renames.
  source: text("source", { enum: ["local", "idp"] }).notNull().default("local"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()).$onUpdateFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_groups_name").on(t.name),
]);

// `group_members` stores the `group:<groupId>#member@<subject>` edges. Owned
// by the account module so a deployment can drop the policy module while
// keeping user-group features.
//
// `subject_relation` is the empty string for direct user membership and
// `'member'` for nested-group membership (one group as a member of another).
// SQLite treats every NULL as distinct under UNIQUE, so a nullable column
// would leave `idx_group_members_unique` unable to block duplicate direct
// rows; the sentinel makes the index the single point of enforcement (same
// convention as policy.relation_tuples.DIRECT_SUBJECT).
export const DIRECT_MEMBER = "";

export const groupMembers = sqliteTable("group_members", {
  id: text("id").primaryKey(),
  groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  subjectNamespace: text("subject_namespace").notNull(),
  subjectId: text("subject_id").notNull(),
  subjectRelation: text("subject_relation").notNull().default(DIRECT_MEMBER),
  createdBy: text("created_by").references(() => users.id),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  unique("idx_group_members_unique").on(t.groupId, t.subjectNamespace, t.subjectId, t.subjectRelation),
  index("idx_group_members_group").on(t.groupId),
  index("idx_group_members_subject").on(t.subjectNamespace, t.subjectId, t.subjectRelation),
]);
