# Module development

How to add a new module to the template — its contract, the registry slots
it must wire into, and the starter file layout. For *what each shipped
module does*, see [`../../modules/`](../../modules/).

## Read in order

1. **[standards.md](standards.md)** — module spec: file layout, route
   ownership, schema rules, the aggregate-file rule, the i18n / docs sync
   rule, and the test-coverage minimum.
2. **[playbook.md](playbook.md)** — 10-step checklist for shipping a
   module, end to end. Use this as the implementation order.
3. **[recipe.md](recipe.md)** — starter files (`schema.ts`, `service.ts`,
   `routes.ts`, `index.ts`, test scaffold, doc skeleton) you copy into
   `apps/api/src/modules/<your-module>/` and `tests/e2e/modules/<your-module>/`.

## Cross-cutting topics

- **[openapi-standard.md](openapi-standard.md)** — how a module wires its
  routes into the generated OpenAPI spec (`describeRoute` + `validator`).
  Every route a module exposes must appear in the spec.
- **[policy-standard.md](policy-standard.md)** — how a module declares its
  permission surface via `defineResource` + the route binding registry.
  Every module that owns user-facing data needs this.
- **[cron-actions.md](cron-actions.md)** — how a module contributes a
  scheduled action (spec / executor pattern, registration via
  `defaultEnabled` and `CRON_ACTIONS_ENABLED`).
