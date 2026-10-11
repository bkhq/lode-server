# Policy Implementation Standard

This is the **contract** every module follows when it puts access
control on its routes. The `policy` module is the foundation; this
document specifies how downstream modules plug in.

> If you only want to understand the engine internals, read
> [`policy.md`](../../modules/policy.md). If you're adding permissions to a module,
> read this file end-to-end before writing code — the patterns below
> are mandatory for new modules and recommended for existing ones.

## Why a framework

A template grows by adding modules. Each module brings new resources
(notifications, secrets, dashboards, cron jobs, …) and each resource
needs:

- a way to **describe** its permissions
- a way to **enforce** them on routes
- a way to **react** to lifecycle events (delete, grant, audit)
- a way to **discover** what permissions exist for tooling / docs

If every module wires those four concerns by hand, the codebase drifts
the moment two authors disagree on naming, error shape, or audit
emission. The policy framework provides one well-typed surface so the
disagreement never starts.

## Architecture in one picture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Module (notifications, secrets, dashboards, …)                       │
│                                                                       │
│   defineResource({                                                    │
│     name, namespace, actions, hooks                                   │
│   })                            ──► registers in module registry      │
│                                                                       │
│   const access = defineResource({...})                                │
│   router.use(requirePermission(access, "verb"))                       │
│   await access.grant(ctx, ...)                                        │
│                                                                       │
└─────────────┬─────────────────────────────────────┬──────────────────┘
              │                                     │
       declares spec                          calls runtime
              │                                     │
              ▼                                     ▼
┌─────────────────────────────┐    ┌──────────────────────────────────┐
│  policy/registry.ts          │    │  policy/permission.ts             │
│    ResourceDefinition map    │    │    ResourceAccess (can / grant /  │
│    Hook contracts            │    │    revoke / cascadeDelete)        │
│    Manifest generator        │    │    fires hooks at lifecycle pts   │
└─────────────────────────────┘    └──────────────────────────────────┘
                                                 │
                                                 ▼
                                ┌────────────────────────────────────────┐
                                │  policy/zanzibar.engine.ts              │
                                │    check / expand / listUserResources   │
                                │    relation_tuples table                │
                                └────────────────────────────────────────┘
```

Three vocabularies, narrowing left to right:

| Layer | Speaks in | Example |
|---|---|---|
| Module | **Actions** | `"notification:dismiss"` |
| Framework | **Definitions + Hooks** | `{ name: "notification", actions: {...}, hooks: {...} }` |
| Engine | **Tuples + Relations** | `notification:n123#owner@user:u456` |

Module code never names a relation. The action → relation mapping lives
in the definition; rewriting it is one diff in one file.

## The full surface

Exported from `@/modules/policy`:

```ts
// Definition
defineResource({...})  → ResourceAccess
registerResource({...})              // low-level, when you can't define at module load
getResource(name) / getAllResources() / getPermissionManifest()

// Runtime
ResourceAccess<TAction> {
  name, namespace, definition,
  can(ctx, action, objectId),
  canSubject(db, subject, action, objectId),
  assert(ctx, action, objectId),          // throws ForbiddenError on deny
  listObjectsFor(db, userId, action),
  grant(ctx, { subject, relation, objectId }),
  revoke(ctx, { subject, relation, objectId }),
  cascadeDelete(db, objectId),
  actionToRelation(action),               // escape hatch
}

// Hono integration
requirePermission(access, action, { idParam? | idFrom? })   // middleware
policyContext(c)                                            // build PolicyContext from Hono ctx

// Subject helpers
userSubject(id)
groupSubject(id, relation = "member")
type Subject = { type: string; id: string; relation?: string }
```

## ResourceDefinition contract

```ts
interface ResourceDefinition<TAction extends string> {
  readonly name: string;          // unique inventory key — "notification", "secret"
  readonly namespace: string;     // underlying tuple namespace; can be shared
  readonly description?: string;  // surfaces in the manifest endpoint
  readonly actions: Readonly<Record<TAction, string>>;
  readonly hooks?: ResourceHooks;
}
```

### `name`

Globally unique across the whole app. Conventions:

- singular noun (`"notification"`, not `"notifications"`)
- kebab-case for multi-word resources (`"cron-job"`)
- matches the audit `resourceType` you emit — renaming breaks
  searchability of historical audit logs

### `namespace`

The `relation_tuples.namespace` you write into. Either:

- **Reuse `"item"`** if the resource is content-shaped (has owner /
  editor / viewer / assignee / approver / watcher; needs parent-chain
  inheritance). The template's `document` and `issue` modules (removed in
  this fork) both did this.
- **Register a new namespace** otherwise, with `registerNamespace` from
  `@/modules/policy`, called in the module's `index.ts`.
  Keep namespaces narrow: one per *kind* of access ladder.

### `actions`

Module verbs, each mapped to the **lowest** relation that satisfies
the verb. The engine walks `computed_userset`, so listing the floor is
enough — `"read": "viewer"` succeeds for `"editor"`, `"owner"`, etc.

```ts
actions: {
  "notification:read":    "viewer",
  "notification:dismiss": "owner",
} as const
```

The `as const` matters: it narrows the action keys to a literal union
so typos compile-fail.

Naming convention: `<module>:<verb>`. Pick verbs at the **product
level**, not the relation level — `"document:manage"` is durable, but
`"document:owner"` ties the action name to today's relation mapping.

### `hooks`

Every hook is optional. Each one extends the framework at a specific
lifecycle point.

| Hook | When | Use for |
|---|---|---|
| `resolveObjectId` | Once per HTTP request, inside `requirePermission` middleware | map URL `:id` (short id, slug) → engine objectId |
| `bypass` | Before every `can()` check | admin role / system actor / tenant super-user |
| `canGrant` | Before `grant()` writes | gate who can hand out relations |
| `canRevoke` | Before `revoke()` writes | gate who can take grants back |
| `onGranted` | After a successful grant | audit, notify, cache-invalidate |
| `onRevoked` | After a successful revoke | audit, notify, cache-invalidate |

### Request-scoped cache

`policyContext(c)` attaches a `PermissionCache` to the context. Every
`can` / `assert` / field check on that context memoises the engine's
answer for `(namespace, object, relation, actor)`, and the actor's group
closure (nested groups flattened) is resolved once and handed to the
engine, so a `group:G#member` userset is a set lookup instead of a
per-group recursion. The middleware gate and a handler's own `assert`
on the same object therefore cost one resolution, and `filterWritable`
/ `projectFields` no longer re-walk the graph per restricted field.

`grant` / `revoke` / `cascadeDelete` clear the cache. The cache lives and
dies with the request, so there is no cross-request invalidation. Hooks
(`bypass`, `onChecked`) still run on every call — only the graph walk is
memoised. Code that writes tuples directly and then checks permissions in
the same request must call `ctx.cache?.clear()` itself. A context built
by hand without a `cache` (cron actors, internal helpers) resolves live.
| `onChecked` | After every check (use sparingly!) | per-request audit sampling |
| `resolveEntity` | On demand by audit / UI | render `name` instead of opaque id |

**Hook execution model**

- Synchronous-style: all hooks are awaited inline before the next step.
- Throwing rejects the request. `bypass` throwing fails the request
  even if the engine would have allowed; treat hook errors as terminal.
- Order: `bypass → engine.check → onChecked` (for `can`),
  `canGrant → engine.createTuple → onGranted` (for `grant`), and
  `canRevoke → engine.deleteTupleByKey → onRevoked` (for `revoke`).
- `cascadeDelete` deliberately fires **no** hooks — it would flood the
  audit pipeline on bulk cleanup. If you need per-tuple events on
  delete, iterate explicitly through `revoke()`.

## Recipe: adding permissions to a new module

```ts
// apps/api/src/modules/notifications/index.ts
import { defineResource, userSubject } from "@/modules/policy";
import { registerBackupContribution } from "@/modules/backup/registry";
import { notificationBackupContribution } from "./notification.backup";

export const notificationAccess = defineResource({
  name: "notification",
  namespace: "notification",
  description: "User-addressed notifications. Owned by the recipient.",
  actions: {
    "notification:read":    "viewer",
    "notification:dismiss": "owner",
  } as const,
  hooks: {
    bypass: ctx => ctx.actor.role === "admin",
    resolveEntity: async (db, id) => {
      const n = await db.select({ title: notifications.title })
        .from(notifications).where(eq(notifications.id, id)).get();
      return n ? { name: n.title, type: "notification" } : null;
    },
  },
});

registerBackupContribution(notificationBackupContribution);
```

If the resource's URL exposes an external id (short id, slug) that
differs from the engine's internal id, declare one extra hook —
that's all the module-specific glue the middleware needs:

```ts
// document.permission.ts — shared item base, external short_id in URL
hooks: {
  resolveObjectId: async (c) => {
    const shortId = c.req.param("id");
    if (!shortId) return null;
    const row = await c.get("db")
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.shortId, shortId), eq(items.type, "document"), isNull(items.deletedAt)))
      .get();
    return row?.id ?? null;        // null → 404 from the middleware
  },
  // ...
}
```

After this is declared, every gated route uses the **same global
middleware**:

```ts
router.patch("/documents/:id", requirePermission(documentAccess, "document:update"), ...)
router.delete("/documents/:id", requirePermission(documentAccess, "document:delete"), ...)
```

No module-specific `requireXxxPermission` wrapper. The framework
chains: `idFrom?` (explicit per-route) → `resolveObjectId` (module
default) → `c.req.param(idParam ?? "id")` (raw passthrough).

### Zero-config — global middleware + declarative route table

Drop **all** per-route gating. Declare the route table inside the
resource definition, mount one global middleware in `app.ts`, and the
framework enforces every gated route automatically:

```ts
// apps/api/src/modules/notifications/notification.permission.ts
export const notificationAccess = defineResource({
  name: "notification",
  namespace: "notification",
  actions: {
    "notification:read":    "viewer",
    "notification:dismiss": "owner",
  } as const,
  routes: [
    { method: "GET",    path: "/notifications/:id", action: "notification:read" },
    { method: "DELETE", path: "/notifications/:id", action: "notification:dismiss" },
  ] as const,
  hooks: {
    resolveObjectId: async (c, params) => params.id ?? null,
  },
});
```

```ts
// apps/api/src/modules/notifications/notification.routes.ts — pure Hono
export function notificationRoutes() {
  const router = new Hono<AppEnv>();
  router.use("*", authRequired);

  // No requirePermission — the global mw gates every route in
  // `defineResource.routes` based on method + path.
  router.get("/notifications/:id",    getHandler);
  router.delete("/notifications/:id", dismissHandler);
  return router;
}
```

```ts
// apps/api/src/app.ts — one line at the framework level
api.use("*", policyMiddleware({ basePath: `${config.BASE_PATH}/api` }));
```

What the global middleware does, per request:

1. Compile the route table to regexes (once, cached).
2. Match `(method, path)` — no match → pass through (unregistered route).
3. Resolve the actor via `c.get("user")` or the auth provider.
4. **Admin role → bypass** (no DB queries).
5. Look up the `ResourceAccess` by `resourceName` — missing → 500 (a
   binding without a definition is a wiring bug; the gate fails closed).
6. Extract URL params from the regex match → call
   `hooks.resolveObjectId(c, params)` → object id.
7. Run `access.can(ctx, action, objectId)` → 403 on deny.

`authRequired` becomes idempotent: when the global middleware ran
first and stashed the user, `authRequired` short-circuits. The order
inside a module's router (`router.use("*", authRequired)` → handlers)
is unchanged; the global middleware just gets there before the
sub-app's `authRequired` runs.

```ts
// apps/api/src/modules/notifications/notification.routes.ts
import { requirePermission, policyContext, userSubject } from "@/modules/policy";
import { notificationAccess } from ".";

export function notificationRoutes() {
  const router = new Hono<AppEnv>();

  router.get(
    "/notifications/:id",
    authRequired,
    requirePermission(notificationAccess, "notification:read"),
    async (c) => { /* return notification */ },
  );

  router.post("/notifications", authRequired, async (c) => {
    const ctx = policyContext(c)!;
    const body = createNotificationSchema.parse(await c.req.json());
    const n = await createNotification(c.get("db"), body);
    // Mark the recipient as owner so they can dismiss it.
    await notificationAccess.grant(ctx, {
      subject: userSubject(body.recipientId),
      relation: "owner",
      objectId: n.id,
    });
    return c.json({ success: true, data: n }, 201);
  });

  router.delete(
    "/notifications/:id",
    authRequired,
    requirePermission(notificationAccess, "notification:dismiss"),
    async (c) => {
      const id = c.req.param("id");
      await deleteNotification(c.get("db"), id);
      await notificationAccess.cascadeDelete(c.get("db"), id);
      return c.json({ success: true, data: null });
    },
  );

  return router;
}
```

```ts
// apps/api/src/modules/notifications/notification.service.ts — list endpoint
export async function listMyNotifications(db, userId) {
  const ids = await notificationAccess.listObjectsFor(db, userId, "notification:read");
  if (ids.length === 0) return [];
  return await db.select().from(notifications).where(inArray(notifications.id, ids)).all();
}
```

Five touch points. That's the whole loop:

1. **Declare** the resource in `index.ts` (one `defineResource` call).
2. **Gate** reads / mutations with `requirePermission` middleware.
3. **Grant** the initial relation on entity creation.
4. **Filter** lists with `listObjectsFor`.
5. **Cascade** on delete.

## Worked migration — `document` module

The template's document module is the **reference implementation** of every
pattern in this guide. It was removed in this fork, so the files below are
not in this tree; read them in the upstream template as a real-world example
before adding permissions to your own module:

- `document.permission.ts` — the resource declaration. 10 actions across read / edit / manage. Hooks for admin bypass, owner-only `canGrant` / `canRevoke`, audit emission on share lifecycle, entity resolution for the manifest UI.
- `document.routes.ts` — pure Hono. Enforcement comes from the **global `policyMiddleware`** (mounted in `app.ts`) driven by the route table declared via `defineResource.routes` in `document.permission.ts`. The middleware resolves the URL `:id` (a short_id) to the underlying `items.id` per the table's `idFrom` callback and calls `documentAccess.assert(...)` before the handler runs. The previous `assertAccess` / `assertOwnerOrAdmin` helpers are gone; admin / owner / shared-editor / parent-chain inheritance all funnel through one engine call. (Handlers that need a check beyond the URL `:id` — e.g. the document `move` route validating the *target* parent — still call `documentAccess.assert(ctx, action, id)` directly.)
- `document.service.ts` — `addDocumentShare` / `removeDocumentShare` route writes through `documentAccess.grant` / `documentAccess.revoke`, so the framework fires `canGrant` and `onGranted` for every code path that issues a share (route handler, future bulk-share scripts, the admin debug tool).

What lives where, after the migration:

| Concern | Before | After |
|---|---|---|
| Permission decision (read / edit / delete / share / lock) | `assertAccess(db, user, doc, "viewer"/"editor")` and `assertOwnerOrAdmin(user, doc)` scattered across 13 routes | Global `policyMiddleware` matches the route table in `document.permission.ts` and gates each request with `documentAccess.assert("document:read"/"document:update"/"document:manage"/…)` |
| Admin bypass | `if (user.role === "admin") return;` repeated in every helper | `bypass: ctx => ctx.actor.role === "admin"` in one place |
| Owner-only-can-share | `assertOwnerOrAdmin` called from three share routes | `canGrant: (ctx, p) => isAdminOrOwner(ctx, p.objectId)` runs inside `grant()` |
| Comment / attachment read gate | Manual `assertAccess viewer` lookup before list/download | Global `policyMiddleware` matches `defineResource.routes` and gates the request |
| Audit emission for shares | Two `audit()` calls in two route handlers, with risk of drift | `onGranted` / `onRevoked` hooks in the resource definition |
| Comment lock (owner-only fragment of an editor action) | Inline `if (!isOwner && !isAdmin)` in the patch handler | `fields.write.commentsLocked = "owner"` + `documentAccess.filterWritable(...)` in the handler |

The net effect: the document module's route file is ~30 lines shorter
and the rules it enforces are visible at a glance in `document.permission.ts`.

### Verbs the document module exposes

```ts
actions: {
  // Read group — floor = viewer
  "document:read":              "viewer",
  "document:download":          "viewer",
  "document:read_comments":     "viewer",

  // Edit group — floor = editor (shared editors gain all of these via the share tuple)
  "document:update":            "editor",
  "document:upload":            "editor",
  "document:delete_attachment": "editor",
  "document:comment":           "viewer",   // posting is read+commentsLocked check

  // Manage group — floor = owner (only the creator and admins, even shared editors are out)
  "document:delete":            "owner",
  "document:manage":            "owner",
}

// Owner-only **fields** inside an editor-grade PATCH (e.g.
// `commentsLocked`) belong in the `fields.write` table, not as
// separate actions:
fields: {
  write: { commentsLocked: "owner" },
}
```

This is the exact pattern other content modules should follow: cluster
verbs by relation, name them with the `<module>:<verb>` convention, let
the engine resolve inheritance.

## Worked patterns

### Pattern: shared `item` base (document, issue style)

When a resource is content-shaped, **reuse the `item` namespace**
instead of registering your own. You get owner / editor / viewer /
assignee / approver / watcher and parent-chain inheritance for free.

```ts
defineResource({
  name: "document",
  namespace: "item",                       // shared with issue, etc.
  actions: {
    "document:read":   "viewer",
    "document:update": "editor",
    "document:delete": "editor",
    "document:manage": "owner",
    "document:share":  "owner",
  } as const,
});
```

`ItemService.createItem` already writes the owner tuple in the same
transaction as the items row, so no `grant` call is needed at create
time.

### Pattern: admin / system bypass

Bypass goes in the hook, **not** scattered through route handlers:

```ts
hooks: {
  bypass: (ctx) => {
    if (ctx.actor.role === "admin") return true;
    if (ctx.actor.type === "system") return true;   // cron, backup
    return false;
  },
}
```

The hook fires once per check — keeping admin bypass in the definition
means there's one place to grep when audit asks "who can override this
resource?".

### Pattern: only owners can grant

When you want grants gated by current relation:

```ts
hooks: {
  canGrant: async (ctx, params) => {
    const result = await check(ctx.db, "item", params.objectId, "owner", "user", ctx.actor.id);
    return result.allowed;
  },
}
```

Equivalent to `await access.can(ctx, "document:manage", id)` — but you
cannot call the wrapper from inside its own hook (infinite recursion).
Either inline the engine call as shown, or check from the route layer
before invoking `grant`.

### Pattern: subject-side cascade (group / token deletion)

When deleting a **subject**, every tuple where it appears as subject
must go too:

```ts
// account/users/users.service.ts
import { deleteTuplesForEntity } from "@/modules/policy/policy.service";

export async function deleteUser(db, userId) {
  await db.delete(users).where(eq(users.id, userId));
  await deleteTuplesForEntity(db, "user", userId);
  // Subject also appears in `group_members` (account-owned). Add a helper
  // there if the subject can join groups, since `deleteTuplesForEntity`
  // only touches `relation_tuples`.
}
```

`cascadeDelete` on the wrapper covers both object-side and subject-side
tuples for the resource's own namespace; if the resource is a subject
type, prefer the lower-level `deleteTuplesForEntity` since there's no
"resource" to wrap. Note that `deleteTuplesForEntity` only touches
`relation_tuples`; if the entity can appear in `group_members`
(users, nested groups), clean that store separately via the account
module — see `groups.service.deleteGroup` for the pattern.

### Pattern: parent-chain inheritance

If items in your module form a tree (folder / sub-folder / file), and
deeper items should inherit relations from their parent, write a
`parent_item` tuple at create time:

```ts
// On createDocument
await policy.createTuple(db, {
  namespace: "item",
  objectId: childItemId,
  relation: "parent_item",
  subjectNamespace: "item",
  subjectId: parentItemId,
}, actorId);
```

The engine's `tuple_to_userset` walks this edge automatically when
checking `viewer` or `editor`. No work on the module side beyond
keeping the edge in sync with the business hierarchy.

### Pattern: custom subject type (service-account, api-token)

Register the namespace from the module's `index.ts`:

```ts
import { registerNamespace } from "@/modules/policy";

registerNamespace({ name: "service_account" });
```

Then use it as a subject:

```ts
import type { Subject } from "@/modules/policy";

const tokenSubject: Subject = { type: "service_account", id: tokenId };
await access.grant(ctx, { subject: tokenSubject, relation: "editor", objectId: docId });

// And configure the actor at the request layer:
const ctx = {
  db,
  actor: { id: tokenId, type: "service_account" },
};
const allowed = await access.can(ctx, "document:update", docId);
```

The engine treats any namespace as a valid subject — no engine changes
required.

### Pattern: tenant scoping

Every grant carries the resource id. The tenant id lives in
`actor.metadata`:

```ts
hooks: {
  bypass: (ctx, _action, objectId) => {
    // Reject cross-tenant requests outright. The actual permission decision
    // is still made by the engine, but we hard-stop before it.
    const tenant = ctx.actor.metadata?.tenantId;
    if (tenant && !objectId.startsWith(`${tenant}/`)) {
      throw new ForbiddenError("Cross-tenant access");
    }
    return false;
  },
}
```

### Pattern: audit emission

Audit goes through `onGranted` / `onRevoked`, **not** the route handler:

```ts
import { audit } from "@/modules/audit/audit.service";

hooks: {
  onGranted: async (ctx, tuple) => {
    await audit(ctx.db, {
      actorId: ctx.actor.id,
      action: "notification.granted",
      resourceType: "notification",
      resourceId: tuple.objectId,
      detail: { relation: tuple.relation, subject: `${tuple.subjectNamespace}:${tuple.subjectId}` },
      ip: ctx.request?.ip ?? "unknown",
      userAgent: ctx.request?.userAgent ?? "unknown",
      result: "success",
    });
  },
}
```

Two reasons: (1) you can't forget to audit a grant — every code path
that grants fires the hook; (2) admin-debug grants from
`/api/policy/tuples` and module-driven grants emit the same shape, so
the audit log is queryable by `resourceType + action`.

## Field-level read / write

Route-level actions are coarse: `document:update` admits any editor.
When **one column** within a row needs a stricter rule (audit log
visible only to owners; comments-lock toggle reserved for owners
inside an editor PATCH), declare it in `fields`:

```ts
defineResource({
  // ...
  fields: {
    write: {
      commentsLocked: "owner",          // editors PATCH the doc but cannot flip the lock
    },
    read: {
      auditTrail: "owner",              // visible to owner / admin only
      hiddenInternalNote: "editor",     // not exposed to viewer-grade callers
    },
  },
});
```

Fields **not listed** are unrestricted — anyone the route action
admitted may read / write them. Listing every column would create
maintenance noise; use the table to call out the few sensitive ones.

### Read side — `projectFields`

```ts
const ctx = policyContext(c)!;
const row = await getDocumentRow(db, id);
const visible = await documentAccess.projectFields(ctx, item.id, row);
return c.json({ success: true, data: visible });
```

Fields listed in `fields.read` that the actor lacks the relation for
are **stripped silently**. Caller decides whether to surface "this
field exists but you can't see it" to the user — the engine's job is
just to project the row.

For a single-field decision (e.g. rendering a UI flag without sending
the column at all):

```ts
const showAudit = await documentAccess.canReadField(ctx, "auditTrail", item.id);
```

### Write side — `filterWritable`

```ts
const body = updateSchema.parse(await c.req.json());
const safe = await documentAccess.filterWritable(ctx, item.id, body, {
  onForbidden: "reject",       // throw 403; default is "strip"
});
await updateDocument(db, id, safe);
```

Two modes:

- **`"strip"` (default)**: drop forbidden fields silently. The handler
  proceeds with the safe subset. Right for forgiving PATCH endpoints
  where a UI may send fields the user can't actually modify (e.g. the
  same form serves admin + editor).
- **`"reject"`**: throw `ForbiddenError` with the list of denied
  fields. Right when the UI promised an atomic update — silently
  dropping `commentsLocked` after a user toggled it would surprise
  them.

Per-field decisions follow the same priority chain as route actions:
hook `bypass` → engine `check` → deny. Bypass hooks see the operation
key as `<resource>:field.<read|write>:<field>` so a single
`bypass: ctx => ctx.actor.role === "admin"` covers route AND field
checks uniformly.

### Worked example — `commentsLocked` on documents

```ts
// Declaration (resource definition, one entry)
fields: { write: { commentsLocked: "owner" } }

// Enforcement (route handler, one line)
const safe = await documentAccess.filterWritable(ctx, item.id, body, { onForbidden: "reject" });
```

No separate `document:lock_comments` action, no inline `isOwner/isAdmin`
checks in the patch handler. The field rule lives next to the rest of
the document's policy contract.

The lock rule now lives in the resource declaration, where it sits
next to the rest of the document's policy contract.

## Anti-patterns

### Calling the engine directly from a module

```ts
// ❌  Module knows about "editor" — leak from the relation layer.
const ok = await check(db, "item", id, "editor", "user", user.id);

// ✅  Module knows about "document:update" only.
const ctx = policyContext(c)!;
const ok = await documentAccess.can(ctx, "document:update", id);
```

The engine call is fine *inside a hook* (it doesn't recurse through
the wrapper), or in cross-module helpers — but not from a route or
service in the resource's own module.

### Admin bypass scattered through handlers

```ts
// ❌  Every route owns its bypass; one of them will forget.
if (user.role === "admin" || await access.can(ctx, action, id)) ...

// ✅  Bypass is part of the definition. Routes use can(), unconditionally.
hooks: { bypass: ctx => ctx.actor.role === "admin" }
if (await access.can(ctx, action, id)) ...
```

### Per-row `can()` in list endpoints

```ts
// ❌  O(N) calls against the engine.
const visible = (await listAll(db)).filter(async row => await access.can(ctx, "x:read", row.id));

// ✅  One query for the visible set, then one row-fetch.
const ids = await access.listObjectsFor(db, user.id, "x:read");
return await listByIds(db, ids);
```

### Mutating tuples without going through the wrapper

```ts
// ❌  Skips canGrant + onGranted, drifts the audit log.
await db.insert(relationTuples).values({...});

// ✅  Routes the write through hooks.
await access.grant(ctx, { subject, relation, objectId });
```

The only exception is `item.service.createItem`, which writes the
initial owner tuple inside the same transaction as the items row for
atomicity — that's a base-module concern documented inline at the
call site.

### Inventing relations on the fly

```ts
// ❌  "can_share" doesn't exist in any namespace config.
await access.grant(ctx, { ..., relation: "can_share" });
```

Add the relation to the namespace's config (`registerNamespace` for a
module's own namespace, `namespace-config.ts` for a shipped one), then point
an action at it.
The engine validates relations at write time and will reject unknown
names.

### Forgetting `cascadeDelete`

A soft-deleted item with stale tuples still appears in
`listObjectsFor` results — the engine doesn't know about
`items.deleted_at`. Always call `cascadeDelete` (or
`policy.deleteTuplesForEntity`) at the end of every delete path.

## Discovery — `/api/policy/manifest`

The framework exposes a manifest of every registered resource:

```json
GET /api/policy/manifest
{
  "success": true,
  "data": [
    {
      "name": "document",
      "namespace": "item",
      "description": "Markdown documents with parent-chain inheritance.",
      "actions": [
        { "action": "document:read",   "relation": "viewer" },
        { "action": "document:update", "relation": "editor" },
        ...
      ],
      "hooks": ["bypass", "resolveEntity", "onGranted"]
    },
    {
      "name": "notification",
      ...
    }
  ]
}
```

Use the manifest for:

- the admin debug UI's "what permissions exist" tab
- generated docs (regen this README section by walking the manifest)
- contract tests (assert your CI fixture has every action declared)

## Testing harness

```ts
import { __resetResourceRegistryForTests } from "@/modules/policy";

beforeEach(() => {
  __resetResourceRegistryForTests();
  // Re-register the resources under test.
  defineResource({ name: "test-doc", namespace: "item", actions: {...} as const });
});
```

For the engine-side assertions, grant tuples explicitly and call
`can()` / `listObjectsFor()`:

```ts
await documentAccess.grant(ctx, {
  subject: userSubject("alice"),
  relation: "editor",
  objectId: docId,
});

expect(await documentAccess.can(ctx, "document:update", docId)).toBe(true);
```

Hooks are normal closures — substitute `bypass: () => true` in a test
resource to simulate admin context without touching the actor.

## Migration: existing engine callers → framework

A module that predates this framework and still calls the engine directly
(as the template's `item` / `document` / `issue` modules did) migrates
incrementally:

1. Add a `<module>.permission.ts` next to the module's service. Move
   the inline `check(db, "item", id, "viewer", ...)` literals out into
   an `actions` table on a new `defineResource` call.
2. Replace every `check(db, "item", id, RELATION, "user", userId)` in
   the module with `access.can(ctx, ACTION, id)`. The relation literal
   should not survive the migration.
3. Replace inline `createTuple` calls with `access.grant(...)` so
   `onGranted` fires consistently.
4. Audit emission moves from route handlers to the `onGranted` /
   `onRevoked` hooks.
5. Soft-delete paths call `access.cascadeDelete(...)` instead of
   `policy.deleteTuplesForEntity(...)` (both work; the wrapper just
   keeps the namespace in one place).

The engine remains usable; the wrapper is a layered API, not a
replacement. Cross-module group-membership helpers
(`listGroupIdsForUser`, `listGroupMembershipsForUsers`, …) live on
`account/groups/group-members.service.ts` rather than on policy — the
account module owns the `group_members` table. Raw debug routes
(`/api/policy/check`, `/api/policy/expand`) stay on the engine because
they don't fit the module-owns-one-resource shape.

## Appendix A — built-in namespaces

| Namespace | Relations | What it's for |
|---|---|---|
| `user` | — | Subject only. |
| `group` | `member` | Users-in-groups, groups-in-groups. |
| `resource_group` | `viewer / editor / manager / admin / member` | Optional grouping primitive. Identity lives in the `resource_groups` table; only edges are tuples. |
| `item` | `owner / editor / viewer / assignee / approver / watcher / parent_item` | Shared base for content sub-types. |

Add new namespaces in
[`apps/api/src/modules/policy/namespace-config.ts`](../../../apps/api/src/modules/policy/namespace-config.ts).
Reuse before inventing.

`tuple_to_userset` rules are honoured symmetrically: `check()` follows
each tupleset tuple's own subject namespace, and `listUserResources()`
reverses the same rule — a self-referential rule (`item.parent_item`)
is walked downward to a fixpoint under the node budget, a cross-namespace
rule recurses into that namespace's `computed_userset`. A module that
declares a rule gets both "may I?" and "which ones?" for free; do not
build a module-side descendant expansion.

## Appendix B — when to skip the wrapper

The framework targets the 95% case "user X has relation R on object O".
A handful of situations still call the engine directly:

- **Cross-module helpers** that need raw tuple rows for indexing
  (e.g. `account/groups/group-members.service.listGroupMembershipsForUsers`).
- **Hook bodies** that have to inspect the relation ladder before
  answering (avoid recursing through the wrapper from its own hooks).
- **Admin debug routes** — `/api/policy/check`, `/api/policy/expand`,
  `/api/policy/manifest` deliberately bypass the wrapper so admins can
  query any namespace / relation pair without the module-side
  declaration.
- **Atomic create-with-tuple paths** — `item.service.createItem` writes
  the owner tuple inside the same transaction as the items row so a
  crash between the two cannot orphan the resource.

Everything else goes through `defineResource`.
