# `@app/web`

React 19 SPA with TanStack Router, Tailwind v4 and dual EN/ZH i18n.

## Registry screens

The registry UI is a set of file routes under `src/app/routes/_app`. Every
screen reads and writes through the registry API (`/api/registry`, see
[`docs/modules/registry.md`](../../docs/modules/registry.md)); there is no
asset upload form — assets are published from CI with an access token.

| Route | Screen |
|---|---|
| `/overview` | Package and storage usage against quota, the caller's namespace, the five newest versions, first-run steps while the account has no package. |
| `/packages` | Namespace with its owner, quota usage, the package table and the create dialog (slug, name, visibility — private by default — and `require_signature`). |
| `/packages/$ns/$pkg` | One package in four tabs: **Versions** (assets, new draft, publish, yank / restore, delete), **Channels** (add, move), **Install** (manifest URL and the `lode.toml` snippet) and **Settings** (edit, delete). Read-only for anyone who is neither the owner nor an administrator. |
| `/keys` | Signing keys: register a public ed25519 key, copy its `trusted_keys` entry, revoke. |
| `/tokens` | Access tokens with per-package or all-packages grants: create (the secret is shown once), edit grants, revoke. |
| `/admin/registry` | Administrators only, three tabs: **Namespaces** (suspend / restore, per-user quota), `/admin/registry/packages` (open, make private, delete) and `/admin/registry/tokens` (all tokens or `?user_id=` for one user, revoke). |

Sidebar entries are the `-<name>.nav.ts` files next to the routes; their
labels are `nav.<key>` in the `common` locale namespace.

### Shared library

`src/shared/lib/registry` is the only place that knows the wire format:

| File | Holds |
|---|---|
| `types.ts` | The snake_case wire shapes of `/api/registry`, field for field. |
| `api.ts` | One function per endpoint; each unwraps the response envelope and encodes its path segments. |
| `queries.ts` | The `registryKeys` factory and a `queryOptions` for every `GET`. Keys nest: invalidating `packages()` also covers every package and its versions, `adminTokens()` every per-user token list. |
| `format.ts` | `formatBytes` (binary units) and `usagePercent`. |
| `grants.ts` | Grant levels (`read` < `write` < `admin`) and the helpers that describe a token's grants. |
| `errors.ts` | `registryErrorMessage`: a registry error code to its text in the `regerrors` shard. |

All server state goes through TanStack Query with these query options; a
mutation invalidates the keys it affects instead of patching the cache.

### Locale shards

One JSON file per namespace in `src/locales/en` and `src/locales/zh`, with
identical key sets (`bun run check:i18n`):

| Shard | Used by |
|---|---|
| `portal` | `/overview` |
| `packages` | `/packages` (list and create dialog) |
| `package` | `/packages/$ns/$pkg` |
| `keys` | `/keys` |
| `grants` | `/tokens` — `tokens` was already taken by the account token tab of the settings dialog |
| `registry` | `/admin/registry` |
| `regerrors` | Registry error codes, shared by every screen |

### Private files

A file whose name starts with `-` is private to its route directory and
ignored by the router generator. A page keeps its dialogs, tab panels and
pure helpers there (`-detail-install.tsx`, `-detail-snippet.ts`,
`-grant-form.ts`, …), with the helper's `*.test.ts` beside it. Only
`<name>.tsx` (the route with `staticData.titleKey`) and `<name>.lazy.tsx`
(the component) are routes.
