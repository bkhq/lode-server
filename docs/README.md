# Documentation

Lode Server is a hosted, multi-user release registry for
[lode](https://github.com/bkhq/lode), built on the
[bun-tpl](https://github.com/zzci/bun-tpl) template: Hono API, React 19 SPA,
SQLite via Drizzle, lode-supervised release asset. The registry is the
`registry` module — see [`modules/registry.md`](modules/registry.md) for what
it does and [`guides/`](guides/) for how to use it; the plan it implements is
[`plan/20261009-2241-lode-registry-server.md`](plan/20261009-2241-lode-registry-server.md).

The top-level [`../README.md`](../README.md) is the quick-start. This
directory holds the long-form documentation, organised into four buckets:

| Bucket | Audience | Contents |
|---|---|---|
| [`guides/`](guides/) | Registry users | Task-oriented guides: [publishing a package from CI](guides/publisher.md), [running an app that updates from the registry](guides/operator.md). |
| [`develop/`](develop/) | Developer / operator | Deployment, ops runbook, fork lifecycle, and module-development docs (standards, playbook, recipe, cron-actions, policy-standard). |
| [`reference/`](reference/) | Anyone looking up a fact | HTTP API, env vars, database tables, flat per-route index. The latter two are auto-generated. |
| [`modules/`](modules/) | Anyone needing a module's behaviour | One page per shipped module — what it does, its routes, its tables, its config. |

Plus three top-level documents that don't belong in any of the buckets:

| Topic | File |
|---|---|
| Runtime shape, modules, request flow | [architecture.md](architecture.md) |
| Changelog (this fork's entries, then the upstream template's history) | [changelog.md](changelog.md) |
| This page | README.md |

## Quick links

**Publishing a package** → [`guides/publisher.md`](guides/publisher.md)
**Installing a package with lode** → [`guides/operator.md`](guides/operator.md)
**Deploying to Cloudflare Workers** → [`develop/deployment.md`](develop/deployment.md#cloudflare-workers)
**Rebranding and upstream template merges** → [`develop/forking.md`](develop/forking.md)
**Adding a new module** → [`develop/module/`](develop/module/) (start with
`playbook.md`, reach for `standards.md` when you need the rationale)
**Deploying to production** → [`develop/deployment.md`](develop/deployment.md)
**Bun vs Cloudflare Workers** → [`develop/runtime.md`](develop/runtime.md)
**Day-2 operations** → [`develop/operations.md`](develop/operations.md)
**HTTP surface** → [`reference/api.md`](reference/api.md)
**Env vars** → [`reference/env-reference.md`](reference/env-reference.md)
**Database** → [`reference/database.md`](reference/database.md)
**A specific module** → [`modules/`](modules/)
