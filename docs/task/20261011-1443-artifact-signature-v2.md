# 20261011-1443-artifact-signature-v2 Verify lode's app-bound asset signature

- **status**: completed
- **priority**: P1
- **owner**: agent/audit-fixes-20261011
- **createdAt**: 2026-10-11 14:43

## Description

Finding 2 of the 2026-10-11 audit: the signed asset message did not name the
package, so an asset signed for one package verified in any other that
trusted the same key. lode changes the message to `lode.artifact.v2`, which
carries the app name; the registry follows, with the package slug as the app.

Plan: [20261011-1443-artifact-signature-v2](../plan/20261011-1443-artifact-signature-v2.md).

Acceptance: an upload whose signature was made for another package is a 400
`INVALID_SIGNATURE` even when both packages trust the key; signatures from
the new `lode-cli` verify; the real-client e2e scenarios pass with a lode
built from the change.

## ActiveForm

Verifying app-bound asset signatures

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- 2026-10-11 14:43: the owner chose a direct switch with no fallback to the old message; existing signed assets are published again and lode is updated by hand.

- complete: Unit suite 1070 pass; e2e 113 pass / 7 pre-existing skips with E2E_LODE_BIN set to a lode built from the v2 change; lint and typecheck clean. Workers smoke not run.
- 2026-10-11: after lode's version reset the pins moved from v0.0.7 to `bkhq/lode:v0.0.1`, and the lode compatibility guide, the older-lode e2e scenario and the "lode 0.0.x or newer" qualifiers were removed.
