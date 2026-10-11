#!/usr/bin/env bash
# Resolve lode release metadata from the release tag and export it to
# $GITHUB_ENV for later workflow steps.
#
# Inputs (env): RELEASE_TAG, APP_NAME, ASSET_SUFFIX, GITHUB_REPOSITORY, GITHUB_ENV.
set -euo pipefail

tag="${RELEASE_TAG:?RELEASE_TAG is required}"
version="${tag#v}"
asset="${APP_NAME:?APP_NAME is required}-${ASSET_SUFFIX:?ASSET_SUFFIX is required}.tar.gz"
url="https://github.com/${GITHUB_REPOSITORY:?}/releases/download/${tag}/${asset}"

{
  echo "TAG_NAME=${tag}"
  echo "RELEASE_VERSION=${version}"
  echo "ASSET_NAME=${asset}"
  echo "ASSET_URL=${url}"
} >> "${GITHUB_ENV:?GITHUB_ENV is required}"

echo "Resolved release: tag=${tag} version=${version} asset=${asset}"
