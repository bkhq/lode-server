# Module Playbook

A numbered, copy-the-shape checklist for adding a new business module. Keep this open while wiring things up; jump to [`standards.md`](standards.md) for the **why** behind each rule and to [`recipe.md`](recipe.md) for ready-to-paste starter files.

Replace `<name>` with your module's kebab-case singular name (e.g. `ticket`).

1. **Create the backend four-file set** under `apps/api/src/modules/<name>/`: `schema.ts`, `<name>.service.ts`, `<name>.routes.ts`, `index.ts`.
   - Tables live in `schema.ts`; the service consumes `c.get("db")`; routes wrap `authRequired`; `index.ts` only re-exports.
   - Every route must declare `describeRoute(...)` and validate input with `validator(...)` from `@/shared/lib/openapi` so it lands in the OpenAPI spec. Why: [openapi-standard.md](openapi-standard.md).
   - Why: [§2.1 File layout](standards.md#21-file-layout), [§2.6 Schema sharding](standards.md#26-schema-sharding-mandatory).

2. **Re-export the schema** from `apps/api/src/db/schema.ts` (one line, alphabetical):
   ```ts
   export * from "@/modules/<name>/schema";
   ```
   Why: drizzle-kit walks this file when generating migrations. See [§2.6](standards.md#26-schema-sharding-mandatory).

3. **Mount the routes** in `apps/api/src/routes/protected.ts` (one import + one `app.route` line):
   ```ts
   import { <name>Routes } from "@/modules/<name>";
   app.route("/", <name>Routes());
   ```
   Use `public.ts` / `setup.ts` only when the route must work while the DB is locked. Why: [§2.4 Route mounting](standards.md#24-route-mounting).

4. **(Optional) Register a policy relation** in `apps/api/src/modules/policy/namespace-config.ts` only if the seven `item` relations (`owner / editor / viewer / assignee / approver / watcher / parent_item`) are insufficient. Add one entry inside the existing namespace's `relations` block — do not create a new namespace lightly. Why: [§0 Content modules](standards.md#0-content-modules-build-on-item--file).

5. **Register a backup contribution** if the module owns persistent tables. Create `<name>.backup.ts` exporting a `BackupContribution`, then in `index.ts`:
   ```ts
   import { registerBackupContribution } from "@/modules/backup/registry";
   import { <name>BackupContribution } from "./<name>.backup";
   registerBackupContribution(<name>BackupContribution);
   ```
   The import in `protected.ts` (step 3) triggers this side effect. Why: [§2.8 Backup contribution](standards.md#28-backup-contribution-mandatory-for-modules-that-own-tables).

6. **Add the sidebar nav item.** Create `apps/web/src/app/routes/_app/<area>/-<name>.nav.ts` exporting a `NavItem`, then add one import + one array entry to `apps/web/src/shared/components/sidebar/registry.ts`. Why: [§3.3 Sidebar](standards.md#33-sidebar) and the "core principle" aggregate-file table.

7. **Add the i18n shard.** Drop `apps/web/src/locales/en/<name>.json` and `apps/web/src/locales/zh/<name>.json`; both must carry the same key set. The namespace list is derived automatically from the file system, so no edit to `i18n.ts` is needed. Use `useTranslation("<name>")` in components. Why: [§3.4 i18n sharding](standards.md#34-i18n-sharding-mandatory).

8. **Add tests.** Unit: `apps/api/src/modules/<name>/<name>.test.ts` (uses a temp SQLite per test). E2E: create `tests/e2e/modules/<name>/` with at least one `*.test.ts` per top-level resource, then append `"<name>"` to `MODULE_DIRS` in `tests/e2e/run.ts`. Why: [§5.0 Coverage philosophy](standards.md#50-coverage-philosophy-read-this-first) and [§5.3 e2e](standards.md#53-end-to-end-e2e--owns-the-user-facing-100).

9. **Write the module doc** `docs/modules/<name>.md` (file layout, database, routes, auditing, end-to-end coverage, out-of-scope) and add one row to `docs/architecture.md` / `docs/reference/api.md` / `docs/reference/database.md`. Why: [§4 Documentation sync](standards.md#4-documentation-sync).

10. **Generate the migration and run the gate.**
    ```bash
    bun run --filter @app/api db:generate   # commit drizzle/<n>_*.sql + meta/_journal.json
    bun run check                            # lint + typecheck + test + build + check:i18n + check:env-docs + check:api-docs
    ```
    All seven steps in `bun run check` must be green before opening the PR. Why: [§6 Quality gate](standards.md#6-quality-gate), [§8 Pre-merge checklist](standards.md#8-pre-merge-acceptance-checklist).
