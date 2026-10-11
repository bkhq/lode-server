# Creating cron actions

A practical guide for module authors who want to register a recurring job
that the cron module schedules, runs, validates, and surfaces in the
admin UI — without touching any cron-module file.

> Looking for the **module overview** (lifecycle, schema, routes, retry
> policy)? See [`cron.md`](../../modules/cron.md). This guide is the author-facing
> deep-dive that `cron.md` links to.

## Why two layers

Every action splits in two:

- **`ActionSpec`** — declarative metadata: name, displayName, category,
  inputs, optional cross-field validator. Pure data; safe to render in
  the SPA, expose over `/api/cron/actions`, or serialize.
- **`ActionExecutor`** — the function that does the work:
  `(ctx, config) => Promise<string>`.

A registered `ActionDef` is the frozen pair `{ spec, execute }`,
constructed with `defineAction({ spec, execute })` and added to the
in-process registry with `registerAction(def)`.

The split is enforced at the type level — `ActionSpec` has no callable
fields, `ActionExecutor` carries no metadata. Practical effects:

- The catalog endpoint (`GET /api/cron/actions`) never reaches into
  executor code; it reads only `spec`.
- The cron task runner (`cron/executor.ts`) calls
  `getActionExecutor(name)` and never reaches into the spec.
- Unit tests can exercise the executor by calling `execute(ctx, cfg)`
  directly, bypassing the registry / scheduler / DB row entirely.

## One action, one directory

Every action — shipped or external — lives in its own directory with
three files. Co-locate tests in the same directory.

```
your-module/
├── index.ts                              # registerAction(...) at top level
└── actions/
    └── notify-stale-issues/
        ├── spec.ts                       # definition layer
        ├── executor.ts                   # execution layer
        ├── index.ts                      # defineAction({ spec, execute })
        └── index.test.ts                 # action-level test
```

This mirrors the cron module's own shipped actions
(`apps/api/src/modules/cron/actions/{log-cleanup,http-request,shell,soft-delete-cleanup}/`).

## `ActionSpec` — definition layer

```ts
// your-module/actions/notify-stale-issues/spec.ts
import type { ActionSpec } from "@/modules/cron";

export const spec: ActionSpec = {
  name: "notify-stale-issues",
  displayName: "Notify stale issues",
  description: "Email a digest of issues without updates for N days.",
  category: "notification",
  icon: "Mail",
  tags: ["notification", "digest"],
  version: "1.0.0",
  defaultCron: "0 0 9 * * 1", // Mondays 09:00
  inputs: [
    { key: "days", label: "Days threshold", type: "number", required: true, min: 1, max: 365, default: 7 },
    { key: "to", label: "Recipient", type: "string", required: true, placeholder: "alerts@example.com" },
    { key: "subject", label: "Subject", type: "string", default: "Weekly stale-issue digest" },
  ],
};
```

### Field reference

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Unique, stable key. Job rows reference this — renaming is a breaking change. |
| `displayName` | yes | Human-readable name shown in the picker. |
| `description` | yes | One-line summary shown next to `displayName`. |
| `category` | yes | Functional grouping tag (e.g. `'maintenance'`, `'network'`, `'system'`, `'notification'`). Drives the action picker's section headers, the toolbar Type filter, and `cron_jobs.task_type`. Pick a name that describes what the action _does_, not where it comes from. |
| `icon` | no | `lucide-react` icon name (e.g. `'Mail'`, `'Globe'`). Add to `ACTION_ICON_MAP` in `apps/web/src/app/routes/_app/admin/cron.lazy.tsx` if the SPA should render it. |
| `tags` | no | Free-form search tags shown as badges in the meta card. |
| `version` | no | Semver-ish string surfaced in the meta card as `v1.0.0`. |
| `dangerous` | no | When `true`, an amber warning banner is rendered in the create drawer (`shell` uses this — the executor runs with the API process's full privileges). |
| `defaultEnabled` | no | Default `true`. Set to `false` to require an explicit operator opt-in via `CRON_ACTIONS_ENABLED=<name>` before the action is registered. Use for any action whose blast radius warrants an env-level gate (`shell` ships with this). |
| `defaultCron` | no | Suggested schedule. When set, `startCron` auto-seeds one DB row for the action on first boot (idempotent — re-imports skip seeding when the row already exists). |
| `runOnStartup` | no | Run the executor once at boot, in addition to the schedule. |
| `inputs` | no | Structured field definitions. Single source of truth for the SPA form and `validateActionConfig`. |
| `validate` | no | Cross-field validator that runs **after** the per-input checks. Returns a human-readable error string or `null`. |

### `inputs[]` — form field declarations

Each entry drives both server-side validation and client-side rendering:

| Field | Notes |
|---|---|
| `key` | Key inside `taskConfig` (sent verbatim on `POST /api/cron/jobs body.config`). |
| `label` | Form label. |
| `type` | One of `string / textarea / secret / number / boolean / select / json`. |
| `required` | When `true`, an empty / null / undefined value rejects the create request with `INVALID_ACTION_CONFIG`. |
| `description` | Inline help under the input. |
| `placeholder` | Hint inside the input. |
| `default` | Pre-fills the input when the user picks the action; the executor sees the literal value. |
| `options` | `{ value, label }[]` for `type: "select"`. The SPA renders one item per entry; the validator rejects anything not in the list. |
| `min` / `max` | Numeric bounds for `type: "number"`. |
| `group` | Optional grouping name; same-group inputs render together under a sub-header in the drawer. |

`type` picks the right control and the right type check:

| `type` | UI control | Server type check |
|---|---|---|
| `string` | single-line input | `typeof === "string"` |
| `textarea` | multi-line input | `typeof === "string"` |
| `secret` | masked single-line input | `typeof === "string"` |
| `number` | numeric input, honors `min`/`max` | `Number.isFinite` + bounds |
| `boolean` | switch | `typeof === "boolean"` |
| `select` | dropdown of `options[]` | value present in `options` |
| `json` | textarea (parsed before submit) | plain object (`{...}`, not array/scalar) |

## `ActionExecutor` — execution layer

```ts
// your-module/actions/notify-stale-issues/executor.ts
import type { ActionExecutor } from "@/modules/cron";

export const execute: ActionExecutor = async (ctx, config) => {
  const days = Number(config.days);
  const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const stale = await ctx.db.select().from(items)
    .where(and(eq(items.type, "issue"), isNull(items.deletedAt), lt(items.updatedAt, cutoffIso))).all();
  if (stale.length === 0)
    return "no stale issues";
  await sendEmail(String(config.to), String(config.subject), digestBody(stale));
  ctx.logger.info({ count: stale.length, to: config.to }, "notify_stale_issues_sent");
  return `notified ${config.to} about ${stale.length} stale issues`;
};
```

### Contract

```ts
type ActionExecutor = (
  ctx: ActionContext,
  config: Record<string, unknown>,
) => Promise<string>;

interface ActionContext {
  readonly db: AppDatabase;      // drizzle handle scoped to the API's DB
  readonly logger: Logger;       // pino logger
}
```

- **Return** a short status string. It lands in
  `cron_job_logs.result` and the toast message after a manual trigger.
  Keep it under ~200 chars — there's no hard cap but the column is for
  per-run hints, not blobs. Long output goes to `ctx.logger`.
- **Throw** to fail the run. The thrown `Error.message` lands in
  `cron_job_logs.error` and counts toward the consecutive-failure
  auto-pause budget (see [`cron.md` § Retry policy](../../modules/cron.md#retry-policy)).
- **Don't reach for globals.** Use `ctx.db` and `ctx.logger` — never
  `import { logger } from "..."`. This keeps the executor unit-testable
  with fakes.
- **Don't trust `config`.** Even though `validateActionConfig` ran at
  create time, the row may have been written before you tightened your
  `inputs[]` — narrow with `Number(config.x)` / `typeof === "string"`
  before use.

## Assembling and registering

```ts
// your-module/actions/notify-stale-issues/index.ts
import { defineAction } from "@/modules/cron";
import { execute } from "./executor";
import { spec } from "./spec";

export default defineAction({ spec, execute });
```

```ts
// your-module/index.ts
import { registerAction } from "@/modules/cron";
import notifyStaleIssues from "./actions/notify-stale-issues";

// Side-effecting top-level call — runs once when this module is first
// imported by app.ts. Mirrors `registerBackupContribution` and the
// audit module's retention sweep registration.
registerAction(notifyStaleIssues);
```

`registerAction` throws on duplicate `spec.name`, so a misconfigured
module that ships two actions with the same key fails at boot instead
of silently shadowing one with the other.

## Validation lifecycle

When a user POSTs to `/api/cron/jobs`, the route calls
`validateActionConfig(action, config)` which runs three checks in order
and short-circuits on the first error:

1. **Required check** — every `input.required === true` must have a
   non-empty value (`null` / `undefined` / `""` all count as empty).
2. **Per-input type check** — value must satisfy `input.type`. For
   numbers this also enforces `min` / `max`; for selects it enforces
   `options[]`; for json it enforces "is plain object."
3. **Optional `spec.validate(config)`** — your cross-field hook. Runs
   only if everything above passed. Return `null` to accept, or a
   human-readable error string to reject. The string lands in the
   `INVALID_ACTION_CONFIG` response body.

Use `spec.validate` only for rules a single `inputs[]` entry can't
express — e.g. "if `mode === 'absolute'`, `dueDate` must be present" or
"URL must use http or https" (the `http-request` action's hook).

```ts
// inside spec.ts
export const spec: ActionSpec = {
  // ...
  inputs: [
    { key: "url", label: "URL", type: "string", required: true },
    { key: "method", label: "Method", type: "select", options: [/* ... */] },
  ],
  validate: async (config) => {
    if (typeof config.url !== "string") return null; // already covered by inputs[]
    try {
      const u = new URL(config.url);
      if (u.protocol !== "http:" && u.protocol !== "https:")
        return `URL must use http or https, got ${u.protocol}`;
    } catch {
      return "URL is not parseable";
    }
    return null;
  },
};
```

## Runtime walkthrough

| Step | What happens |
|---|---|
| API boot | `app.ts` imports your module → your top-level `registerAction(...)` runs → action is now in the registry |
| `initCronActions()` runs (always) | Catalog now lists your action alongside the shipped ones; `/api/cron/actions` returns it |
| `startCron(...)` runs (only when `CRON_ENABLED=true`) | If your spec has `defaultCron` and no row exists for `spec.name`, a row is seeded with `task_type = spec.category` and `enabled = true` |
| Admin opens `/admin/cron` → "New job" | The drawer's action picker shows your action under the `category` you declared; the meta card renders icon / displayName / tags / version / dangerous |
| Admin selects your action | The drawer's config section renders one control per `inputs[]` entry, pre-filled from `default` values |
| Admin submits | `validateActionConfig` runs through inputs + your custom `validate`; on success a row is inserted with `task_type = spec.category` and the scheduler picks it up via `syncJob` without a restart |
| Tick fires | `cron/executor.ts` calls `getActionExecutor(spec.name)` → invokes your `execute(ctx, config)` → writes a `cron_job_logs` row with the returned string or thrown error |

## Worked example: full file set

A complete, self-contained example. Drop these four files into a
module and the admin UI surfaces a new option without any other change.

**`apps/api/src/modules/<your-module>/actions/notify-stale-issues/spec.ts`**

```ts
import type { ActionSpec } from "@/modules/cron";

export const spec: ActionSpec = {
  name: "notify-stale-issues",
  displayName: "Notify stale issues",
  description: "Email a digest of issues without updates for N days.",
  category: "notification",
  icon: "Mail",
  tags: ["notification", "digest"],
  version: "1.0.0",
  defaultCron: "0 0 9 * * 1",
  inputs: [
    { key: "days", label: "Days threshold", type: "number", required: true, min: 1, max: 365, default: 7 },
    { key: "to", label: "Recipient", type: "string", required: true, placeholder: "alerts@example.com" },
    { key: "subject", label: "Subject", type: "string", default: "Weekly stale-issue digest" },
  ],
  validate: async (config) => {
    if (typeof config.to !== "string") return null;
    if (!config.to.includes("@"))
      return "Recipient must look like an email address";
    return null;
  },
};
```

**`apps/api/src/modules/<your-module>/actions/notify-stale-issues/executor.ts`**

```ts
import type { ActionExecutor } from "@/modules/cron";
import { and, eq, isNull, lt } from "drizzle-orm";
import { items } from "@/modules/item/schema";

export const execute: ActionExecutor = async (ctx, config) => {
  const days = Number(config.days);
  const cutoffIso = new Date(Date.now() - days * 86_400_000).toISOString();
  // Title / status / updated_at live on the `items` base, not on the
  // issue-specific `issue_details` shard. Join when you need the
  // issue-only columns; for a stale-digest, `items` alone is enough.
  const stale = await ctx.db.select({ id: items.id, title: items.title })
    .from(items)
    .where(and(eq(items.type, "issue"), isNull(items.deletedAt), lt(items.updatedAt, cutoffIso)))
    .all();

  if (stale.length === 0)
    return "no stale issues";

  // ... send the email here ...

  ctx.logger.info({ count: stale.length, to: config.to, days }, "notify_stale_issues_sent");
  return `notified ${config.to} about ${stale.length} stale issues (${days}d cutoff)`;
};
```

**`apps/api/src/modules/<your-module>/actions/notify-stale-issues/index.ts`**

```ts
import { defineAction } from "@/modules/cron";
import { execute } from "./executor";
import { spec } from "./spec";

export default defineAction({ spec, execute });
```

**`apps/api/src/modules/<your-module>/index.ts`** (add to the existing file)

```ts
import { registerAction } from "@/modules/cron";
import notifyStaleIssues from "./actions/notify-stale-issues";

registerAction(notifyStaleIssues);
```

## Testing

Unit-test the executor directly — no scheduler, no registry, no HTTP
roundtrip needed. Use the same pattern as the shipped action tests
(`apps/api/src/modules/cron/actions/{http-request,shell,soft-delete-cleanup}/index.test.ts`).

```ts
// apps/api/src/modules/<your-module>/actions/notify-stale-issues/index.test.ts
import { beforeAll, describe, expect, test } from "bun:test";
import { __resetActionRegistryForTests, registerAction, validateActionConfig } from "@/modules/cron";
import notifyStaleIssues from ".";

const fakeLogger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, flush() {}, reopen() {} };
const ctx = { db: testDb, logger: fakeLogger as any };

beforeAll(() => {
  __resetActionRegistryForTests();
  registerAction(notifyStaleIssues);
});

describe("notify-stale-issues validate", () => {
  test("rejects missing recipient", async () => {
    expect(await validateActionConfig("notify-stale-issues", { days: 7 }))
      .toMatch(/to is required/);
  });

  test("rejects non-email recipient (custom validate)", async () => {
    expect(await validateActionConfig("notify-stale-issues", { days: 7, to: "alerts" }))
      .toMatch(/email address/);
  });

  test("accepts a well-formed config", async () => {
    expect(await validateActionConfig("notify-stale-issues", { days: 7, to: "a@b.c" }))
      .toBeNull();
  });
});

describe("notify-stale-issues execute", () => {
  test("returns 'no stale issues' when DB has none", async () => {
    const result = await notifyStaleIssues.execute(ctx, { days: 7, to: "a@b.c" });
    expect(result).toBe("no stale issues");
  });
});
```

Two split surfaces, two test scopes:
- **validate**: round-trips through `validateActionConfig` — proves the
  `inputs[]` schema + `spec.validate` reject what you expect.
- **execute**: calls `.execute(ctx, config)` directly with a real test
  DB and a fake logger — proves the work happens.

## Common patterns

- **DB cleanup** (e.g. trim a logs table): see
  `apps/api/src/modules/cron/actions/log-cleanup/`. The executor walks
  rows, deletes in bulk, returns a count summary. `defaultCron`
  schedules it for 03:00 quiet hours.
- **External probe** (HTTP ping / webhook fan-out): see
  `apps/api/src/modules/cron/actions/http-request/`. Spec declares the
  URL / method / headers as inputs; `spec.validate` enforces an http(s)
  scheme; executor uses `AbortSignal.timeout` for a bounded wall-clock.
- **Dangerous ops** (shell, raw SQL, file delete): see
  `apps/api/src/modules/cron/actions/shell/`. Spec sets
  `dangerous: true` to paint an amber banner in the create drawer
  *and* `defaultEnabled: false` so the action stays out of the
  registry until the operator opts in with `CRON_ACTIONS_ENABLED=shell`.
  Executor bounds the wall-clock and caps captured output.
- **Opt-in cleanup** (no `defaultCron`): see
  `apps/api/src/modules/cron/actions/soft-delete-cleanup/`. Ships
  without a default schedule so it never auto-mounts; operators
  schedule it explicitly when they want a janitor pass.
- **Notifications** (digest emails, slack pings): the worked example
  above.

## What not to do

- **Don't `import { db } from "..."`** — use `ctx.db`. The cron module
  passes a handle that's hot-swappable on DEK rotation; bypassing it
  pins your executor to a stale handle.
- **Don't store state in module scope** — the executor must be
  re-entrant. Two ticks can overlap if a previous run took longer than
  the interval (the scheduler's `overrunProtection: true` mitigates
  but doesn't eliminate this on the same job; a second job with the
  same executor body absolutely can run in parallel).
- **Don't return blobs.** The result string lands in
  `cron_job_logs.result` (text column). Log volume to `ctx.logger` and
  return a one-line summary.
- **Don't catch and swallow errors.** Throw so the executor records
  `status="failed"`, the error message lands in `cron_job_logs.error`,
  and the auto-pause budget ticks. Swallowing turns a broken
  integration into a green dashboard.
- **Don't re-declare types you can import.** `ActionSpec`,
  `ActionExecutor`, `ActionInput`, `ActionContext` all come from
  `@/modules/cron`.
- **Don't share `inputs[]` shapes across actions.** Each action's spec
  is self-contained on purpose — if two actions need the same set of
  fields, that's a smell; consider splitting them differently or
  letting one delegate to the other.
- **Don't seed jobs from your module's own code path.** Use
  `defaultCron` and let `startCron` seed once. Manually inserting a
  `cron_jobs` row from your module bypasses validation and audit.

## Quick checklist

Before opening a PR with a new action:

- [ ] Directory layout matches `spec.ts` / `executor.ts` / `index.ts` / `index.test.ts`
- [ ] `spec.name` is kebab-case, globally unique, and stable
- [ ] `spec.category` describes the action's _function_, not its provenance
- [ ] Every required input has `required: true`; numeric inputs have `min` / `max`
- [ ] `spec.validate` exists if and only if there's a cross-field rule
- [ ] `execute` only reads from `ctx.db` / `ctx.logger`; no module-level globals
- [ ] `execute` returns a short status string; long output goes to `ctx.logger`
- [ ] `execute` throws (does not return an error sentinel) on failure
- [ ] `registerAction(...)` is at the **top level** of your module's `index.ts`
- [ ] Tests cover the validate path (via `validateActionConfig`) and the execute path
- [ ] Lint + typecheck pass; `bun test src/modules/<your-module>` is green
