# 20261016-0224-delegated-signing Delegated signing keys and revocation lists

- **status**: completed
- **createdAt**: 2026-10-16 02:24
- **approvedAt**: 2026-10-16 02:24
- **relatedTask**: 20261016-0224-delegated-signing

## Context

lode 0.1.0 (`bkhq/lode` 7f387b4) adds delegated signing:

- A root key (in the host's `trusted_keys`) signs a delegation
  `{key, name, not_before, not_after, issuer?, sig}` over
  `lode.delegation.v1\n{name}\n{alg}\n{sub_key_b64url}\n{not_before}\n{not_after}`.
  The sub-key may then sign the catalog, its expiry and the assets of the
  manifest `name` during `[not_before, not_after)`.
- The delegation travels as the manifest's top-level `delegation`. It is not
  part of any signed message; `lode.manifest.v1`, `lode.manifest-expiry.v1`
  and `lode.artifact.v2` are unchanged. One delegation per manifest.
- `[trust].revocation_url` points at a list
  `{schema: "lode-revocations/v1", issued_at, revoked[], key_id?, delegation?, sig}`
  signed over `lode.revocations.v1\n{key_id}\n{issued_at}` plus each sorted,
  deduplicated id on its own line, by a root or by a sub-key with a valid
  delegation for `[global].app`. Hosts merge verified lists grow-only, ignore
  an `issued_at` not newer than the cached one, and never fail an update on
  the list. A revoked sub-key stops verifying.
- Hosts on 0.0.3 or older reject sub-key signatures.
- `lode-cli publish --key-env` registers the signing key with
  `POST /keys` and treats 409 `KEY_EXISTS` as success.

Today the registry checks every signature against the package's active
registered keys only (`release.service.ts` `verifyUnderPackageKeys`,
`upload.service.ts` `isActiveKey`, `manifest-signature.service.ts`
`activeKey`), serves no delegation, and the console's `lode.toml` pins the
asset's signing key in `trusted_keys`. A sub-key signature is refused, and
even a registered sub-key would end up as a host's trust root.

## Proposal

Registered keys are the package's roots. A delegation adds one sub-key.

1. **Primitives** (`signature.ts`): `delegationMessage`, `revocationMessage`,
   a trusted-key entry parser (ed25519 only), pinned by vectors from
   `lode-cli delegate` / `revoke` 0.1.0 in `testdata/`.
2. **Tables** (migration `0003_delegation`, in the registry backup):
   - `registry_delegations`, one row per package: the delegation as uploaded,
     the sub-key id and raw key, and `root_key_id`, the registered key that
     verified it.
   - `registry_revocation_lists`, one row per package: the list as uploaded.
3. **Signing keys** (`signing-keys.service.ts`): the package's active
   registered keys plus the delegation's sub-key while the delegation is
   live — inside its window, its root still active, the sub-key not in the
   package's revocation list. Every signature check uses it: single and
   multipart uploads (including the re-check at completion), the manifest
   signature, its status and the feed.
4. **Delegation routes** `GET`/`PUT`/`DELETE /packages/:ns/:pkg/delegation`.
   `PUT` takes the JSON `lode-cli delegate` prints and refuses: a `name` other
   than the slug, a non-ed25519 sub-key, a signature no active registered key
   makes, a lapsed `not_after`, a sub-key in the revocation list, and a
   sub-key that is or was a registered key of the package (409
   `KEY_REGISTERED`: a root is not a sub-key). `GET` reports `live`,
   `pending`, `expired` or `revoked`.
5. **Revocation routes**: `GET`/`PUT /packages/:ns/:pkg/revocations` and the
   feed `GET /r/:ns/:pkg/revocations.json`. `PUT` verifies as lode does
   (roots = active registered keys, `name` = slug, the list's own
   delegation), and refuses an `issued_at` not newer than the stored one
   (409 `REVOCATIONS_OUTDATED`) and a list that drops a stored id (400
   `REVOCATIONS_SHRINK`). No `DELETE`: hosts never un-revoke.
6. **Feed**: the manifest carries `delegation` while it is live.
7. **Asset re-sign**: `PUT /packages/:ns/:pkg/versions/:ver/assets/:asset/signature`
   `{sig}` replaces an asset's signature in any version state, verified like an
   upload over the stored digest and overrides. The catalog does not cover
   `sig`, so a manifest signature stays live.
8. **Key registration**: `POST /keys` with the live delegation's sub-key
   answers 409 `KEY_EXISTS`, so `lode-cli publish --key-env <sub-key>` goes on
   without making the sub-key a root.
9. **Token scope**: the three `PUT`/`DELETE` routes join `packages:write`.
   Audit entries for each mutation.
10. **Console**: the Install tab shows the delegation and the revocation
    list. The generated `lode.toml` pins the delegation's root when the asset
    is signed by the sub-key, and adds `revocation_url` when the package has
    a list (both need lode 0.1.0, which delegated hosts need anyway).
11. **Tooling and pins**: `sign-manifest.sh` works unchanged with a sub-key
    (it posts `key_id`/`sig` only); docs show the delegation flow. lode pins
    move to `v0.1.0-mini`; the delegated-signing e2e case skips on a client
    older than 0.1.0.
12. **Docs**: registry module, publisher and operator guides, `llms.txt`,
    API and database reference, changelog.

## Decisions

- **Delegation lifecycle on the server mirrors lode**: a delegation outside
  its window, with a revoked root or a revoked sub-key is not served and
  verifies nothing here.
- **Revocation list ids are 16 lowercase hex characters** (lode key ids), at
  most 1000; lode itself accepts any string.
- **Rotation**: renew the delegation for the same sub-key. A new sub-key
  needs the old assets re-signed through item 7 for older versions to stay
  installable under `enforce`.

## Risks

- A write token can replace the delegation, as it can register a key today;
  a delegation still has to be signed by a registered root.
- Assets signed by an expired or revoked sub-key fail on `enforce` hosts
  until re-signed. Documented.

## Tasks

- [x] Primitives and vectors
- [x] Tables, migration, backup
- [x] Signing keys service; uploads, manifest signature, feed use it
- [x] Delegation routes
- [x] Revocation routes and feed
- [x] Asset re-sign route
- [x] Key registration guard, token scope, audit
- [x] Console and `lode.toml`
- [x] Pins, e2e with lode 0.1.0
- [x] Docs
- [x] `bun run check`, `bun run test:e2e`
