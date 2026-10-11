# Module Standards

> **Looking for the quick steps?** If you are here to add a new module, read [`playbook.md`](playbook.md) first — it is a 10-step numbered checklist. For ready-to-paste starter files (schema, routes, service, tests, locales, nav), see [`recipe.md`](recipe.md). This document is the **reference / rationale**: it explains *why* each rule exists, what each constraint protects, and what gets rejected at review. Read it when you need to understand or justify a decision; skim it once before your first module.

This document defines the hard requirements for adding a new business module under `apps/api/src/modules/` or `apps/web/src/app/routes/`. It covers workflow, file layout, code, documentation, testing, and commits. **Every clause below must be satisfied before a new module is merged to main.**

Reference modules in this repo: `account` ([account.md](../../modules/account.md)), `file` ([file.md](../../modules/file.md)), `item` ([item.md](../../modules/item.md)), `policy` ([policy.md](../../modules/policy.md)).

---

## Core principle: module autonomy / minimal aggregate files

> **If it can be split out, split it out — do not modify shared aggregate files.**

A module owns all of its code, schema, i18n, menu data, and documentation fragments under `modules/<name>/`. Shared aggregate files act **as a registry only**: each new module is allowed **at most one import line / one index line** per aggregate file. Direct writes of business fields, table definitions, or translation values are not accepted.

**Aggregate-file inventory + corresponding module-owned shard**:

| Aggregate file | Allowed change | Module-owned shard |
|---|---|---|
| `apps/api/src/db/schema.ts` | One `export * from "@/modules/<name>/schema"` line | `modules/<name>/schema.ts` |
| `apps/api/src/routes/protected.ts` | One import + one `app.route("/", <name>Routes())` line | `modules/<name>/<name>.routes.ts` + `index.ts` export |
| `apps/api/src/modules/policy/namespace-config.ts` | One relation entry inside an existing namespace's `relations` block, if needed | Sub-types reuse the `item` namespace's seven default relations whenever possible |
| `apps/web/src/locales/{en,zh}/common.json` | **No new module keys**; new modules use i18next namespace shards | `routes/.../<module>/locales/{en,zh}.json` |
| `apps/web/src/shared/components/sidebar/registry.ts` | One import + one array entry (2 lines total) | Module exports `<name>.nav.ts` (NavItem instance) |
| `docs/architecture.md` / `docs/reference/api.md` / `docs/reference/database.md` | One table row | Full content lives in `docs/modules/<name>.md` |
| `tests/e2e/run.ts` | One string entry in the `MODULE_DIRS` array | `tests/e2e/modules/<name>/*.test.ts` |
| `apps/web/src/app/routeTree.gen.ts` | Auto-generated; **never hand-edit** (rebuild via `bun run --filter @app/web build`) | File-based routes |

**Things that violate the principle (PR will be rejected)**:

- Defining a new module's tables directly in `db/schema.ts` (they must live in the module's `schema.ts`).
- Appending `"<module>.…"` keys to `common.json` (use namespace sharding instead).
- Writing middleware or business conditionals inside `protected.ts` (mount them inside the module's own routes file).
- Hardcoding the module's i18n key / route path / icon in `app-sidebar.tsx` (the module exports a NavItem via `<name>.nav.ts`; the registry collects it).

---

## 0. Content modules build on `item` + `file`

Any new module that represents a **user-created content object** — issue,
document, ticket, purchase order, expense report, contract, leave
request, etc. — **must** compose the [`item`](../../modules/item.md) base + a
sub-type detail table, not roll its own `<name>` / `<name>_comments` /
`<name>_attachments` triple.

What the sub-type owns:

- `<name>_details(item_id PK FK→items.id ON DELETE CASCADE, ...sub-type-specific columns...)`
- `<name>.routes.ts` (`/api/<name>` prefix), `<name>.service.ts` (composes `items` + `<name>_details` + policy tuples), `<name>.backup.ts` (contributes `<name>_details`, depends on `items` + `policies`), `<name>.test.ts`.

What the **`item` module** owns and the sub-type must NOT re-implement:

| Concern                  | Lives in                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `id` (ULID) / `short_id` (nanoid) / `title` / `status` / `creator_id` / `version` / `deleted_at` / `updated_at` | `items` |
| Comments (flat reply, `is_internal`) | `item_comments`                                                                  |
| Attachments              | `file_references` (owner_type=`'item_attachment'`, owner_id=`items.id`); bytes in `files`.   |
| Owner / editor / viewer / assignee / approver / parent_item relations | `relation_tuples` in the `item` namespace |
| Soft-delete + tuple cleanup | `ItemService.softDeleteItem`                                                              |

What about other concerns (non-content modules)? `account`, `audit`,
`backup`, `encryption`, `policy`, `settings`, `system` are infrastructure
— they own their own schema and stay out of scope for the `item` rule.

### Required wiring for a new content sub-type

- **Audit action codes** use `<name>.<verb>` (`ticket.created`,
  `purchase_order.approved`). The base never emits audit; the sub-type
  does, at the route layer.
- **Aggregate-file additions** (each ≤ 1 line — see §"Core principle"):
  - `apps/api/src/db/schema.ts` → `export * from "@/modules/<name>/schema"`.
  - `apps/api/src/routes/protected.ts` → import + mount `<name>Routes()`.
  - `apps/api/src/modules/policy/namespace-config.ts` → if the sub-type
    needs a relation beyond the seven the `item` namespace already
    declares (`owner / editor / viewer / assignee / approver / watcher /
    parent_item`), add it inside the existing `item` entry's `relations`
    block. The `policy` engine picks it up automatically.

See [`item.md`](../../modules/item.md) §"Adding a sub-type — recipe"
for the full step-by-step. The template's `issue` and `document` modules
(removed in this fork) were the worked examples.

---

## 1. Workflow

For non-trivial modules, capture the design intent in the PR description before writing code: file layout, schema, routes, dependencies, risks, and explicit out-of-scope items. Land the change as the commit chain that implements the design (squash or split as makes sense). The repository does not maintain a separate plan/task tracker — git history + the PR is the record.

---

## 2. Backend module conventions

### 2.1 File layout

```text
apps/api/src/modules/<name>/
  <name>.routes.ts          # Hono route definitions; admin routes
  <name>.service.ts         # Business logic + DB queries (single file for small modules)
  <feature>.service.ts      # Sub-domain split for large modules
  <name>.test.ts            # bun:test integration tests (routes + service)
  <feature>.test.ts         # Sub-domain unit tests (as needed)
  index.ts                  # Re-exports routes + necessary types only
```

**Hard rules**:

- Module directory name: `kebab-case`, singular; file names: `kebab-case.ts`.
- `index.ts` may contain only `export { … }` statements; no logic.
- Single-file size caps:
  - Backend modules (`apps/api/src/**`): ≤ 800 lines; anything larger has to be split by sub-domain.
  - Frontend route entries (`apps/web/src/app/routes/**/*.lazy.tsx`): ≤ 1500 lines. These files host the whole admin/portal page (list + detail panes + dialogs + bulk actions + i18n bindings) and prematurely splitting them inflates prop / store wiring without reducing complexity. Past 1500 lines, extract a `-section.tsx` co-located helper or a `routes/<area>/<module>/` subdirectory.
  - Other frontend files (components, hooks, stores, libs): ≤ 800 lines.
- The service layer must not read `Bun.env` directly; use `c.get("config")`.

**Meta-module exception** (parent folder hosting tightly-coupled sub-modules — see `account/{auth,groups,users}/`):

- Each sub-module owns its own `schema.ts`, so `db/schema.ts` lists one `export *` line **per sub-module** (not per meta-module).
- The meta-module's `index.ts` exports a single aggregator (`accountRoutes()`) that mounts each sub-module's routes; `routes/protected.ts` mounts the aggregator once.
- All other rules apply per sub-module (audit, schema sharding, namespace isolation, etc.). Avoid this pattern unless the sub-modules genuinely co-evolve (e.g. account = auth + sessions + users + groups all bound to the same identity story).

### 2.2 Naming and IDs

- Business entity IDs: **8-character lowercase nanoid** (`nanoid()` from `apps/api/src/shared/lib/id.ts`).
- Audit logs and other append-only tables that need monotonic ordering: **ULID** (e.g. `audit_events.id`).
- Route prefix: `/api/<module-name>/...`; sub-resources are plural (`/accounts`, `/transactions`).
- Audit action naming: `<module>.<resource>.<verb>` (lowercase with underscores), e.g. `document.created` / `issue.attachment_uploaded`.

### 2.3 Database

- Table names: `<module>_<resource>` (snake_case plural), e.g. `document_details`, `audit_events`.
- Columns: snake_case; time fields are ISO 8601 strings; booleans use SQLite integer; monetary amounts use TEXT + `decimal.js`.
- After modifying any module's `schema.ts`, you must run `bun run --filter @app/api db:generate` to produce a migration; commit the migration file together with `meta/_journal.json`.
- Deletes: default to soft delete (`deleted_at` timestamp or a `status` column) to preserve foreign-key referential integrity.
- **Forbidden**: hand-written migration SQL; skipping `db:generate`.

### 2.4 Route mounting

Three route groups exist under `apps/api/src/routes/`:

| Group | File | Mounted in | Use case |
|---|---|---|---|
| public | `public.ts` | locked + unlocked | Reachable in both states (health, encryption status) |
| setup | `setup.ts` | locked only | Reachable only while the DB is locked (encryption init / unlock) |
| protected | `protected.ts` | unlocked only (`requireUnlocked` defense-in-depth) | Business routes; modules apply their own `authRequired` / `adminRequired` |

A new module's routes default to `protected.ts`. Use `public.ts` only when the route legitimately must answer in both states. Use `setup.ts` only when the route exists exclusively to recover the system from a locked state.

- `protected.ts` applies `requireUnlocked` by default; the module itself wraps `authRequired` / `adminRequired` explicitly inside its `<name>.routes.ts`.
- OpenAPI: every route declares `describeRoute(...)` so it appears in the generated spec; see [openapi-standard.md](openapi-standard.md).
- Inbound validation: validate input with `validator("json" | "query" | "param", schema)` from `@/shared/lib/openapi`, then read it via `c.req.valid(target)`. This feeds the request schema into the spec and still yields the uniform 422 `VALIDATION_ERROR` envelope on failure (via a shared hook). Routes that hand-parse for security/timing reasons keep their handler and only add `describeRoute`.
- Error response shape: `{ success: false, error: { code, message } }`. Success response shape: `{ success: true, data, meta? }`.
- Webhook / Bearer-token routes: create a separate `<name>.external.routes.ts`; the CSRF guard automatically lets `Authorization: Bearer …` requests through.

### 2.5 Middleware and context

- Do not add new global middleware; module-specific needs go into route-level `app.use(...)` inside `<name>.routes.ts`.
- Scope a module's middleware to its own paths: `router.use("/things/*", authRequired)`, never `router.use("*", …)`. Module routers are mounted with `app.route("/", …)`, and Hono merges a sub-router's `use("*")` into the parent as a guard on every router mounted after it — a public route further down becomes unreachable, and a route with its own authentication (a service token, say) gets a session guard it cannot pass. `/things/*` also matches `/things` itself. `routes/protected.test.ts` mounts a public route after all protected modules and fails if any guard reaches it.
- Cross-module reusable middleware lives under `apps/api/src/shared/middleware/`.
- A new way to authenticate (a token, a signed header) is an auth provider: `registerAuthProvider(provider)` from `@/shared/middleware/auth-registry`, called from the module's `index.ts`. Providers form a chain asked in registration order, so `authRequired`, the policy middleware and the creation quota accept every registered credential. A provider returns `undefined` for a request whose credential is not its own, and throws only when the request must fail.
- An endpoint for other services to call goes on the raw API: mount it in `apps/api/src/routes/raw.ts`, not in `protected.ts`. It is served at `/api/raw/*` with no security headers, CSRF guard, CORS, session or policy middleware — only a per-client rate limit — so a route there authenticates its caller itself. See *Raw API* in `docs/architecture.md`.
- Read context via `c.get("db" | "config" | "logger" | "user")`; do not inject new singletons inside the service layer.
- Creating routes go on the collection path (`POST /things`, `POST /things/:id/parts`) alongside the `GET` that lists it. The per-user creation quota finds them by that shape — a `POST` whose path also answers `GET` — so a module mounted this way is throttled with no wiring, while an action posted at a member (`POST /things/:id/publish`) is correctly left alone. A create that does not list, or a `POST` used as a read, will be classified wrongly; put such a route on a path with no sibling `GET`, or name it in `CREATE_RATE_LIMIT_EXEMPT`. See *Rate Limiting* in `docs/architecture.md`.
- Host access goes through the runtime seam, `getPlatform()` from `@/platform`: read env via `platform.env`, keep short-lived shared state (tokens, counters) in `platform.kv.namespace("<module>:<purpose>")` with a TTL, and schedule background sweeps with `platform.scheduler.every(...)`. Do not reach for `Bun.env`, module-level `Map`s, or raw `setInterval` in module code — those are what make a module Bun-only. Bun-only features (subprocess, argon2, at-rest DB encryption, local filesystem) are declared in `platform.capabilities`; check the flag before depending on one.

### 2.6 Schema sharding (mandatory)

A module that owns persistent state **must** carry its own schema file; `db/schema.ts` is only a re-export aggregator. Schemaless modules (e.g. `system`, `encryption`, `backup`) own no tables and therefore add no entry to `db/schema.ts`.

```text
apps/api/src/modules/<name>/
  schema.ts                # All tables + indexes + relations for this module

apps/api/src/db/schema.ts  # Only allowed: export * from "@/modules/<name>/schema"
```

- The module's `schema.ts` lives next to its `service` / `routes` files for easy review and removal (deleting a module is `rm -rf modules/<name>` plus deleting one export line).
- `db/schema.ts` may **not** contain table definitions; only import / export lines are allowed.
- `bun run --filter @app/api db:generate` follows the import chain to produce migrations — no extra configuration needed; migration files continue to land under `apps/api/drizzle/`.
- Module `schema.ts` files **may** import each other (drizzle foreign keys via `references()` must hold a real table reference, e.g. `items.creatorId.references(() => users.id)`).

#### Cross-module data access rules

The service layer is bound by these rules in decreasing order of strictness:

1. **Writes to another module's tables from outside the owning module** — only allowed for the two documented composition patterns below. Any new caller wanting to write to a sibling module's table **must** add a service function in the owning module first and call that.

2. **Reads** are permitted across module boundaries when the data is used in a join / projection in the calling module's own query. Prefer the owning module's service function when one exists (e.g. `policy.service.getTuplesByObject`); inline drizzle queries are acceptable for ad-hoc joins that the owning module does not expose.

3. **Schema imports** (`import { foo } from "@/modules/other/schema"`) are always allowed — drizzle needs the table reference for joins, `references()`, and type inference.

##### Documented composition exceptions

These two patterns are *intentional* shared-base compositions; the rule above does not apply to them, but new modules must follow the same pattern (do not invent a third):

- **`item` ↔ `<sub-type>_details`** — a content sub-type module (the template's `document` and `issue`, removed in this fork, and any future one) composes `items` with their `*_details` table in the same transaction. Reads against `items` columns and writes against the row owned by the sub-type are both permitted. This is the entire reason `item` exists.
- **`policy.relationTuples`** — the relation-tuple table is a generic key-store that backs the Zanzibar engine. Modules that own permission-bearing resources (`item` and its sub-types) write tuples (`parent_item`, `viewer`, `editor`) directly inside the same transaction that creates the resource so the resource and its initial ACL land atomically. Reads of tuples for ad-hoc filtering are also permitted. New write patterns that do not fit the existing three should land in `policy.service` first.

Any cross-module write that is not one of the patterns above is a bug — open it as a service function on the owning module.

### 2.7 Auditing

**Every write operation** (POST / PATCH / DELETE / trigger-style actions) must call `audit(db, logger, …)`:

```ts
await audit(db, c.get("logger"), {
  actorId: user.id,
  actorName: user.name,
  action: "<module>.<resource>.<verb>",
  resourceType: "<resource>",
  resourceId,
  detail: { … },         // Only non-sensitive fields
  ip, userAgent,
  result: "success",     // Failures must be recorded too
});
```

Non-human actors (webhook / system): `actorId=client:<id>`, `actorName=client:<name>`.

### 2.8 Backup contribution (mandatory for modules that own tables)

Any module that owns persistent tables **must** register a `BackupContribution` so its rows participate in `/api/backup/export` and `/api/backup/import`. Modules without tables (e.g. `system`, `encryption`) skip this section.

**Files**:

```text
apps/api/src/modules/<name>/
  <name>.backup.ts      # exports `<name>BackupContribution: BackupContribution`
  index.ts              # imports it and calls registerBackupContribution(...)
```

**Contribution shape** (`apps/api/src/modules/backup/registry.ts`):

```ts
export interface BackupContribution {
  readonly name: string;             // stable identifier in backup files
  readonly tables: readonly SQLiteTable[];
  readonly deps: readonly string[];  // names of other modules that must restore first
}
```

**Pattern** (example: a module that depends on `users`):

```ts
// apps/api/src/modules/<name>/<name>.backup.ts
import type { BackupContribution } from "@/modules/backup/registry";
import { myThings } from "@/modules/<name>/schema";

export const myBackupContribution: BackupContribution = {
  name: "<name>",
  tables: [myThings],   // parents first within a module
  deps: ["users"],      // string-only — no module imports → no cycles
};
```

```ts
// apps/api/src/modules/<name>/index.ts
import { registerBackupContribution } from "@/modules/backup/registry";
import { myBackupContribution } from "./<name>.backup";

export { myRoutes } from "./<name>.routes";

registerBackupContribution(myBackupContribution);
```

The registration is a top-level side effect; `routes/protected.ts` already imports every module's `index.ts` to mount its routes, so by the time `/api/backup/modules` is reachable, every contribution is on file. `backup/registry.ts` deliberately knows nothing about specific modules — adding a new data module never edits any file inside `modules/backup/`.

**Hard rules**:

- One `BackupContribution` per logical module. If a meta-module (e.g. `account`) lumps several sub-modules together, **the meta-module owns the contribution**; sub-modules do not register separately. This keeps the backup file's `modules` array stable across template versions.
- Within `tables`, list parent tables before their children (so per-module insert order alone satisfies foreign keys).
- `deps` is string-typed and topologically resolved — a module declares only its first-degree dependencies; the registry walks the rest.
- Renaming an existing `name` is a breaking change to the backup file format — bump the file `version` in `apps/api/src/modules/backup/export.service.ts` if you must.

**Tests** (e2e, in `tests/e2e/modules/backup/`):

- `/api/backup/modules` includes the new module's `name`.
- `/api/backup/export` round-trips at least one row of the new module's tables.
- `/api/backup/import` restores the round-tripped data on a fresh DB.

---

## 3. Frontend module conventions

### 3.1 Routing

- File-based routing: `apps/web/src/app/routes/_app/admin/<module>.tsx` (admin) / `_app/portal/<module>.tsx` (regular users).
- Every time a route is added, run `bun run --filter @app/web build` to regenerate `routeTree.gen.ts` and commit the result (CI does not regenerate it).
- Non-route helpers (component fragments, NavItem exports, util tests) co-located inside `routes/` MUST start with the `-` prefix (e.g. `-issue-panel.tsx`, `-attachment-upload.ts`, `-<name>.nav.ts`). TanStack Router's default `routeFileIgnorePrefix: "-"` keeps them out of the route tree; without the prefix the file is registered as a route and the build warns or breaks.
- State: server data goes through TanStack Query; UI state goes through Zustand or local `useState` — do not mix the two.
- HTTP: use the client in `apps/web/src/shared/lib/http.ts`; never call `fetch` directly (CSRF and lock detection both flow through the client).

### 3.2 i18n

- New module strings go into the module's own namespace file (see §3.4); the global `common.json` only retains the layout / button / error keys listed there.
- The English and Chinese files must stay in sync; lint will not flag a missing key, but it is treated as a bug.

### 3.3 Sidebar

- Entry point is `apps/web/src/shared/components/app-sidebar.tsx`; grouped by admin / portal.

### 3.4 i18n sharding (mandatory)

A module **must** load via i18next namespaces; **do not** append new module keys to `common.json`.

**Namespaces are derived from the filesystem.** `apps/web/src/app/i18n.ts` walks `apps/web/src/locales/<lng>/<ns>.json` via `import.meta.glob` and feeds the result into `supportedLngs` + `ns` at build time — no hardcoded list to maintain.

- A new module author only needs to: place `<module>.json` under both `apps/web/src/locales/en/` and `apps/web/src/locales/zh/`. The namespace is picked up automatically; **no edit to `i18n.ts`**.
- Module components use `useTranslation("<module>")`; keys do **not** carry the `<module>.` prefix (the namespace already isolates them).
- Global keys such as `common.*` / `nav.*` / `page.*` resolve automatically via `fallbackNS: "common"` — no need to write a `common:` prefix on every `t()` call.
- When a module needs another namespace, use `useTranslation(["<module>", "<other>"])` and access the other namespace as `t("<other>:key")` (see `settings-dialog.tsx`, which mounts `common + users`).
- `common.json` only retains global keys (layout, buttons, error messages): app / theme / auth / totp / profile / common / nav / page / portal / login / denied / encryption / settings; new module keys are no longer accepted.

**Module-owned locale shards (recommended target pattern, not yet enabled)**:

```text
apps/web/src/app/routes/_app/<area>/<module>/
  locales/
    en.json
    zh.json
```

These would be copied to `apps/web/src/locales/<lng>/<module>.json` at build time. Until that build step is added, new modules drop their files directly into `apps/web/src/locales/`.

---

## 4. Documentation sync

Every new module must update the following documents before merging (**all in the same PR**):

| Document | Update |
|---|---|
| `docs/modules/<name>.md` | New file with the full module description (see existing modules for examples) |
| `docs/architecture.md` | Add one row to the module table + any necessary runtime notes |
| `docs/reference/api.md` | List every new route (method, path, access level, description) |
| `docs/reference/database.md` | List new tables + key columns |
| `docs/README.md` | Only update if you are adding a whole new section; pure module additions leave it alone |

`docs/modules/<name>.md` must include sections for: file layout, lifecycle (when applicable, e.g. schedulers / middleware initialization), database, routes, auditing, **end-to-end coverage** (which `tests/e2e/modules/<name>/*.test.ts` files exist + what each one asserts), and out-of-scope (known limitations / v2 plans).

---

## 5. Testing

### 5.0 Coverage philosophy (read this first)

Two **non-negotiable** rules drive every test the module ships:

1. **Unit + e2e together MUST cover 100% of every line in the module.** Each line of source belongs to exactly one of the two test layers — there is no third bucket. If a line is not reachable from a unit test (because it depends on a real OAuth IdP, libsql encryption, browser cookies, or the live Bun.serve fetch pipeline), then it MUST be reached by an e2e test. "Covered by neither" is rejected at review.

2. **Every user-facing endpoint MUST have 100% e2e coverage.** A "user-facing endpoint" is any HTTP route exposed to the SPA, mobile clients, or external integrators (i.e. anything mounted under `routes/protected.ts` or `routes/public.ts`). Each such route must have at least one e2e case that drives it through the live API process — no exceptions for "internal" or "rarely used" routes. If an admin can call it, an attacker can call it, and the e2e suite is the regression net.

Concretely:

| Layer | Where it lives | What it covers |
|---|---|---|
| Unit | `*.test.ts` next to the source under `apps/api/src/**` | Pure logic: services, helpers, middleware, registries, schema validators, state machines, error envelopes. Aim for 100% on every file the unit-test runner can reach. |
| Live e2e | `tests/e2e/modules/<module>/*.test.ts` | Every HTTP path under `*.routes.ts`, every permission branch, every multipart / streaming / encrypted flow, every audit landing. The user-facing surface is owned here. |

How the two add up to 100%:

- Unit tests own logic that can be exercised in-process without faking infrastructure (DB schema is real via a temp SQLite; libsql encryption / OAuth / fs uploads are NOT faked).
- e2e owns everything that requires the live stack: HTTP wire behaviour, OAuth token exchange against dex, libsql encryption rewrap, ECIES handshakes, TOTP lifecycle, file-system attachment uploads, CSRF + Origin guards under a real `Bun.serve` pipeline, encryption-state restart cycles.
- Anything in between (e.g. a service function that walks the DB but is also called from a route) is allowed to be covered by either or both — but the line MUST be hit by at least one.

The coverage report enforces the unit half via `apps/api/bunfig.toml` thresholds (≥ 85% lines / ≥ 70% functions on the unit-testable surface, with `*.routes.ts` and process-level helpers excluded). The e2e half is enforced by review: every new route file MUST land with a matching `tests/e2e/modules/<module>/*.test.ts` that exercises it.

### 5.1 Backend (unit half of §5.0)

- Framework: `bun:test`; test files (`*.test.ts`) live next to the source.
- Isolation: each test uses a temporary SQLite DB (see `apps/api/src/modules/item/item.test.ts` for the setup pattern) and is discarded afterwards.
- Required for the unit layer:
  - **Pure logic and helpers**: 100% lines on every service / middleware / lib utility / registry / schema validator the unit-test runner can reach. The bunfig threshold (≥ 85% lines / ≥ 70% functions aggregate) is the **floor**, not the goal — individual files SHOULD hit 100% unless the residual lines genuinely depend on the live stack and are owned by e2e per §5.0.
  - **Business invariants**: each core constraint the module promises (transaction atomicity, idempotency keys, illegal state-machine transitions, scope checks, etc.) must have a failing-case test in the unit layer.
  - **Auditing**: at least one unit test verifies the `audit_events` row lands with the correct action / actor / resource fields.
- The unit-testable surface excludes route files (`*.routes.ts`), the app composer (`app.ts`), entry points, build artefacts, and process-level helpers — these are owned by §5.3.
- **Forbidden**: mocking the DB; mocking internal service functions; changing the implementation to dodge an assertion.

### 5.2 Frontend

- Framework: vitest (`bun run test` inside `apps/web`).
- Test files (`*.test.ts`) live next to the component (see `attachment-upload.test.ts`).
- Required coverage: pure functions (validation, formatting), key Zustand store actions, form schema parsing.
- React component-render tests are added once `@testing-library/react` is introduced; until then prioritize pure-logic coverage.

### 5.3 End-to-end (e2e — owns the user-facing 100%)

**Hard rule**: every HTTP route mounted to a user (the SPA, mobile clients, external integrators) MUST have e2e coverage. There is no "internal route" exemption; every entry registered under `routes/protected.ts` or `routes/public.ts` is reachable from outside the process and therefore is in the e2e contract. A new route landing in a PR without a matching `tests/e2e/modules/<module>/*.test.ts` case is rejected at review.

The single live e2e suite is the system-of-record for HTTP behaviour: `tests/e2e/modules/<name>/*.test.ts`, run via `bun run test:e2e`. The orchestrator boots dex (auto-extracted from the official OCI image — no docker required), starts the API with `DB_ENCRYPTION=true` against a temp DB under `tests/e2e/.cache/data/<run-id>/`, performs the encryption setup, then runs every module's tests against the live stack, and finally restarts to verify the rate-limit and unlock cycles. JUnit XML + a JSON summary land in `tests/e2e/.cache/reports/<run-ts>/` (with a `latest/` symlink for CI).

In-process integration tests under `apps/api/tests/` were removed deliberately — they overlapped with the live e2e and the duplication created drift. Cross-cutting security guards (CSRF / Origin) live in `tests/e2e/modules/system/security.test.ts`; the encryption rate-limit case lives in its own phase under `tests/e2e/modules/encryption/rate-limit.test.ts`.

#### What every new module must add to the live e2e suite

For each new module **\<module\>**:

- Create the directory `tests/e2e/modules/<module>/` and add at least one `*.test.ts` per top-level resource (e.g. `documents.test.ts`, `attachments.test.ts`).
- Wire the directory into the orchestrator: append `<module>` to `MODULE_DIRS` in `tests/e2e/run.ts`. This is **the only line** the orchestrator should grow per module — everything else lives inside the module's test directory.
- Use the shared helpers — never re-implement them:
  - `getClient(email)` from `tests/e2e/lib/oidc.ts` returns a cached, logged-in `ApiClient` (and self-heals on 401). Use `loginAs(email)` only when the test exercises the login flow itself.
  - `ApiClient` from `tests/e2e/lib/api.ts` carries the cookie jar and supports JSON + multipart (`formData`).
  - For ECIES dance (challenge/unlock/rotate-dek/backup-export), import the same helpers the SPA uses from `packages/shared/src/index` via a relative path — `tests/e2e/` is not a workspace member, so the workspace symlink is not reachable.
- Two pre-seeded dex users are available; both have password `admin`:
  - `admin@example.com` (matches `DEFAULT_ADMIN`, so it is an admin).
  - `user@example.com` (regular user).
- Cover the same matrix the integration tests cover, plus what only an HTTP client can hit:
  - **Happy path** for every public route (CRUD, listing, filtering, pagination boundaries).
  - **Permission matrix**: unauthenticated → 401; non-admin hits an admin route → 403; admin → 200.
  - **Cross-user behaviour**: when the module exposes sharing / membership / cross-account access, prove it by acting as the second user and asserting the visible state changes.
  - **Multipart / streaming endpoints**: upload + download round-trips, plus the size cap (assert the > limit case is rejected).
  - **Audit landing**: drive an audited write, then read `/api/audit` as admin and assert the new event row.
- Cleanup: every test that creates persistent state (groups, documents, settings keys, TOTP devices) must delete what it created. The orchestrator wipes the data dir at the end of the run, but tests that share state across files (cached sessions, DEFAULT_ADMIN-style fixtures) need to leave the system in the state the next file expects.
- If the module flips encryption, locks the system, or otherwise mutates global state across processes, document the requirement in the PR and add a fresh phase to `run.ts` rather than leaking state into Phase B (`encryption/init.test.ts` and `encryption/unlock.test.ts` are the worked examples).

Browser-level e2e (Playwright) is intentionally not integrated: every cross-page flow currently in scope is reachable via HTTP without DOM. Add Playwright if and when a module ships behaviour that genuinely requires a browser (rich-text collab, file preview, etc.); add `bunx playwright test` to the root `package.json` at the same time.

---

## 6. Quality gate

Everything must be **green** before merge — no exceptions:

```bash
bun run lint            # ESLint, 0 errors and 0 warnings
bun run typecheck       # tsc --noEmit
bun run test            # All tests pass; new modules ≥ 80% coverage
bun run build           # Both vite build and bun build succeed
bun run check:i18n      # en / zh locale namespaces in sync
bun run check:env-docs  # docs/reference/env-reference.md matches the zod schema, the env reads in apps/api/src, and .env.example
bun run check:api-docs  # docs/reference/api-routes.md matches the in-process Hono routes
```

`bun run check` chains all seven; CI runs the same. They must pass locally before a PR is opened.

---

## 7. Commit rules

### 7.1 Commit message

- Format: `<type>: <description>`; types: `feat | fix | refactor | docs | test | chore | perf | ci`.
- Always **English**; description ≤ 72 characters on a single line; body lines (optional) ≤ 100 characters.
- **Forbidden** content: AI / agent names such as `Codex` / `Claude` / `ChatGPT` / `OpenAI` / `Anthropic`; `Co-authored-by` / `Generated by`; emoji; Chinese.
- A new module is usually a single `feat` commit (schema + routes + service + tests + docs); when too large, split in the order "schema → service → routes → frontend → docs".

### 7.2 PR

- Title follows the same rules as the commit message (English, `<type>: <desc>`, ≤ 70 characters).
- Description must include: Summary (1–3 bullets) and Test plan (checklist).
- The diff must match the task description; do **not** mix in unrelated refactors / formatting changes ("surgical changes" principle).

### 7.3 Adding files

- `git add` only the files relevant to the task; **do not use `git add -A` / `git add .`** (parallel multi-agent scenarios will pollute other agents' changes).
- `git stash` is not allowed (same reason).
- `.env` / secrets / `data/` / `dist/` must never be committed (already in .gitignore, but spot-check before commit).

### 7.4 Parallel multi-agent conflict handling

**Primary goal — zero aggregate-file changes**: each new module's `git diff --name-only` should contain **only `modules/<name>/*` and the new migration file**. Aggregate-file changes get audited against the "core principle" checklist above; each file may not exceed one line. If a constant can be exported as a NavItem, do not hardcode it in the sidebar; if a namespace can be used, do not append to `common.json`; if a schema re-export will do, do not write into `db/schema.ts`. **The cure for conflicts is to eliminate the conflict surface, not to resolve them gracefully.**

**Two-phase commit** — even when each aggregate file only touches one line, still split into a "module" commit and an "aggregate" commit:

1. **Phase one (own module)**: contains only `modules/<name>/*`, the module schema shard, the module locale shard, and the new migration file. Owned exclusively by the agent and will always push successfully.
2. **Phase two (one-line aggregate additions)**: `db/schema.ts` re-export, `protected.ts` route mount, `app-sidebar.tsx` NavItems wiring, **`tests/e2e/run.ts` MODULE_DIRS entry**, doc table rows. Before pushing, `git pull --rebase origin main`; on conflict, **keep both sides' content** — never drop another agent's change — and re-run `bun run check` until green before pushing again.

**Conflict-deferral fallback** — if phase two still has unresolvable rebase conflicts:

- It is acceptable to **defer the aggregate-file commit** and merge the phase-one PR first.
- Save the local aggregate diff with `git diff <file> > /tmp/<agent>-aggregate.patch`; once all parallel agents have landed, open a follow-up PR to fold the patches back in. **Do not use `git stash`** (memory: parallel agents would overwrite each other's changes).
- Follow-up commit type: `chore: integrate <module> into aggregate files`; the title must not reference the specific feature.

Multi-agent parallelism only approaches conflict-free when "zero aggregate changes" is honored; the two-phase split and deferral are only fallbacks.

---

## 8. Pre-merge acceptance checklist

When opening the PR, the module author must check off every item in the PR description:

- [ ] PR description states the design (file layout, schema, routes, dependencies, risks, out-of-scope).
- [ ] Schema lives in `modules/<name>/schema.ts`; `db/schema.ts` only adds one `export *` line (**no table definitions**).
- [ ] Routes mounted under `routes/protected.ts` (or `routes/public.ts` for routes that must work while the system is locked); the module-own code and aggregate-file additions are split per the two-phase commit rule (see 7.4).
- [ ] Aggregate files each receive at most one line of change (schema re-export / route mount / sidebar NavItems / docs table row); `common.json` has **no new module keys**.
- [ ] Every write route calls `audit(db, logger, …)`.
- [ ] If the module owns tables, a `<name>.backup.ts` exports a `BackupContribution` and the module's `index.ts` calls `registerBackupContribution(...)` (see §2.8). E2E covers the export / import round-trip.
- [ ] **Unit + e2e together cover 100% of the module's source** (§5.0). Every changed line traces to at least one `*.test.ts` (unit) or `tests/e2e/modules/<module>/*.test.ts` (e2e); no line is in neither bucket.
- [ ] **Every user-facing HTTP route in this module has at least one e2e case** (§5.3). New routes without matching e2e fixtures are rejected.
- [ ] Unit-half thresholds green: `bun test --coverage` ≥ 85% lines / 70% funcs aggregate; touched logic files at 100% unless the residual lines genuinely require the live stack and are claimed by e2e.
- [ ] **Live e2e**: `tests/e2e/modules/<name>/*.test.ts` exists (covers happy path, permission matrix, cross-user behaviour, multipart endpoints, audit landing); `<name>` is added to `MODULE_DIRS` in `tests/e2e/run.ts`; `bun run test:e2e` is fully green locally and the JUnit XML lands at `tests/e2e/.cache/reports/latest/`.
- [ ] `docs/modules/<name>.md` is created (including the `## End-to-end coverage` section listing each `*.test.ts`); `architecture.md` / `api.md` / `database.md` are updated.
- [ ] i18n English and Chinese files are in sync (when there is a frontend change).
- [ ] `bun run check` is fully green locally.
- [ ] Commit messages are English with no AI markers; `git status` carries no leftover unrelated changes.

A PR cannot enter review until every box is checked.
