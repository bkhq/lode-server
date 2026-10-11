#!/usr/bin/env bash
# Build the release asset of the example: dist/hello-linux-x64.tar.gz, holding
# app.sh and a VERSION file.
#
# Usage: ./build.sh <version>
set -euo pipefail

version="${1:?usage: build.sh <version>}"
here="$(cd "$(dirname "$0")" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

cp "$here/app.sh" "$stage/app.sh"
chmod +x "$stage/app.sh"
printf '%s\n' "$version" >"$stage/VERSION"

mkdir -p "$here/dist"
tar -czf "$here/dist/hello-linux-x64.tar.gz" -C "$stage" app.sh VERSION
echo "build: dist/hello-linux-x64.tar.gz ($version)"
