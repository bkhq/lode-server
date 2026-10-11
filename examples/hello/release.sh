#!/usr/bin/env bash
# Build the example and publish it with `lode-cli publish` — what a pipeline
# does on a release, runnable by hand against any registry.
#
# Usage: ./release.sh <version> [channel]
#
# Reads .env.local next to this script when it exists (see README.md):
#   LODE_REGISTRY_TOKEN  required, a token with a write grant on the package
#   LODE_PACKAGE         required, <namespace>/<slug>
#   LODE_REGISTRY_URL    optional, defaults to the hosted registry
#   LODE_SIGNING_KEY     optional, the seed from `lode-cli keygen`
#
# Needs `lode-cli` on PATH (see README.md).
set -euo pipefail

version="${1:?usage: release.sh <version> [channel]}"
channel="${2:-stable}"
here="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$here/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$here/.env.local"
  set +a
fi

: "${LODE_REGISTRY_TOKEN:?set LODE_REGISTRY_TOKEN (see README.md)}"
: "${LODE_PACKAGE:?set LODE_PACKAGE to <namespace>/<slug> (see README.md)}"

"$here/build.sh" "$version"

command -v lode-cli >/dev/null 2>&1 || {
  echo "release: lode-cli was not found on PATH (see README.md)" >&2
  exit 1
}

args=(--package "$LODE_PACKAGE" --version "$version" --channel "$channel")
[ -z "${LODE_REGISTRY_URL:-}" ] || args+=(--registry "$LODE_REGISTRY_URL")
[ -z "${LODE_SIGNING_KEY:-}" ] || args+=(--key-env LODE_SIGNING_KEY)
exec lode-cli publish "${args[@]}" "$here/dist/hello-linux-x64.tar.gz"
