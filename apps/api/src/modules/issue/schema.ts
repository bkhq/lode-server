import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { items } from "@/modules/item/schema";

// `issue` is a Tier-C sub-type of the `item` base. The base owns the
// universal columns (title / status / creator / version / soft-delete /
// timestamps) and the comments / attachments machinery; this table holds
// only the issue-specific business fields.
//
// What lives in `items` (base, queried via ItemService):
//   - id, short_id, type='issue', title, status, creator_id, version,
//     deleted_at, updated_at
//
// What does NOT live here on purpose:
//   - assignee_id → a policy tuple `(item, X, assignee, user, Y)`; the
//     policy engine is the single source of truth for "issues assigned
//     to me" lookups.
//   - comments → `item_comments`.
//   - attachments → `file_references` with owner_type='item_attachment',
//     owner_id=<items.id>.
export const issueDetails = sqliteTable("issue_details", {
  itemId: text("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  description: text("description"),
  priority: text("priority", {
    enum: ["low", "medium", "high", "urgent"],
  }).notNull().default("medium"),
  dueDate: text("due_date"),
});
