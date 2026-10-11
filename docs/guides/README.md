# Guides

Task-oriented walkthroughs for the people who use a running registry. The
contract they rely on — every route, field, limit and error code — is
[`modules/registry.md`](../modules/registry.md); the guides link to it instead
of repeating its tables.

| Guide | For |
|---|---|
| [publisher.md](publisher.md) | Someone releasing a package from CI: namespace, package, signing keys, tokens, `scripts/publish.sh`, channels, quotas. |
| [operator.md](operator.md) | Someone running an app that updates through lode from this registry: `lode.toml`, trust, private packages, rate limits, troubleshooting. |

Running the registry itself is covered by
[`develop/deployment.md`](../develop/deployment.md) — the
[Cloudflare Workers](../develop/deployment.md#cloudflare-workers) part for
the production target.
