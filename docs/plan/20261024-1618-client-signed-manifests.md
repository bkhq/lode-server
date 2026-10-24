# 20261024-1618-client-signed-manifests Store publisher-signed manifests as commits

- **status**: completed
- **createdAt**: 2026-10-24 16:18
- **approvedAt**: 2026-10-24 16:40
- **relatedTask**: 20261024-1618-client-signed-manifests

## Context

- Today the registry rebuilds the canonical catalog from its tables; the
  publisher signs it separately (`PUT .../manifest-signature`). Any catalog
  change makes the signature `stale` and the manifest is served unsigned.
- The registry cannot sign (it holds no publisher key, by design).
- lode's native source already works this way: a publisher-built, signed
  `manifest.json` on any HTTP host.

## Proposal (draft, from the 2026-10-24 discussion)

1. Commits: every publish uploads a complete manifest, signed by the client.
   The registry stores it immutably, keyed by its content hash (the commit id);
   no two commits are the same. Each manifest carries `parent` (the commit id
   it was built on), `generation` (the parent's + 1) and `created` (RFC 3339),
   all inside the signed catalog.
2. Head: one head commit per package is served at the manifest URL. A publish
   is accepted only as a fast-forward (`parent` == current head); otherwise
   409, and `lode-cli publish` fetches the new head, re-applies only its own
   change (its version, the channels it moves), re-signs and retries (bounded,
   with jitter). The head only moves forward. Uploading a commit that already
   exists (same content hash) is idempotent: 200 with the existing commit, no
   new row and no 409, so a retried upload is harmless. The manifest is served
   with the commit id as its `ETag`; an unchanged head answers a conditional
   request with 304.
3. Validation on upload: signature by a registered key or the live
   delegation's sub-key; every referenced asset uploaded with the same
   `sha256`; a version already published keeps its asset digests and overrides
   (no rewriting history); schema and name checks.
4. History for clients: the registry parses each commit and exposes its
   `created` date, the channels with their latest versions, the versions it
   adds or drops relative to its parent, and its signing key — in the API and
   the web (a commit list per package).
5. Roll forward, never back: a bad release is fixed by a new commit — a fix
   version, or a channel moved back to a good version — made by `lode-cli`.
   The web has no head move; it keeps an emergency stop that refuses the asset
   download of a version until a new commit drops it.
6. lode (separate change in the lode repository): remember the highest
   `generation` it has accepted (with its commit id) and refuse a manifest with
   a lower one, or the same one with another id — a registry or mirror cannot
   serve an older signed manifest.
7. lode-cli: `publish` uploads the asset(s), fetches the head, adds the
   version, signs and uploads the commit (retrying on 409); new `yank` /
   `channel` commands produce commits.
8. Migration: per package, the current generated catalog becomes the first
   commit once its publisher signs it; until then the package keeps today's
   behaviour.

## Risks

- Changes the publishing flow and the registry's write API; old `lode-cli`
  versions keep the per-asset upload path during migration.

## Scope

Registry API, schema migration, web (commit list, head move), docs; lode-cli
publish changes in the lode repository.

## Annotations

Decisions (2026-10-24): commits keyed by content hash; fast-forward only, with
`lode-cli` rebasing and retrying on conflict; lode refuses an older manifest
(by signed `generation`); a bad release is rolled forward, never rolled back
by moving the head. The same commit is stored and sent once.
