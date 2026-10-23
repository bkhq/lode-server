# Module Recipe

A copy-paste starter pack for a new module. Templates are stripped-down versions of the shipped `issue` module — minimal, but real working shapes.

Workflow: copy the snippets below in playbook order ([`playbook.md`](playbook.md)), then run a single rename to swap the placeholders for your module's name. Pick:

- `<name>` — kebab-case singular, lowercase (e.g. `ticket`). Used for the directory, file prefixes, and route prefix.
- `<Name>` — PascalCase (e.g. `Ticket`). Used in exported symbols.
- `<NAMES>` — i18n / display plural (e.g. `tickets`).

Single rename pass once the files are in place:

```bash
# Bash, GNU sed (Linux). On macOS use `sed -i ""` and ensure the literals are unique.
NAME=ticket
NAME_PASCAL=Ticket
NAME_PLURAL=tickets

grep -rl '<name>'   apps/ tests/ docs/modules/ | xargs sed -i "s/<name>/$NAME/g"
grep -rl '<Name>'   apps/ tests/ docs/modules/ | xargs sed -i "s/<Name>/$NAME_PASCAL/g"
grep -rl '<NAMES>'  apps/ tests/ docs/modules/ | xargs sed -i "s/<NAMES>/$NAME_PLURAL/g"
```

The standards forbid AI markers and Chinese in commit metadata — see [`standards.md` §7](standards.md#7-commit-rules). Keep your generated files English-only.

---

## Step 1 — Backend four-file set

Place these under `apps/api/src/modules/<name>/`.

### `schema.ts`

```ts
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { items } from "@/modules/item/schema";

// Sub-type of the `item` base. The base owns title / status / creator /
// version / soft-delete / timestamps; this table holds only the
// <name>-specific fields. See docs/modules/item.md for the composition rule.
export const <name>Details = sqliteTable("<name>_details", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => items.id, { onDelete: "cascade" }),
  description: text("description"),
});
```

### `<name>.service.ts`

```ts
import type { AppDatabase } from "@/shared/lib/types";
import { eq } from "drizzle-orm";
import { items } from "@/modules/item/schema";
import { createItem, softDeleteItem } from "@/modules/item/item.service";
import { NotFoundError } from "@/shared/lib/errors";
import { <name>Details } from "./schema";

export interface Create<Name>Input {
  readonly title: string;
  readonly description?: string;
  readonly creatorId: string;
}

export async function create<Name>(db: AppDatabase, input: Create<Name>Input) {
  const item = await createItem(db, {
    type: "<name>",
    title: input.title,
    creatorId: input.creatorId,
  });
  await db.insert(<name>Details).values({
    itemId: item.id,
    description: input.description ?? null,
  });
  return { ...item, description: input.description ?? null };
}

export async function get<Name>ByShortId(db: AppDatabase, shortId: string) {
  const rows = await db
    .select()
    .from(items)
    .leftJoin(<name>Details, eq(<name>Details.itemId, items.id))
    .where(eq(items.shortId, shortId))
    .limit(1);
  const row = rows[0];
  if (!row || row.items.deletedAt !== null) return null;
  return { ...row.items, description: row.<name>_details?.description ?? null };
}

export async function softDelete<Name>(db: AppDatabase, id: string) {
  const existing = await get<Name>ByShortId(db, id);
  if (!existing) throw new NotFoundError("<Name>", id);
  await softDeleteItem(db, existing.id);
}
```

### `<name>.routes.ts`

```ts
import type { Context } from "hono";
import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { z } from "zod";
import { audit } from "@/modules/audit/audit.service";
import { getClientIp } from "@/shared/lib/client-ip";
import { NotFoundError } from "@/shared/lib/errors";
import { authRequired } from "@/shared/middleware/auth";
import { create<Name>, get<Name>ByShortId, softDelete<Name> } from "./<name>.service";

const createSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
});

function auditMeta(c: Context) {
  return {
    ip: getClientIp(c),
    userAgent: c.req.header("user-agent") ?? "unknown",
  };
}

export function <name>Routes() {
  const router = new Hono<AppEnv>();
  router.use("*", authRequired);

  router.post("/<NAMES>", async (c) => {
    const db = c.get("db");
    const actor = c.get("user")!;
    const body = createSchema.parse(await c.req.json());
    const created = await create<Name>(db, { ...body, creatorId: actor.id });
    await audit(db, c.get("logger"), {
      actorId: actor.id,
      actorName: actor.name,
      action: "<name>.created",
      resourceType: "<name>",
      resourceId: created.id,
      resourceName: created.title,
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: created }, 201);
  });

  router.get("/<NAMES>/:id", async (c) => {
    const db = c.get("db");
    const row = await get<Name>ByShortId(db, c.req.param("id"));
    if (!row) throw new NotFoundError("<Name>", c.req.param("id"));
    return c.json({ success: true, data: row });
  });

  router.delete("/<NAMES>/:id", async (c) => {
    const db = c.get("db");
    const actor = c.get("user")!;
    const id = c.req.param("id");
    await softDelete<Name>(db, id);
    await audit(db, c.get("logger"), {
      actorId: actor.id,
      actorName: actor.name,
      action: "<name>.deleted",
      resourceType: "<name>",
      resourceId: id,
      ...auditMeta(c),
      result: "success",
    });
    return c.json({ success: true, data: { id } });
  });

  return router;
}
```

### `<name>.backup.ts`

```ts
import type { BackupContribution } from "@/modules/backup/registry";
import { <name>Details } from "./schema";

export const <name>BackupContribution: BackupContribution = {
  name: "<NAMES>",
  tables: [<name>Details],
  deps: ["items", "policies"],
};
```

### `index.ts`

```ts
import { registerBackupContribution } from "@/modules/backup/registry";
import { <name>BackupContribution } from "./<name>.backup";

export { <name>Routes } from "./<name>.routes";

registerBackupContribution(<name>BackupContribution);
```

---

## Step 2 — Re-export schema for drizzle-kit

Append to `apps/api/src/db/schema.ts`, keeping the list alphabetical:

```ts
export * from "@/modules/<name>/schema";
```

---

## Step 3 — Mount the routes

In `apps/api/src/routes/protected.ts`, add the import alphabetically and a single `app.route` line beside the others:

```ts
import { <name>Routes } from "@/modules/<name>";
// ...
app.route("/", <name>Routes());
```

---

## Step 4 — Policy relation (skip if reusing `item` defaults)

Open `apps/api/src/modules/policy/namespace-config.ts`. If the `item` namespace already covers your relations, do nothing. To add a new relation, append one entry **inside the existing namespace's `relations` block**:

```ts
my_relation: { union: [{ this: {} }] },
```

A resource that is not content-shaped gets a namespace of its own instead. Register it from the module's `index.ts` rather than editing `namespace-config.ts`:

```ts
import { registerNamespace } from "@/modules/policy";

registerNamespace({ name: "<name>", relations: { viewer: { union: [{ this: {} }] } } });
```

It survives the `loadNamespaces()` reset tests call, and a second module claiming the same name with a different config fails at boot.

---

## Step 5 — Backup wiring

Steps 1's `<name>.backup.ts` and `index.ts` already do this. Confirm `index.ts` calls `registerBackupContribution(...)`; the side-effect import via `protected.ts` activates it at boot.

---

## Step 6 — Sidebar nav

Create `apps/web/src/app/routes/_app/portal/-<name>.nav.ts` (use `admin/` if it is an admin-only page):

```ts
import type { NavItem } from "@/shared/components/sidebar/types";
import { ListChecks } from "lucide-react";

export const <name>Nav: NavItem = {
  area: "portal",
  key: "<NAMES>",
  path: "/portal/<NAMES>",
  icon: ListChecks,
  order: 30,
};
```

The sidebar registry picks up every `-*.nav.ts` under `apps/web/src/app/routes/` by glob; no registration edit is needed.

---

## Step 7 — i18n shards

Create both files with matching keys.

### `apps/web/src/locales/en/<name>.json`

```json
{
  "page": {
    "title": "<NAMES>",
    "description": "Manage <NAMES>."
  },
  "create": "Create",
  "delete": "Delete",
  "empty": "No <NAMES> yet."
}
```

### `apps/web/src/locales/zh/<name>.json`

Mirror the English file with translated values; **the key set must match exactly** — `bun run check:i18n` enforces parity.

---

## Step 8 — Tests

### Unit: `apps/api/src/modules/<name>/<name>.test.ts`

```ts
import type { AppDatabase } from "@/db";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { loadNamespaces } from "@/modules/policy/namespace-config";
import { nanoid } from "@/shared/lib/id";
import { create<Name>, get<Name>ByShortId } from "./<name>.service";

let db: AppDatabase;
let dbPath: string;

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-<name>-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
  loadNamespaces();
});

afterEach(() => {
  db.close();
  rmSync(resolve(dbPath, ".."), { recursive: true, force: true });
});

describe("<name>.service", () => {
  test("creates and reads back a <name>", async () => {
    const creatorId = nanoid();
    await db.insert(users).values({
      id: creatorId,
      oauthSub: `sub-${creatorId}`,
      username: `u-${creatorId}`,
      name: "Test",
      email: `${creatorId}@test.com`,
      role: "user",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    const created = await create<Name>(db, {
      title: "first",
      description: "hello",
      creatorId,
    });
    const found = await get<Name>ByShortId(db, created.shortId);
    expect(found?.title).toBe("first");
    expect(found?.description).toBe("hello");
  });
});
```

There is no shared test-helper module — each module stands up its own temp SQLite via `createDb`. See `apps/api/src/modules/issue/issue.test.ts` for the reference pattern (and [§5.1 in standards.md](standards.md#51-backend-unit-half-of-50)).

### E2E: `tests/e2e/modules/<name>/<NAMES>.test.ts`

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

describe("<NAMES> e2e", () => {
  let admin: Awaited<ReturnType<typeof getClient>>;
  const created: string[] = [];

  beforeAll(async () => {
    admin = await getClient("admin@example.com");
  });

  afterAll(async () => {
    for (const id of created) {
      await admin.delete(`/api/<NAMES>/${id}`).catch(() => {});
    }
  });

  it("creates a <name>", async () => {
    const res = await admin.post("/api/<NAMES>", { title: "hi" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    created.push(body.data.shortId);
  });

  it("rejects unauthenticated", async () => {
    const anon = await getClient(null);
    const res = await anon.post("/api/<NAMES>", { title: "no" });
    expect(res.status).toBe(401);
  });
});
```

Then append `"<name>"` to `MODULE_DIRS` in `tests/e2e/run.ts`.

---

## Step 9 — Module doc

Create `docs/modules/<name>.md` modelled on `docs/modules/issue.md`. Required sections: file layout, database, routes, auditing, **end-to-end coverage** (list each `tests/e2e/modules/<name>/*.test.ts` and what it asserts), out-of-scope. Then add one row to `docs/architecture.md`, `docs/reference/api.md`, and `docs/reference/database.md` per [§4](standards.md#4-documentation-sync).

---

## Step 10 — Migration and verify

```bash
bun run --filter @app/api db:generate   # commit drizzle/<n>_*.sql + meta/_journal.json
bun run typecheck
bun run lint
bun run check:i18n                       # en / zh namespace parity
bun run check:api-docs                   # docs/reference/api-routes.md vs live routes
bun run check                            # full gate: lint + typecheck + test + build + check:i18n + check:env-docs + check:api-docs
bun run test:e2e                         # live stack: dex + API + every module
```

If anything is red, fix it locally before opening the PR. See [§8 in standards.md](standards.md#8-pre-merge-acceptance-checklist) for the full pre-merge checklist.
