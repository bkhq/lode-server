# Item Module

Server-side primitive for content-style business objects (issues,
documents, and any future content type the project grows). The `item`
module owns the **common metadata, comments, and permission edges**; it
does **not** know about sub-type business fields.

Attachments live in the `file` module's `file_references` table (no
separate `item_attachments` table) keyed by `owner_type='item_attachment'`
+ `owner_id=<item.id>`. The template's reference sub-types (`issue` and
`document`) were removed in this fork, so no sub-type ships today; the
"add a new sub-type" recipe in §Adding a sub-type still applies.

## What the `item` module is, and what it isn't

It **is**: the table + service that every content sub-type composes onto.
A new sub-type owns a `<name>_details` table keyed by `item_id`, its own
service / routes / audit names, and writes its sub-type-specific policy
tuples — and that's it. Everything else (comments, soft delete,
optimistic concurrency, ownership tuple, parent-chain visibility) is
already done.

It **is not**: a route surface. There is no `/api/items` endpoint. The
module is consumed in process via `import { ItemService } from
"@/modules/item/item.service"`.

## Layered dependency rule

```
apps/api/src/modules/policy   ← apps/api/src/modules/item   ← apps/api/src/modules/<sub-type>
```

- `policy` knows nothing about `item`.
- `item` depends on `policy` (and `users`) only.
- Sub-types depend on `item`; **`item` does not import any sub-type
  schema or service**. Removing a sub-type from the build leaves the
  base compiling and its tests green.

## File layout

```text
apps/api/src/modules/item/
  schema.ts                          # items + item_comments (attachments live in mod-file's `file_references`)
  item.service.ts                    # CRUD + soft-delete + version + listItemsByIds / byType
  comment.service.ts                 # comment CRUD with flat reply model
  comment.routes.ts                  # mountItemCommentRoutes — shared comment + attachment routes
  attachment.permission.ts           # registers `item_attachment` hook (item-level attachments)
  comment-attachment.permission.ts   # registers `item_comment_attachment` hook (per-comment attachments)
  item.backup.ts                     # backup contribution
  index.ts                           # registers backup contribution + both permission hooks
  item.test.ts                       # unit tests
  comment.test.ts                    # unit tests
```

## Database

### `items`

| Column        | Type        | Notes                                                                                                       |
| ------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `id`          | text PK     | **ULID** (26 chars, lowercase Crockford). The first 10 chars encode the creation millisecond, so the column doubles as a creation-time index — `ORDER BY id DESC` is newest-first. Internal; not exposed externally. |
| `short_id`    | text UNIQUE | **nanoid** (8 chars, `[0-9a-z]`). The id surfaced in URLs, audit payloads, and API responses. Sub-types may pass a custom `shortId` to `createItem` for human-friendly tokens (e.g. `TKT-…`). Collisions surface immediately as a UNIQUE-constraint violation. |
| `type`        | text        | `'issue'`, `'document'`, …. Opaque to the base; sub-type defined.                                            |
| `title`       | text        | Required.                                                                                                    |
| `status`      | text        | Opaque marker; sub-type validates allowed values at the zod boundary.                                        |
| `creator_id`  | text FK     | `users.id ON DELETE CASCADE`.                                                                                |
| `version`     | integer     | Optimistic-concurrency counter; bumped on every update.                                                      |
| `deleted_at`  | text        | NULL = live. Set by soft-delete; read paths must filter on this.                                              |
| `updated_at`  | text        | ISO timestamp; auto-touched on update.                                                                       |

There is **no** `created_at` column. The creation timestamp lives in the
ULID prefix — decode `id.slice(0, 10)` as Crockford base32 if a wall-clock
value is needed. The `ulid()` helper in `shared/lib/id.ts` is the only
production source of new ids.

Indexes: `(short_id)` unique; `(type, deleted_at)`,
`(creator_id, deleted_at)`, `(type, status, deleted_at)`.

**Deliberately absent**: no `description`, no `data` JSON, no
`parent_id`, no `priority` / `assignee_id` / `due_date` / `tags`. Sub-
type business fields live in `<sub-type>_details` tables; sub-type
relationships live as `relation_tuples` rows under the `item` namespace.

### `item_comments`

| Column        | Type       | Notes                                                                  |
| ------------- | ---------- | ---------------------------------------------------------------------- |
| `id`          | text PK    | 8-char nanoid.                                                         |
| `item_id`     | text FK    | `items.id ON DELETE CASCADE`.                                          |
| `author_id`   | text FK    | `users.id ON DELETE CASCADE`.                                          |
| `reply_to_id` | text FK    | `item_comments.id ON DELETE SET NULL`. Single upward edge; flat model. |
| `content`     | text       | Required.                                                              |
| `is_internal` | integer    | `1` = hidden from viewer-only actors. Replies inherit from their target. |
| `created_at`  | text       | ISO.                                                                   |
| `updated_at`  | text       | ISO.                                                                   |

Indexes: `(item_id, created_at)`, `(author_id)`, `(reply_to_id)`.

#### Reply model (flat)

- `reply_to_id` is the only relationship between comments. No thread
  depth column, no path column. A comment either replies to exactly one
  other comment in the same item, or has `reply_to_id = NULL`.
- The UI renders replies inline in chronological order with a "replying
  to @author" badge that links to the target. We do not maintain a
  thread tree, so deep / cyclic graphs cannot form.
- `ON DELETE SET NULL` keeps replies readable when their target is
  deleted; the UI degrades gracefully to "(removed comment)".
- `is_internal` inheritance: if the target of a reply is internal, the
  reply is forced internal too. Sub-types decide who can post at all;
  the base guarantees threads don't leak across the visibility boundary.

## Soft delete + hard delete

Soft delete is the **only** user-facing delete path:

- `ItemService.softDeleteItem(db, id)` stamps `deleted_at` and removes
  every `relation_tuples` row keyed off the item (via
  `policy.deleteTuplesForEntity`). Read paths filter on `deleted_at IS
  NULL`, so the dead item disappears immediately.
- `ItemService.restoreItem(db, id)` clears `deleted_at`. Tuples are **not**
  re-issued; the sub-type is responsible for re-writing relations if it
  wants them back after restore.

Hard delete is **not** exposed on the user-facing routes. It belongs to
a future retention janitor (sub-types declare per-type windows; a
scheduled task hard-deletes anything past its window, also releasing
every `file_references` row keyed off the item via the `file` module's
`releaseAllByOwner`). The janitor is not implemented in this template.

## Permissions — via the `policy` module

The `item` namespace is declared in
`apps/api/src/modules/policy/namespace-config.ts` with seven relations:

| Relation      | Semantics                                                          |
| ------------- | ------------------------------------------------------------------ |
| `owner`       | Creator. Written automatically by `createItem`.                    |
| `editor`      | Can modify; implied by `owner`. Inherits via `parent_item`.        |
| `viewer`      | Can read; implied by `editor`. Inherits via `parent_item`.         |
| `assignee`    | Current handler; implied by `owner`. (Issue assignee, in practice.) |
| `approver`    | Approval-flow actor; no implicit inheritance.                      |
| `watcher`     | Notification subscriber; no implicit grant.                        |
| `parent_item` | Item→item edge (upward only). Sub-types like `document` use it for subtree visibility. |

Inheritance is wired through Zanzibar `tuple_to_userset` on the
`parent_item` tupleset — when checking `viewer` on item X, the policy
engine walks `(item, X, parent_item, item, Y)` edges and checks `viewer`
on Y; same for `editor`. Sub-types that build a hierarchy (document) are
responsible for keeping these tuples in sync with their business
hierarchy column at write time.

Sub-types call `policy.check` / `policy.listObjects` / etc. directly —
`ItemService` performs **no** permission checks of its own. Each
sub-type route is the permission boundary.

## `ItemService` surface

All methods take `db: AppDatabase` as the first argument.

| Method                                                          | What it does                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `createItem({ type, title, status, creatorId, shortId?, id? })` | Inserts the items row + the `(item, X, owner, user, creator)` tuple atomically.                             |
| `getItemById(id)`                                               | Returns the live row (filters `deleted_at IS NULL`).                                                        |
| `getItemByShortId(shortId)`                                     | Same, keyed by `short_id`.                                                                                  |
| `resolveItem(idOrShortId)`                                      | Accepts either id; returns the live row.                                                                    |
| `assertItemExists(id)`                                          | Throws `NotFoundError` if absent.                                                                            |
| `updateItem(id, { title?, status?, shortId?, expectedVersion? })` | Bumps `version`. Returns `VersionConflict` instead of writing if `expectedVersion` mismatches.            |
| `softDeleteItem(id)`                                            | Stamps `deleted_at`; cleans every tuple keyed off the item.                                                  |
| `restoreItem(id)`                                               | Clears `deleted_at`. Tuples are **not** re-issued.                                                           |
| `listItemsByIds(ids, filter?)`                                  | Lists live items whose id is in `ids`, with optional `type` / `status` / title-`search` / pagination.       |
| `listItemsByType({ type, status?, search?, page?, limit? })`    | Convenience for admin / test paths; bypasses any permission filtering.                                       |

`ItemService` performs no audit emission. Sub-types own their action
names (`issue.created`, `document.created`, …) and emit at the route
layer.

### Comments

| Method                                                          | What it does                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `listComments(itemId, { includeInternal })`                     | Lists comments for an item, ordered `createdAt ASC, id ASC`. Caller passes `true` only for non-viewer actors. |
| `getCommentById(itemId, commentId)`                             | Fetches one row, scoped to the item.                                                                         |
| `createComment({ itemId, authorId, content, replyToId?, isInternal? })` | Validates the reply target (exists + same item); coerces `isInternal` from the parent.              |
| `deleteComment(commentId)`                                      | Hard delete. FK `ON DELETE SET NULL` keeps replies readable. **Does not cascade-release the comment's attachments** — callers should `DELETE /comments/:cid/attachments/:aid` first; remaining references become orphans handled by the file module's GC. |

### Comment attachments

Comments can carry their own attachments. The reference's `owner_type`
is `item_comment_attachment` (distinct from item-level `item_attachment`),
and the matching permission hook (`comment-attachment.permission.ts`)
maps `ref.ownerId` → `item_comments.id` → `item_comments.item_id` and
delegates to the policy engine:

- `canRead` — `viewer` on the parent item (`editor` when the comment is
  internal, so viewer-only callers don't see internal attachments via
  direct file URLs).
- `canDelete` — uploader (`ref.createdBy === actor.id`) or admin. The
  route layer guarantees the uploader is the comment author.

## Shared comment + attachment routes

`comment.routes.ts` exports `mountItemCommentRoutes(router, opts)` — a
factory that wires the seven comment + comment-attachment routes onto a
sub-type's Hono router. **Sub-types do not re-implement these
endpoints**; they only supply the two hooks `resolve` (id param →
parent item + sub-type row) and `permissions` (per-request access read).

Routes mounted (with `routePrefix` substituted):

| Method | Path                                                 |
| ------ | ---------------------------------------------------- |
| GET    | `<prefix>/:id/comments`                              |
| POST   | `<prefix>/:id/comments`                              |
| DELETE | `<prefix>/:id/comments/:cid`                         |
| GET    | `<prefix>/:id/comments/:cid/attachments`             |
| POST   | `<prefix>/:id/comments/:cid/attachments`             |
| GET    | `<prefix>/:id/comments/:cid/attachments/:aid`        |
| DELETE | `<prefix>/:id/comments/:cid/attachments/:aid`        |

Per-request hooks:

```ts
interface CommentPermissions {
  canRead: boolean;                                 // list comments + read attachments
  canPost: boolean;                                 // create a comment (covers `commentsLocked` etc.)
  includeInternal: boolean;                         // does `listComments` return is_internal=1 rows?
  canDelete: (commentAuthorId: string) => boolean;  // delete that specific comment
}
```

Hard rules the factory enforces directly (sub-types **cannot** override):

- **Comment-attachment upload** is allowed only when
  `comment.authorId === user.id`. Admins do not bypass this — the
  attachment belongs to the speech act, not to the resource.
- **Comment-attachment delete** is allowed when
  `ref.createdBy === user.id` (i.e. the original uploader) or
  `user.role === "admin"`.
- Audit action names use `${resourceType}.comment_added`,
  `${resourceType}.comment_deleted`,
  `${resourceType}.comment_attachment_uploaded`,
  `${resourceType}.comment_attachment_deleted`.
- Maximum comment body length defaults to 2000 chars; sub-types pass
  `maxCommentLength` to widen it (documents use 10000).

A sub-type's routes file calls the factory once and is done with comments /
comment attachments. (The template's `issue` and `document` sub-types did
exactly that; both were removed in this fork.)

## What's intentionally not shipped

| Feature                  | Why we don't ship it                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `items.data` JSON column | Sub-types own typed columns in `<sub-type>_details` tables — better indexing, real constraints.   |
| `item_types` registry    | Sub-types are wired in code (one module per type), not stored as data.                            |
| `item_extensions` table  | Sub-types use real tables when they need 1:N detail rows; not yet needed.                         |
| `item_activity` stream   | The existing `audit_events` already answers "who did what, when".                                 |
| `item_revisions`         | No sub-type currently needs versioned snapshots. Revisit when one does.                           |
| Per-type short-id prefix | Sub-types can override `shortId` per row if they want `TKT-…` style ids; no generator yet.        |
| `items_fts` virtual table | FTS5 has no Drizzle representation; the base uses `LIKE` on title until a cross-module FTS lands. |

## Adding a sub-type — recipe

The template's reference sub-types, `issue` and `document`, were removed in
this fork, so there is no worked example in the tree. A sub-type follows
this shape:

1. **Schema** — `apps/api/src/modules/<name>/schema.ts`. One table,
   `<name>_details`, primary-keyed on `item_id text REFERENCES items.id
   ON DELETE CASCADE`. Put **only** the columns that are unique to your
   sub-type. Resist the temptation to add a JSON blob; if you need a
   structured field, add a column.

2. **Service** — `apps/api/src/modules/<name>/<name>.service.ts`. The
   service composes:
   - `items` (via direct insert/update inside a tx for the base columns),
   - `<name>_details` (the sub-type-specific row),
   - `relation_tuples` (`owner` is always written on create; sub-types
     write additional relations as their actions demand — issue writes
     `assignee`, document writes `parent_item` + `viewer` / `editor` shares).

   Return a composite "row view" from the service (e.g.
   `{ id, title, status, priority, ... }` for an issue) so routes and
   tests see a single object regardless of which physical table each
   field lives in.

3. **Routes** — `apps/api/src/modules/<name>/<name>.routes.ts`. URL prefix
   is `/api/<name>` (plural). The routes are the API contract; the
   underlying `items` + `<name>_details` composition must not leak into
   wire payloads.

4. **Audit** — sub-type emits all audit lines using `<name>.<verb>`
   (`issue.created`, `document.deleted`). The base does not emit audit.

5. **Backup** — `<name>.backup.ts`:

   ```ts
   export const <name>BackupContribution: BackupContribution = {
     name: '<name>s',
     tables: [<name>Details],
     deps: ['items', 'policies'],
   };
   ```

   Register from `index.ts` via `registerBackupContribution`.

6. **i18n shard** — under `apps/web/src/.../<name>/locales/{en,zh}.json`,
   per the rules in [`develop/module/standards.md`](../develop/module/standards.md#34-i18n-sharding-mandatory).

7. **Nav entry** — `<name>.nav.ts` exporting a `NavItem`, picked up by
   `apps/web/src/shared/components/sidebar/registry.ts`.

8. **Tests** — service-level tests under `<name>.test.ts`. Cover:
   - create with required fields → composed row + owner tuple written
   - update bumps `items.version`
   - sub-type-specific relations get written / rewritten / cleared by
     the right service methods
   - soft-delete via `items.deleted_at` removes the item from list paths
     and clears every `relation_tuples` row for the item

9. **Side-effect wiring** — sub-type `index.ts` registers the backup
   contribution at module load; `routes/protected.ts` imports the
   sub-type's `*Routes()` factory; `db/schema.ts` gets one
   `export * from "@/modules/<name>/schema"` line. That's the entire
   aggregate-file surface.

## Anti-patterns

These mistakes are easy to make against a tier-C base. The codebase's
existing modules avoid all of them — match the existing shape.

1. **Adding a `data` JSON column or sub-type-specific JSON to `items`.**
   The base has no such column on purpose. Typed columns in
   `<name>_details` are how sub-type fields land.
2. **Reaching past `<name>_details` to write business data into other
   sub-types' detail tables.** Each sub-type owns its detail table.
   Cross-type relationships go through `relation_tuples`.
3. **Bypassing the policy namespace for "ownership" semantics.**
   Owner / editor / viewer / assignee / approver are all `relation_tuples`
   rows. A new sub-type that invents its own `assignee_id` column on
   `<name>_details` is doing the same thing twice.
4. **Hard-deleting through the base.** `ItemService.softDeleteItem` is
   the only base-supplied delete. The eventual retention janitor
   handles physical removal.
5. **Letting an attachment / comment ID escape as the sub-type's primary
   id.** Item attachments live in `file_references` keyed by `(owner_type,
   owner_id)`. The reference id is what shows up in URLs; the underlying
   `files.id` is internal.
6. **Re-implementing comment storage.** Use `ItemService.createComment /
   listComments` etc. — the reply / `is_internal` semantics are
   centralised here.
7. **Adding cross-sub-type joins inside `mod-item`.** The base must stay
   ignorant of sub-types — joining `items` to `issue_details` inside
   `ItemService` would create a dependency edge in the wrong direction.

## See also

- [`policy.md`](./policy.md) — the Zanzibar engine that powers the
  `item` namespace.
- [`file.md`](./file.md) — blob storage behind item and comment attachments.
