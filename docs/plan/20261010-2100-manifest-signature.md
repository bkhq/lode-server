# 20261010-2100-manifest-signature Serve a publisher-signed manifest

- **status**: completed
- **createdAt**: 2026-10-10 21:00
- **approvedAt**: 2026-10-10 21:00
- **relatedTask**: 20261010-2100-manifest-signature

## Context

lode v0.0.5 adds two optional top-level manifest fields, `expires` and
`expires_sig`, next to the existing `key_id` / `sig`, and a host option
`[trust].require_manifest = off | signed | fresh`. The outline, the signed
bytes and the test list are in
[`develop/lode-compatibility.md`](../develop/lode-compatibility.md#manifest-expiry).

Constraint: the registry must not hold a publisher's private key, because
every trusted key can sign assets too. The signature comes from the
publisher, over the manifest the registry generates.

## Proposal

1. `signature.ts`: `canonicalCatalog`, `manifestMessage`,
   `manifestExpiryMessage`, byte-compatible with lode, pinned by vectors from
   `lode-cli manifest-sign` v0.0.5.
2. Table `registry_manifest_signatures` (one row per package, cascade),
   migration `0001_manifest_signatures`, included in the registry backup.
3. `manifest-signature.service.ts`: verify-then-store, and
   `withManifestSignature`, which attaches the stored fields only while the
   signature is live.
4. Routes on the package: `GET` (read), `PUT` and `DELETE` (write, in the
   `packages:write` token scope) `/manifest-signature`; audit entries.
5. Console: state of the signature in the package's Install tab.
6. Publisher tooling: `scripts/sign-manifest.sh`,
   `examples/publish/sign-manifest.yml`.
7. Docs: module, publisher and operator guides, `llms.txt`, API and database
   reference.

## Decisions

- **A lapsed expiry is dropped, not served.** lode enforces `expires`
  whenever it is present, under every policy; a lapsed one in the manifest
  would stop every host. Unsigned stops only hosts that asked for `fresh`.
- **Stale means unsigned.** Any catalog change makes the stored signature
  unverifiable; lode rejects a failing signature but accepts none under the
  default policy.
- **One refusal for a failed verification** (409 `MANIFEST_CHANGED`): a wrong
  signature and a changed manifest are indistinguishable, and the remedy is
  the same.
- **The generated `lode.toml` never contains `require_manifest`**: lode
  v0.0.4 and older refuse to start on the unknown key.
- **Pins move to `bkhq/lode:v0.0.5`** in the e2e tests and
  `examples/publish/`, for `manifest-sign` and the new option.

## Risks

- Between a release step and the next signature the manifest is unsigned.
  Documented; the CI example signs after each publish and weekly.
- `REGISTRY_MANIFEST_MAX_VERSIONS` is part of what gets signed; changing it
  makes every signature stale.
- lode v0.0.5 does not apply `require_manifest` in its background update
  check. Outside this repository.

## Tasks

- [x] Primitives and vectors
- [x] Table, migration, backup
- [x] Service, routes, token scope, audit
- [x] Feed integration
- [x] Console state
- [x] Script and CI example
- [x] Docs
- [x] `bun run check`, `bun run test:e2e`
