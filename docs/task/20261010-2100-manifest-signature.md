# 20261010-2100-manifest-signature Serve a publisher-signed manifest

- **status**: completed
- **priority**: P1
- **owner**: agent/manifest-signature
- **createdAt**: 2026-10-10 21:00

## Description

lode v0.0.5 lets a host require a signed manifest and a signed, unexpired
expiry (`[trust].require_manifest`). The registry generates the manifest and
holds no private key, so until now no registry package could satisfy that
option. Accept the publisher's signature over the generated manifest, serve
it while it is valid, and show its state.

Requirement: [`develop/lode-compatibility.md`](../develop/lode-compatibility.md#manifest-expiry).
Plan: [20261010-2100-manifest-signature](../plan/20261010-2100-manifest-signature.md).

Acceptance: a real lode v0.0.5 host on `require_manifest = "fresh"` installs
from a package signed with `scripts/sign-manifest.sh`, and refuses the same
package while its manifest is unsigned; lode v0.0.4 installs from the signed
manifest.

## ActiveForm

Serving a publisher-signed manifest

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- 2026-10-10: the owner asked for the requirement to be completed; implemented in one pass without a separate approval round.
- 2026-10-10: found that lode v0.0.5 applies `require_manifest` on bootstrap and `lode-cli update` but not in the supervisor's background update check. Recorded in the compatibility guide; the e2e scenario asserts on bootstrap. A lode-side fix is outside this repository.
- complete: table, routes, feed, console state, `scripts/sign-manifest.sh`, CI example, docs; unit and e2e green.
