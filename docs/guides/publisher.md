# Publisher guide

How to release a package to a lode registry from CI. The contract behind
every step — routes, fields, limits, error codes — is
[`modules/registry.md`](../modules/registry.md); this guide links to it
rather than repeating its tables.

> `<host>` is the registry's hostname. Paths omit `BASE_PATH`; if the
> registry is mounted under a prefix, put the prefix in front of `/api` and
> `/r`.

A release is draft-first: create a draft version, upload its assets, then
one `publish` call makes the version visible and moves the channel pointer
in a single transaction. A lode client polling mid-release sees either the
old release or the complete new one.

## 1. Sign in and find your namespace

Sign in to the web UI. Every user has exactly one namespace: an
8-character id assigned by the system (for example `k3f9x2ab`). It is never
chosen and never changes.

Read it in the web UI, or from a signed-in session with
`GET /api/registry/namespace`.

Packages are addressed as `<namespace>/<slug>` everywhere: in API paths
(`/api/registry/packages/<namespace>/<slug>`), in token grants and in the
operator's manifest URL (`https://<host>/r/<namespace>/<slug>/manifest.json`).

## 2. Create a package

Creating a package needs a signed-in session — the web UI, or
`POST /api/registry/packages` from a session. A token cannot create or
delete packages.

```json
{ "slug": "myapp", "name": "My App", "visibility": "public", "require_signature": false }
```

| Field | Rule |
|---|---|
| `slug` | Lowercase letters, digits and `-`, not starting with `-`, at most 128 characters, unique within your namespace. **Permanent**: it is the URL segment and the manifest `name`, so operators set `[global].app` to it. |
| `name` | Free display text, 1–100 characters, editable. |
| `visibility` | `public` (anyone can fetch the feed) or `private` (the feed needs a token with a `read` grant). Editable. |
| `description` | Optional. |
| `require_signature` | Off by default. When on, the registry refuses every unsigned upload — see [Signing keys](#3-signing-keys). Editable. |

## 3. Signing keys

Signing is optional but recommended: it is what lets an operator verify that
an asset came from you and not merely from the registry.

1. Run `lode-cli keygen` once. It prints a `key_id`, a `trusted_keys` entry
   (`<key_id>:<base64url-pubkey>`) and the private seed.
2. Keep the seed as a CI secret (`LODE_SIGNING_KEY`). That is all CI needs:
   `lode-cli publish --key-env LODE_SIGNING_KEY` registers the public key for
   the package before it uploads, and leaves it alone on later runs. Registering by hand works as well: the Signing keys tab of the
   package page, or `POST /api/registry/packages/<namespace>/<slug>/keys`
   with `{ "public_key": "…", "name": "…" }`. Keys belong to one package; to
   sign several packages with the same key, register it for each. A
   signature names the package slug, so an asset signed for one package is
   not valid in another.
3. Hand the `trusted_keys` entry to your operators. This is the step that
   protects them: a stolen CI token can register another key for the
   package, but an operator who pins your key under
   `require_signature = "enforce"` will not install anything signed with it.

What to know:

- **The registry never holds a private key.** You sign locally with
  `lode-cli sign`; the registry verifies the signature against your active
  keys when the asset is uploaded and refuses a bad one (400
  `INVALID_SIGNATURE`), so a broken signature fails once at publish time
  instead of on every operator host.
- **ed25519 only.** ECDSA keys are refused at registration (400
  `INVALID_PUBLIC_KEY`).
- **Revocation is final.** `DELETE /api/registry/packages/<namespace>/<slug>/keys/:id` stops new uploads
  verifying under the key, and the same key cannot be registered again.
  Signatures already stored stay in the manifest.
- **`require_signature` on a package** makes the registry refuse an unsigned
  upload (400 `SIGNATURE_REQUIRED`). Without it an unsigned asset is
  accepted and served without a signature, and lode installs it only when
  the operator runs with `require_signature = "off"` (or `"auto"` with no
  trusted keys).
- The signature covers the asset's **file name**, the **version** and the
  bytes. Rename a file or change the version after signing and the upload is
  refused.

`lode-cli` is the `lode` binary under another name; the example workflow
copies it out of the `bkhq/lode` image.

### Signing the manifest

Signing assets proves what each file is. Signing the **manifest** proves
which versions and channel pointers you published, and — with an expiry —
that the list is recent. Operators ask for it with
`[trust].require_manifest = "signed"` or `"fresh"`.
It is optional: without it everything above works as before.

The registry generates the manifest and cannot sign it for you, so you sign
what it generates:

```bash
export LODE_REGISTRY_TOKEN=pat_…        # write grant on the package
export LODE_SIGNING_KEY=…               # the seed from lode-cli keygen
scripts/sign-manifest.sh --package <namespace>/<slug> --expires-in 30d --expect stable=1.4.2
```

The script downloads `/r/<namespace>/<slug>/manifest.json`, prints its
channels, runs `lode-cli manifest-sign` and sends the
signature to `PUT /api/registry/packages/<namespace>/<slug>/manifest-signature`.
The key must be registered for the package.

The manifest comes from the registry, so the script does not sign a change
you did not state. `--expect <channel>=<version>`, once per channel, says
what the channels must point at; the manifest is signed only when they are
exactly that. A manifest that still carries your key's signature — nothing
changed since you signed it — is renewed without `--expect`, which is what a
scheduled run does. If a scheduled run refuses, a channel or version changed
without you: look at the registry before signing anything.

Two things to keep up once you start:

- **Sign after every release step.** A publish, a channel move, a yank or a
  restore changes the manifest; the registry then serves it unsigned until
  you sign again, and hosts that require a signed manifest take no updates
  in between.
- **Sign again before the expiry.** Run the script on a schedule well inside
  `--expires-in` (weekly for `30d`). When an expiry lapses the registry
  drops the signature and serves the manifest unsigned.

The package's Install tab shows the state: signed and until when, or why it
is not. Look at what the script prints before trusting a scheduled run with
your key: a signature vouches for every version and channel in the manifest
at that moment, including one somebody else released with a stolen token.

## 4. Tokens and grants

There is one kind of token: the personal API token, sent as
`Authorization: Bearer pat_…`. What it may touch is set by its **grants**.

| Grant | Opens, on the granted package |
|---|---|
| `read` | Package and version metadata; the read feed of a private package. This is what an operator host uses. |
| `write` | Plus the release routes: create a draft, upload assets, publish, move a channel pointer, delete a **draft**. **This is what CI needs.** |
| `admin` | Plus package settings (name, visibility, description, `require_signature`), yank and restore. |

A grant names one package (`<namespace>/<slug>`) or is the single "all my
packages" grant, which also covers packages you create later. A token with
no grant reaches no package.

Create a token on the token page of the web UI, or from a session with
`POST /api/registry/tokens`:

```json
{ "name": "ci-myapp", "grants": [{ "package": "<namespace>/myapp", "access": "write" }] }
```

`"grants": { "all": "write" }` is the all-packages form; `expires_at` is
optional. **The secret is shown once**, in the creation response. Grants can
be changed later (`PUT /api/registry/tokens/:id`) without reissuing it.

A token can **never**, whatever its grants: create or delete a package,
delete a published or yanked version, revoke a signing key, manage tokens, read
the namespace or the quota, or call the administration routes. Those need a
signed-in session.

Give CI a token with a `write` grant on the one package it releases and
nothing else.

## 5. Publish with `lode-cli publish`

`lode-cli publish` does the whole release: draft → upload every asset →
publish to a channel.

```bash
LODE_REGISTRY_TOKEN=pat_... lode-cli publish \
  --package <namespace>/<slug> --version 1.4.2 \
  [--channel stable] [--notes "text"] [--key-env LODE_SIGNING_KEY] \
  dist/myapp-linux-x64.tar.gz dist/myapp-linux-arm64.tar.gz
```

| Option | Meaning |
|---|---|
| `--registry` | Base URL of the registry, including a base path when it has one. Default `https://lode.bk.io/u`: the console and its API are under `/u`, the read feed under `/r` at the origin root. |
| `--package` | The package, as `<namespace>/<slug>`. |
| `--version` | The version to release. Letters, digits, `.`, `_`, `-`; not starting with `.` or `-`. |
| `--channel` | The channel that will point at the version. Default `stable`. |
| `--notes` | Release notes, stored when the draft is created. |
| `--key <file>` / `--key-env <VAR>` | The ed25519 signing key, as `lode-cli sign` takes it. With one, every asset is signed and the public key is registered for the package on the first run. Without one the assets are uploaded unsigned. |
| `--run` / `--exec` | Launch-command overrides published with every asset of the release and bound into each signature. |
| `--allow-insecure` | Permit a plain-`http` registry that is not on loopback. |
| `<file>...` | The assets. Each is stored under its file name — the name an operator selects with `[update].asset`. |

The token is read from `LODE_REGISTRY_TOKEN` only; there is no option for it.
`lode-cli` is the `lode` binary under another name, shipped in the
`bkhq/lode` image and in lode's releases.

Behaviour worth knowing:

- **Sizes.** An asset up to 95 MiB goes up in one request; a larger one, up
  to the 500 MiB asset limit, as a multipart upload in the part size the
  registry dictates. Every file is checked before the first request.
- **Re-running a failed job is safe.** When the draft already exists the
  command continues into it, and an asset uploaded again replaces the one of
  the same name. The notes of an existing draft are kept. A version that is
  already published is immutable: releasing it again fails.
- A refusal is reported on stderr with the HTTP status and the registry's
  error code, and the exit status is non-zero.

Where `lode-cli` cannot be installed,
[`scripts/publish.sh`](../../scripts/publish.sh) does the same release with
`bash`, `curl`, `jq` and — for signing — `lode-cli sign` and `openssl`. It
takes the same `--registry`, `--package`, `--version`, `--channel` and
`--notes`, reads `LODE_SIGNING_KEY` from the environment, and does not send
`run` / `exec`.

## 6. Publish from CI

[`examples/publish/`](../../examples/publish/) holds a GitHub Actions
workflow for the **package's own repository**: on a published GitHub release
(or a manual run with a version) it builds the assets, installs `lode-cli`
and runs `lode-cli publish`, signing when a key is configured. Its
[README](../../examples/publish/README.md) has the set-up steps. Configure:

| Kind | Name | Value |
|---|---|---|
| Secret | `LODE_REGISTRY_TOKEN` | A token with a `write` grant on `<namespace>/<slug>` and nothing else. |
| Secret | `LODE_SIGNING_KEY` | Optional. The seed from `lode-cli keygen`. Its public half is registered for the package by the command. |
| Variable | `LODE_REGISTRY_URL` | Optional. Base URL of another registry; unset, the release goes to `https://lode.bk.io/u`. |
| Variable | `LODE_PACKAGE` | `<namespace>/<slug>`. |

The version is the release tag without its leading `v`. A release goes to
`stable`; a manual run goes to the channel it is given, which is also how a
failed run is retried. Pin `LODE_IMAGE` in the workflow to a version you have
reviewed.

Any other CI system works the same way: put the two secrets in the
environment and call the command.

To serve a signed manifest as well, add
[`sign-manifest.yml`](../../examples/publish/sign-manifest.yml) from the same
directory: it signs after each publish run, expecting `stable` at the released
version, and renews an unchanged manifest once a week. See
[Signing the manifest](#signing-the-manifest).

## 7. Channels, rollback, yank

A **channel** is a named pointer at a published version; operators follow
one with `[update].channel`. `publish` moves the channel it is given. To
move a pointer without publishing — promote a version from `beta` to
`stable`, or roll back — a `write` grant is enough:

```bash
curl -fsS -X PUT -H "Authorization: Bearer $LODE_REGISTRY_TOKEN" \
  -H 'Content-Type: application/json' --data '{"version":"1.4.1"}' \
  "https://<host>/api/registry/packages/<namespace>/<slug>/channels/stable"
```

The target must be published (409 `VERSION_NOT_PUBLISHED`).

**Rolling back a pointer does not downgrade running hosts.** lode refuses to
follow `latest` to a version older than the one it has already installed
(its downgrade floor), so only fresh installs get the older version. To move
every host off a bad release, publish a fixed, higher version.

**Yank** hides a published version: it leaves the manifest and its assets
stop downloading. `POST …/versions/:ver/yank` needs an `admin` grant or a
session, and is refused while a channel points at the version (409
`VERSION_IN_CHANNEL`) — move the pointer first. `POST …/versions/:ver/restore`
puts it back.

Deleting a published or yanked version needs a session (owner or
administrator) and no channel pointing at it.

## 8. Quotas and errors

`GET /api/registry/quota` (session) shows your limits and usage. The
platform defaults are 50 packages, 10 GiB of stored assets and 500 MiB per
asset; an administrator can change them per user. Storage counts stored
assets plus multipart uploads in flight, and is checked from the declared
size before any byte is accepted. See
[Quotas](../modules/registry.md#quotas).

Errors a publisher is likely to meet (the full list is in
[`modules/registry.md`](../modules/registry.md#deviations-from-the-plan)):

| Code | Status | Meaning | What to do |
|---|---|---|---|
| `VERSION_EXISTS` | 409 | The version already exists. | `lode-cli publish` continues into it when it is a draft. Otherwise pick a new version. |
| `VERSION_RETIRED` | 409 | A version of that id was published and then deleted, with the version or with a package of the same slug. | Its id stays taken; pick a new version. |
| `VERSION_NOT_DRAFT` | 409 | Upload or publish on a version that is already published or yanked. | Released versions are immutable; release a new version. |
| `VERSION_EMPTY` | 409 | Publish of a draft without assets. | Upload at least one asset. |
| `VERSION_BUSY` | 409 | Another upload, publish or delete holds the version. | Do not run two jobs for one version at once; retry. |
| `VERSION_NOT_PUBLISHED` | 409 | A channel was pointed at a draft or yanked version. | Publish or restore it first. |
| `VERSION_IN_CHANNEL` | 409 | Yank or delete of a version a channel points at. | Move the channel to another version first. |
| `PACKAGE_EXISTS` | 409 | The slug is taken in your namespace. | Choose another slug. |
| `PACKAGE_QUOTA_EXCEEDED` | 409 | You own the maximum number of packages. | Delete a package or ask an administrator for a higher limit. |
| `STORAGE_QUOTA_EXCEEDED` | 409 | The upload would exceed your storage. | Delete old versions or ask for a higher limit. |
| `ASSET_TOO_LARGE` | 413 | The asset is above your asset limit (500 MiB at most). | Split or shrink the asset. |
| `SINGLE_REQUEST_TOO_LARGE` | 413 | More than 95 MiB in a single-request upload. | Use multipart; `lode-cli publish` switches by itself. |
| `LENGTH_REQUIRED` | 411 | An upload without `Content-Length`. | Send the file with a known length (`curl --upload-file`), not a chunked stream. |
| `DIGEST_MISMATCH` | 422 | The bytes received do not match the declared `sha256` and size. | The file changed during the upload or the transfer was cut; run again. |
| `INVALID_SIGNATURE` | 400 | The signature does not verify under one of your active keys. | Register the public key of the seed CI signs with; check the key was not revoked. |
| `SIGNATURE_REQUIRED` | 400 | Unsigned upload to a package with `require_signature`. | Set `LODE_SIGNING_KEY` in CI. |
| `UPLOAD_INCOMPLETE` | 409 | Completion while a part is missing. | Send the missing part, then complete. |
| `UPLOAD_EXPIRED` | 409 | A multipart upload was not completed in time (24 hours by default). | Start again; re-running `lode-cli publish` does. |
| `UPLOAD_UNUSABLE`, `PART_REJECTED` | 409, 422 | The store no longer accepts the parts, or a part did not arrive whole. | Run again. |
| `INVALID_GRANT` | 422 | A grant names a package you cannot manage, or one that does not exist. | Check the `<namespace>/<slug>` spelling. |
| `NAMESPACE_SUSPENDED` | 403 | An administrator suspended your namespace: you are read-only and your tokens are refused. | Contact the registry's administrator. |
| (none) | 403 | The token's grant on the package is too low, or the route is session-only. | Give the token the level in [the table above](#4-tokens-and-grants), or use the web UI. |
| `NOT_FOUND` | 404 | The package does not exist, or it is private and the token has no grant on it. | Check `--package`, and the token's grants. |
| `RATE_LIMITED` | 429 | Too many creations (packages, drafts, tokens, keys) in a short time; the answer carries `Retry-After`. | Wait that long and retry. |

## See also

- [`modules/registry.md`](../modules/registry.md) — the full contract.
- [Operator guide](operator.md) — what to tell the people who install your
  package.
- [`examples/publish/`](../../examples/publish/) — the CI example.
