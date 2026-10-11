import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "@/modules/account/users/schema";

// `files.id` is a ULID — same convention as `items.id`. The first 10 chars
// encode the upload millisecond, so we sort by `id DESC` for newest-first
// without a separate timestamp column.
//
// `sha256` is the content key. Together with `storage_driver` it makes the
// `UNIQUE(sha256, storage_driver)` index — content-addressable dedupe per
// backend. A second upload of identical bytes against the same driver hits
// the existing row and only writes a new `file_references` entry; the blob
// is never re-stored.
//
// `ref_count` is the materialised count of `file_references` rows that point
// at this file. The async GC sweeper picks rows where `ref_count = 0` for
// deletion; the partial index keeps that scan O(unreferenced).
export const files = sqliteTable("files", {
  id: text("id").primaryKey(),
  sha256: text("sha256").notNull(),
  size: integer("size").notNull(),
  mimetype: text("mimetype").notNull(),
  storageDriver: text("storage_driver").notNull(),
  storageKey: text("storage_key").notNull(),
  refCount: integer("ref_count").notNull().default(0),
  uploadedBy: text("uploaded_by").notNull().references(() => users.id, { onDelete: "cascade" }),
}, t => [
  uniqueIndex("idx_files_sha_driver").on(t.sha256, t.storageDriver),
  index("idx_files_sha").on(t.sha256),
  index("idx_files_driver").on(t.storageDriver),
  // Partial index over the GC candidate set. SQLite supports partial
  // indexes; this keeps the sweeper's `SELECT … WHERE ref_count = 0` cheap
  // even at millions of total rows.
  index("idx_files_unreferenced").on(t.id).where(sql`ref_count = 0`),
]);

// `file_references` is the **reverse table** for the file module's
// bookkeeping. It is also the **attachment registry** for consumers —
// every other module that attaches a file just inserts a row here with its
// own `owner_type` discriminator. There is no per-consumer attachments
// table.
//
// owner_type / owner_id form the consumer-side join key. For attachments
// on items: `owner_type = 'item_attachment'`, `owner_id = <items.id>`.
// For a future user-avatar feature it could be
// `('user_avatar', <users.id>)`, and so on.
//
// UNIQUE(owner_type, owner_id, file_id) makes "the same blob can only
// appear once on the same owner" a DB-level guarantee. A consumer that
// wants two distinct uploads of the same content on the same owner must
// model them as two different owner_ids — which is generally what callers
// want (each upload is its own attachment).
//
// Filename is per-reference, not per-file: the same blob can appear under
// `screenshot.png` here and `photo.png` there.
//
// `metadata` is a consumer-controlled JSON blob ('{}' default) — captions,
// crop boxes, whatever the owning module needs. The file module treats it
// as opaque.
export const fileReferences = sqliteTable("file_references", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull().references(() => files.id, { onDelete: "restrict" }),
  ownerType: text("owner_type").notNull(),
  ownerId: text("owner_id").notNull(),
  filename: text("filename").notNull(),
  metadata: text("metadata").notNull().default("{}"),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex("idx_file_refs_unique").on(t.ownerType, t.ownerId, t.fileId),
  index("idx_file_refs_owner").on(t.ownerType, t.ownerId),
  index("idx_file_refs_file").on(t.fileId),
]);
