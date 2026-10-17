# 20261016-0224-delegated-signing Support lode 0.1.0 delegated signing and revocation lists

- **status**: completed
- **priority**: P1
- **owner**: agent/delegated-signing-20261016
- **createdAt**: 2026-10-16 02:24

## Description

lode 0.1.0 lets an offline root key delegate signing to a short-lived
sub-key, carried as the manifest's top-level `delegation`, and lets hosts
subscribe to a signed revocation list (`[trust].revocation_url`). Make the
registry store and serve both, accept sub-key signatures wherever it checks
a signature, and let a publisher replace the signature of an existing asset
after a sub-key rotation.

Plan: [20261016-0224-delegated-signing](../plan/20261016-0224-delegated-signing.md).

Acceptance: a host on lode 0.1.0 that trusts only the root key installs a
release published and manifest-signed with a delegated sub-key; after the
sub-key is revoked through the hosted list, that host refuses it; an asset
re-signed under a new sub-key installs again; `bun run check` and the e2e
suites pass.

## ActiveForm

Adding delegated signing support

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- 2026-10-16 02:24: the owner approved the direction, asked for the
  revocation list in this task and for an asset re-sign endpoint.

- complete: bun run check passes (api 341 registry-module tests incl. delegation.test.ts, web snippet tests); e2e 114 pass / 7 skips (cron and rotate-dek, as before), the new delegated-signing real-client case passes against lode 0.1.0 (E2E_LODE_BIN, release binary; docker.io/bkhq/lode:v0.1.0-mini is not published yet, so CI's docker pull fails until it is).
- 2026-10-16: on the owner's request the lode pins went back to `v0.0.3-mini` (no v0.1.0 image); the delegated-signing e2e case now skips on a client older than 0.1.0.
- 2026-10-17: `docker.io/bkhq/lode:v0.1.0-mini` is published; the pins moved to it.
