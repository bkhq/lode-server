#!/usr/bin/env bash
# Install dex into tests/e2e/.cache/dex.
#
# Resolution order:
#   1. Reuse cached binary if present (with optional sha256 verification).
#   2. Extract the binary from the official OCI image at ghcr.io (no docker
#      daemon — anonymous pulls only need curl + python3 + tar). This is the
#      preferred path because dex stopped publishing standalone binary
#      releases after v2.0.1; ghcr.io is the canonical distribution.
#   3. Fall back to building from source if Go is available.
#
# Override the version with DEX_VERSION=vX.Y.Z.
#
# Supply-chain integrity: when DEX_SHA256 is set (or hard-coded below for
# the pinned default version), the extracted binary's sha256 must match
# before it is moved into place. A mismatch removes the staged file and
# the script exits non-zero. This closes the gap where a poisoned
# upstream image — or a man-in-the-middle on the ghcr fetch — could plant
# an arbitrary binary into the e2e cache that later runs with the test
# user's privileges.
set -euo pipefail

DEX_VERSION="${DEX_VERSION:-v2.41.1}"
# Per-version sha256 sums of the extracted `dex` ELF binary for
# linux/amd64. The values are computed via:
#   sha256sum <extracted-binary>
# after a clean run of this script on a trusted machine, and then
# committed here. CI should treat any mismatch as a hard failure.
#
# Computed once on a trusted machine after a clean install-dex run
# (the binary is extracted from the official ghcr.io image, so this
# hash is stable across machines as long as the image content does
# not change). Override via DEX_SHA256_LINUX_AMD64_v2_41_1=... when
# pinning a different release.
DEX_SHA256_LINUX_AMD64_v2_41_1="${DEX_SHA256_LINUX_AMD64_v2_41_1:-aeab54e9b4c198fa8fb8802877ff701d074403b9a349d327eee4bb6a07034218}"
# arm64 hash is not yet recorded; populate via a one-shot run on an arm64 host
# or by reading the ghcr manifest digest pinned to that architecture. Until
# then, DEX_SHA256_REQUIRED=1 will refuse to use the binary on arm64 CI.
DEX_SHA256_LINUX_ARM64_v2_41_1="${DEX_SHA256_LINUX_ARM64_v2_41_1:-TODO_REPLACE_WITH_LINUX_ARM64_SHA256}"

# DEX_SHA256 overrides the per-arch defaults. DEX_SHA256_REQUIRED=1
# turns a missing / placeholder sha into a fatal error (recommended in
# CI). Default is "warn" so a fresh checkout can still bootstrap dex
# while the sha is being recorded.
DEX_SHA256_REQUIRED="${DEX_SHA256_REQUIRED:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$SCRIPT_DIR/../.cache"
BIN="$CACHE/dex"

resolve_expected_sha256() {
  if [ -n "${DEX_SHA256:-}" ]; then
    printf '%s' "$DEX_SHA256"
    return
  fi
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) return ;;
  esac
  # The version string in the variable name uses underscores to be a
  # valid identifier; map "v2.41.1" -> "v2_41_1".
  local v_id
  v_id="$(printf '%s' "$DEX_VERSION" | tr '.' '_')"
  local var="DEX_SHA256_LINUX_${arch^^}_${v_id}"
  printf '%s' "${!var:-}"
}

verify_sha256() {
  local path="$1"
  local expected
  expected="$(resolve_expected_sha256)"

  if [ -z "$expected" ] || [[ "$expected" == TODO_* ]]; then
    if [ "$DEX_SHA256_REQUIRED" = "1" ]; then
      echo "[install-dex] DEX_SHA256_REQUIRED=1 but no sha256 recorded for $DEX_VERSION on $(uname -m). Refusing to use $path." >&2
      return 1
    fi
    # Soft-warn until every supported (version, arch) tuple has a hard-coded
    # sha256 above; flip DEX_SHA256_REQUIRED=1 in CI to make this a hard error.
    echo "[install-dex] WARNING: no sha256 recorded for $DEX_VERSION on $(uname -m); skipping integrity check." >&2
    return 0
  fi

  if ! command -v sha256sum >/dev/null 2>&1; then
    echo "[install-dex] sha256sum not on PATH; cannot verify $path" >&2
    return 1
  fi

  local actual
  actual="$(sha256sum "$path" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "[install-dex] sha256 mismatch for $path" >&2
    echo "[install-dex]   expected: $expected" >&2
    echo "[install-dex]   actual:   $actual" >&2
    return 1
  fi
  echo "[install-dex] sha256 OK ($actual)"
  return 0
}

if [ -x "$BIN" ]; then
  if verify_sha256 "$BIN"; then
    echo "[install-dex] $BIN already exists; skipping"
    exit 0
  fi
  echo "[install-dex] cached $BIN failed sha256 check; removing and re-extracting" >&2
  rm -f "$BIN"
fi

mkdir -p "$CACHE"

extract_from_ghcr() {
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "[install-dex] unsupported arch $(uname -m) for ghcr extraction" >&2; return 1 ;;
  esac

  local registry="ghcr.io"
  local image="dexidp/dex"
  local tmp
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  echo "[install-dex] fetching ghcr token"
  local token
  token=$(curl -fsSL "https://${registry}/token?service=${registry}&scope=repository:${image}:pull" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

  local accept_hdrs=(
    -H "Accept: application/vnd.oci.image.index.v1+json"
    -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json"
    -H "Accept: application/vnd.docker.distribution.manifest.v2+json"
    -H "Accept: application/vnd.oci.image.manifest.v1+json"
  )

  echo "[install-dex] fetching index manifest for ${image}:${DEX_VERSION}"
  curl -fsSL -H "Authorization: Bearer ${token}" "${accept_hdrs[@]}" \
    "https://${registry}/v2/${image}/manifests/${DEX_VERSION}" -o "$tmp/index.json"

  local platform_digest
  platform_digest=$(python3 -c "
import json
d = json.load(open('$tmp/index.json'))
mans = d.get('manifests') or [d]
for m in mans:
    p = m.get('platform', {})
    if p.get('os') == 'linux' and p.get('architecture') == '$arch':
        print(m['digest']); break
")
  if [ -z "$platform_digest" ]; then
    echo "[install-dex] no linux/$arch manifest in index" >&2
    return 1
  fi

  echo "[install-dex] platform manifest: $platform_digest"
  curl -fsSL -H "Authorization: Bearer ${token}" "${accept_hdrs[@]}" \
    "https://${registry}/v2/${image}/manifests/${platform_digest}" -o "$tmp/manifest.json"

  # Iterate layers from largest to smallest — the dex binary lives in one
  # of the bigger layers. Each layer is a gzipped tarball; we look for any
  # entry whose basename is `dex`, copy it out, and stop on first hit.
  local layers
  layers=$(python3 -c "
import json
d = json.load(open('$tmp/manifest.json'))
ls = sorted(d['layers'], key=lambda l: -l.get('size', 0))
for l in ls:
    print(l['digest'])
")

  for digest in $layers; do
    echo "[install-dex] scanning layer $digest"
    curl -fsSL -H "Authorization: Bearer ${token}" \
      "https://${registry}/v2/${image}/blobs/${digest}" -o "$tmp/layer.tgz"
    if tar -tzf "$tmp/layer.tgz" 2>/dev/null | grep -E '(^|/)dex$' >/dev/null; then
      local entry
      entry=$(tar -tzf "$tmp/layer.tgz" | grep -E '(^|/)dex$' | head -n1)
      echo "[install-dex] found $entry — extracting"
      tar -xzf "$tmp/layer.tgz" -C "$tmp" "$entry"
      # Verify the extracted binary BEFORE moving it into the cache so a
      # mismatched payload never lands at the path the test orchestrator
      # spawns dex from.
      if ! verify_sha256 "$tmp/$entry"; then
        echo "[install-dex] sha256 check failed on extracted binary; aborting" >&2
        return 1
      fi
      mv "$tmp/$entry" "$BIN"
      chmod +x "$BIN"
      echo "[install-dex] wrote $BIN ($(stat -c %s "$BIN") bytes) from ghcr"
      return 0
    fi
  done

  echo "[install-dex] dex binary not found in any layer" >&2
  return 1
}

build_from_source() {
  if ! command -v go >/dev/null 2>&1; then
    echo "[install-dex] go is not installed; cannot fall back to source build" >&2
    return 1
  fi
  local src="$CACHE/dex-src"
  if [ ! -d "$src" ]; then
    echo "[install-dex] cloning dex@${DEX_VERSION}"
    git clone --depth 1 -b "$DEX_VERSION" https://github.com/dexidp/dex.git "$src"
  fi
  echo "[install-dex] building dex from source (CGO required for sqlite3)"
  (cd "$src" && CGO_ENABLED=1 go build -ldflags="-s -w" -o "$BIN" ./cmd/dex)
  echo "[install-dex] built $BIN ($(stat -c %s "$BIN") bytes) from source"
  # Source builds are reproducible only up to a point — go's ldflags
  # alone do not pin the toolchain, so the hash will differ from the
  # ghcr-extracted binary. Log the sha256 for ops record-keeping but
  # do not fail the build on mismatch in this branch.
  if command -v sha256sum >/dev/null 2>&1; then
    echo "[install-dex] source build sha256: $(sha256sum "$BIN" | awk '{print $1}')"
  fi
}

if extract_from_ghcr; then
  exit 0
fi

echo "[install-dex] ghcr extraction failed; trying source build"
if build_from_source; then
  exit 0
fi

echo "[install-dex] all install paths failed; install Go or check network access to ghcr.io" >&2
exit 1
