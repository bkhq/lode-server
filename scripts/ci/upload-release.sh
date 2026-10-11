#!/usr/bin/env bash
# Upload the lode release artifacts (tarball + manifest + checksums) to the
# existing GitHub release. Verifies the release exists first.
#
# Inputs (env): TAG_NAME, ASSET_NAME, GH_TOKEN.
set -euo pipefail

gh release view "${TAG_NAME:?TAG_NAME is required}" >/dev/null
# The .sig sidecar exists only when the release was signed (see
# sign-release.sh); upload it when present so lode can verify.
sig=()
[ -s "dist/${ASSET_NAME:?ASSET_NAME is required}.sig" ] && sig=("dist/${ASSET_NAME}.sig")
gh release upload "${TAG_NAME}" \
  "dist/${ASSET_NAME}" \
  dist/manifest.json \
  dist/checksums.txt \
  "${sig[@]}" \
  --clobber
