# 20261011-1443-artifact-signature-v2 Verify lode's app-bound asset signature

- **status**: completed
- **createdAt**: 2026-10-11 14:43
- **approvedAt**: 2026-10-11 14:43
- **relatedTask**: 20261011-1443-artifact-signature-v2

## Context

`artifactMessage` (`modules/registry/signature.ts`) builds
`lode.artifact.v1\n{name}\n{version}\n{sha256}\n{run}\n{exec}`, the bytes
`lode-cli sign` signs and a host verifies. Nothing in them names the package.
A token with a `write` grant on one package can register a key there and
upload an asset that key signed for another package; hosts pinning the key
under `enforce` install it. lode replaces the message with
`lode.artifact.v2\n{app}\n{name}\n…`, `app` being the manifest `name`.

## Proposal

- `artifactMessage` takes `app` and emits the v2 bytes;
  `verifyUnderPackageKeys` passes the package slug. No v1 fallback.
- Test vectors regenerated with the new `lode-cli`, signed for the app
  `tool`; the tests that upload them use a package of that slug.
- `scripts/publish.sh` and `scripts/ci/sign-release.sh` pass `--app`.
- The lode pin of the e2e tests, CI and `examples/publish/` moves to
  `bkhq/lode:v0.0.7`, the release that is to carry the change.
- Docs: module doc, compatibility guide, publisher and operator guides,
  `llms.txt`, vector provenance.

## Risks

- Every signature stored today stops verifying on hosts; the owner accepts
  publishing again.
- CI's real-client suites fail until `bkhq/lode:v0.0.7` exists.
- Hosts and publishers on lode 0.0.6 or older cannot use signed packages.

## Scope

Registry signature code and tests, test vectors, two scripts, e2e helpers and
pins, CI, examples, docs.

## Alternatives

- Carry both messages for a transition: rejected by the owner; a host that
  still accepts the old message gains nothing.

## Annotations

(none)
