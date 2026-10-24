#!/usr/bin/env bash
# Sign the packaged lode asset with the key in LODE_SIGNING_KEY, producing
# dist/<asset>.sig — the sidecar lode verifies against `trusted_keys`.
#
# lode-cli ships inside the bkhq/lode image (the same one the Dockerfile
# copies /usr/bin/lode from); pull it the same way rather than installing
# a toolchain on the runner.
#
# Inputs (env): ASSET_NAME, RELEASE_VERSION, LODE_SIGNING_KEY.
set -euo pipefail

: "${ASSET_NAME:?ASSET_NAME is required}"
: "${RELEASE_VERSION:?RELEASE_VERSION is required}"
: "${LODE_SIGNING_KEY:?LODE_SIGNING_KEY is required}"

LODE_IMAGE="${LODE_IMAGE:-docker.io/bkhq/lode:latest}"
cid="$(docker create "$LODE_IMAGE")"
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker cp "$cid:/usr/bin/lode" ./lode-cli
chmod +x ./lode-cli

./lode-cli sign "dist/${ASSET_NAME}" --version "${RELEASE_VERSION}" --key-env LODE_SIGNING_KEY
test -s "dist/${ASSET_NAME}.sig"
echo "signed dist/${ASSET_NAME} -> dist/${ASSET_NAME}.sig"
