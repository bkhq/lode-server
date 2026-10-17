# Operator guide

How to run an app that installs and updates through
[lode](https://github.com/bkhq/lode) from a package on this registry. lode
only ever issues two `GET` requests against the registry — the manifest and
the asset — so everything here is `lode.toml` configuration. The registry
side of the contract is in
[`modules/registry.md`](../modules/registry.md#read-feed--r); lode's own
options are in its
[`lode.example.toml`](https://github.com/bkhq/lode/blob/main/docs/lode.example.toml).

> `<host>` is the registry's hostname. If the registry is mounted under a
> `BASE_PATH`, put the prefix in front of `/r`.

## `lode.toml` for a registry package

The publisher gives you three things: the package address
`<namespace>/<slug>`, the asset file name for your platform, and — for a
signed package — a `trusted_keys` entry.

```toml
[global]
app = "<slug>"                 # the package slug: it is the manifest "name"

[update]
manifest = "https://<host>/r/<namespace>/<slug>/manifest.json"
asset    = "<asset filename>"  # exact file name, e.g. myapp-linux-x64.tar.gz
channel  = "stable"            # the channel to follow
policy   = "auto"              # off | check | auto
check_interval = 300           # seconds between update checks (lode's default)

[trust]
require_signature = "enforce"
trusted_keys = ["<key_id>:<base64url-pubkey>"]
```

Signatures name the package, so `[global].app` has to be the package slug.

- `[global].app` must equal the package **slug**, not its display name.
- The namespace is an 8-character id assigned by the registry; it says
  nothing about who the publisher is. Take the address from the publisher,
  not from a guess.
- `asset` selects one file of the release by its exact name.
- Asset URLs in the manifest are absolute and on the manifest's host.
- lode refuses plain `http` for anything but loopback; use the `https` URL.

## Trust

The registry checks a signature when the publisher uploads it and serves it
inside the manifest, but **it never holds a private key and cannot sign for
a publisher**. Whether your host verifies is your setting:

| `require_signature` | What lode does |
|---|---|
| `"enforce"` | Installs only an asset whose signature verifies under one of your `trusted_keys`. An unsigned asset is rejected. |
| `"auto"` | With `trusted_keys` set: a signature is required, as under `enforce`. With no trusted keys: installs **unverified**, with a warning. |
| `"off"` | Checks the SHA-256 from the manifest only. |

Pin the publisher's key as `<key_id>:<base64url-pubkey>` — the
`trusted_keys` entry `lode-cli keygen` printed for them — and use
`"enforce"`. Get the entry from the publisher over a channel you trust, not
from the registry: then a compromised registry (or publisher account) can
withhold a release or replay an old one, but cannot make your host run bytes
the publisher did not sign.

**An unsigned package** — one whose publisher uploads without a signature —
installs only under `"off"`, or `"auto"` with no trusted keys. In both cases
the checksum comes from the same server as the bytes: you are trusting the
registry and the publisher's account completely.

**A signed manifest** closes what per-asset signatures leave open: a
registry that withholds a release or keeps serving an old list. With a
publisher who signs the manifest (the package's Install tab says whether
they do), add to `[trust]`:

```toml
require_manifest = "fresh"     # off (default) | signed | fresh
```

`signed` requires the publisher's signature over the list of versions and
channels; `fresh` also requires a signed expiry that has not passed. Know
what you turn on:

- After each release the manifest is unsigned until the publisher signs it
  again, and it becomes unsigned if they let the expiry lapse. A host on
  `signed` or `fresh` refuses it for that time with
  `require_manifest=… but the manifest has no signature`.

**Delegated signing** (lode 0.1.0 or later). A publisher may keep the key
you pin offline and sign releases with a sub-key it delegated to. The
manifest then carries that `delegation`, and lode accepts the sub-key's
signatures on assets and on the manifest while the delegation is within its
window. You still pin only the root key; the Install tab's `lode.toml` does
that. lode 0.0.3 and older reject sub-key signatures with
`signature did not match any trusted key`.

To drop a leaked sub-key before its delegation runs out, subscribe to the
package's revocation list:

```toml
revocation_url = "https://<host>/r/<namespace>/<slug>/revocations.json"   # in [trust]
```

lode fetches it on every update check, verifies it against your trusted
keys, keeps every id it has seen in `$LODE_DIR/revocations.json`, and never
fails an update because the list is unreachable. A private package's list
needs the same `[http].headers` as its manifest. The registry also stops
serving a revoked sub-key's delegation at once, so hosts without the setting
refuse it too, on their next manifest fetch.

**The downgrade floor** protects the channel pointer. When it follows a
channel, lode refuses a version older than the one it has already installed.
If a pointer is rolled back — by the publisher or by anyone who gained
control of it — a running host stays where it is and `lode-cli update` exits
1 with a refusal. To go back deliberately, use `[update].pin`,
`lode-cli update --version <v>` or `lode rollback`. Versions that are not
semver cannot be ordered, so the floor does not apply to them.

## Private packages

A private package's feed needs a token with a `read` grant on the package.
The package owner creates it (see the
[publisher guide](publisher.md#4-tokens-and-grants)); a `read` grant can
fetch and nothing else.

```toml
[http]
headers = ["Authorization: Bearer ${LODE_REGISTRY_TOKEN}"]
```

- `LODE_REGISTRY_TOKEN` must be set in lode's environment; an unset variable
  in `headers` is a hard error in lode. Keep the token out of `lode.toml`.
- lode sends the header on the manifest fetch and on the asset download,
  because both are on the same host.
- **Every refusal is the same 404.** A missing token, a token without a
  grant on this package, a revoked or expired token, a wrong namespace or
  slug: all answer the identical `NOT_FOUND` body as a package that does not
  exist, so the registry does not reveal which private packages exist. When
  a private package 404s, check the token first.
- Responses of a private package are `Cache-Control: private, no-store`.

## Rate limiting

The read feed shares one rate-limit bucket with the registry's raw API:
`RAW_API_RATE_LIMIT_PER_MINUTE`, **120 requests per minute per client IP**
by default. Over it, the registry answers 429.

The bucket is per IP, so every host behind one NAT address shares it. An
update check is one manifest request; at lode's default `check_interval` of
300 s a host spends 0.2 requests a minute, so the default carries a few
hundred hosts behind one address in steady state. The spikes are what trip
it: a bootstrap or an update is a manifest request plus an asset download,
so more than about 60 hosts behind one address starting or updating within
the same minute run into the limit. lode retries on its next check; if your
fleet is that large, stagger restarts or ask the registry's administrator to
raise the limit.

## Caching

| Response | Headers |
|---|---|
| Manifest of a public package | A strong `ETag` and `Cache-Control: public, max-age=60`; `If-None-Match` is answered with 304. |
| Asset of a public package | `Cache-Control: public, max-age=31536000, immutable` — a published asset never changes. |
| Anything of a private package | `Cache-Control: private, no-store`, no `ETag`. |

A new release can therefore take up to a minute to show through a cache,
plus your `check_interval`.

The manifest lists the newest 50 published versions of a package, plus every
version a channel points at. Older versions stay downloadable but are no
longer listed.

## Suspended namespaces and yanked versions

- **A suspended namespace** — an administrator's takedown — answers the same
  404 on every feed URL: manifest and assets, public or private. From your
  side it is indistinguishable from a package that was deleted. Nothing new
  can be fetched; a host that has not installed yet fails at bootstrap (lode
  exits 1 on the 404). What a host already installed stays on its disk.
- **A yanked version** disappears from the manifest and its asset URL
  answers 404. A channel cannot point at a yanked version, so a host
  following a channel is never led to one; a host already running it keeps
  it, and a `pin` on it can no longer be fetched.
- A **draft** is never served.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| Manifest answers 404 `NOT_FOUND` | Wrong namespace or slug; private package without a valid `read` token; namespace suspended; package deleted. | `curl -i https://<host>/r/<namespace>/<slug>/manifest.json`, with the `Authorization` header for a private package. |
| Manifest URL returns HTML with a 200 | The URL does not start with the registry's `/r/` prefix (wrong host or missing `BASE_PATH`), so the web app answered. | Compare with the address the publisher gave you. |
| lode rejects the manifest name | `[global].app` is not the package slug. | Set it to the `name` in the manifest. |
| lode finds no asset | `[update].asset` is not an exact file name of that version, or `[update].channel` does not exist in the manifest. | Read `channels` and `versions.<v>.assets[].name` in the manifest. |
| Signature refused under `enforce` | `trusted_keys` has a different key than the publisher signs with, or the asset is unsigned. | The asset's `key_id` in the manifest must match the `<key_id>` you pinned; an unsigned asset has no `sig`. |
| Installs with an UNVERIFIED warning | `require_signature = "auto"` with no `trusted_keys`. | Pin the publisher's key. |
| lode fails on `${LODE_REGISTRY_TOKEN}` | The variable is not set in lode's environment. | Set it where lode runs (container env, unit file). |
| A release does not arrive | Up to 60 s of manifest caching plus `check_interval`; `policy = "check"` only reports; the release went to another channel. | Read `channels.<name>.latest` in the manifest. |
| Host stays on the newer version after a rollback | lode's downgrade floor. | Expected; downgrade deliberately with `pin`, `update --version` or `lode rollback`. |
| 429 | More than 120 requests a minute from your public IP. | See [Rate limiting](#rate-limiting). |
| Asset answers 404 while the manifest works | The version was yanked or deleted after your host read the manifest. | Fetch the manifest again. |

## See also

- [`modules/registry.md`](../modules/registry.md#read-feed--r) — the feed's
  contract.
- [`reference/api.md`](../reference/api.md#registry-read-feed) — the two
  routes.
- [Publisher guide](publisher.md).
