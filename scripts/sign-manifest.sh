#!/usr/bin/env bash
# Sign the manifest of one package on a lode registry: download the manifest
# the registry generates, sign it with `lode-cli manifest-sign`, and send the
# signature back. The registry then serves the manifest signed, which is what
# a host with `[trust].require_manifest = "signed"` or `"fresh"` needs.
#
# Run it after every release step (publish, channel move, yank, restore) —
# each one changes the manifest and drops the signature — and on a schedule
# shorter than --expires-in, so the expiry never lapses.
#
# Usage:
#   LODE_REGISTRY_TOKEN=pat_... LODE_SIGNING_KEY=<seed> scripts/sign-manifest.sh \
#     --package <namespace>/<slug> [--registry <url>] [--expires-in <duration>] \
#     [--expect <channel>=<version>]...
#
#   --registry    Base URL of the registry, including a base path when it has
#                 one. Default: https://lode.bk.io/u (the API is under /u).
#                 The manifest is read from /r at the same origin.
#   --package     The package, as <namespace>/<slug>.
#   --expires-in  How long the signed manifest stays valid: a number with a
#                 unit m, h or d (default: 30d). Hosts refuse the manifest
#                 once it passes. `none` signs without an expiry, which
#                 satisfies `signed` but not `fresh`.
#   --expect      What a channel must point at, once per channel. Required
#                 whenever the manifest is not the one this key signed last:
#                 after a publish, a channel move, a yank or a restore. The
#                 manifest is signed only when its channels are exactly the
#                 expected ones. A manifest that still carries this key's
#                 signature is renewed without it.
#
# Environment:
#   LODE_REGISTRY_TOKEN  Required. A personal token with a `write` grant on
#                        the package.
#   LODE_SIGNING_KEY     Required. The key seed from `lode-cli keygen`. Its
#                        public half must be registered for the package,
#                        which `lode-cli publish --key-env` does, or be the
#                        sub-key of the package's live delegation.
#
# The registry generates the manifest, so the script never signs a change it
# was not told about: a scheduled run renews an unchanged manifest, and
# anything else needs --expect. A signature vouches for every version and
# channel in the manifest; --expect checks the channel pointers only.
#
# Requires: bash, curl, jq, and lode-cli on PATH.

# Never trace: `bash -x` would print the Authorization header and the key.
{ set +x; } 2>/dev/null
set -euo pipefail

die() {
  echo "sign-manifest: $*" >&2
  exit 1
}

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

registry="https://lode.bk.io/u" package="" expires_in="30d"
expect=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --registry | --package | --expires-in | --expect)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --registry) registry="$2" ;;
        --package) package="$2" ;;
        --expires-in) expires_in="$2" ;;
        --expect) expect+=("$2") ;;
      esac
      shift 2
      ;;
    # Only the option name is echoed: what follows it may be a secret.
    *) die "unknown argument ${1%%=*} (see --help)" ;;
  esac
done

[[ "$registry" =~ ^https?://[^/]+ ]] || die "--registry must be an http(s) URL"
origin="${BASH_REMATCH[0]}"
[[ "$package" =~ ^[a-z][a-z0-9]*/[a-z0-9][a-z0-9-]*$ ]] || die "--package must be <namespace>/<slug>"
[[ "$expires_in" =~ ^([0-9]+[mhd]|none)$ ]] || die "--expires-in is a number with a unit m, h or d, or none"
expected="{}"
for pair in ${expect[@]+"${expect[@]}"}; do
  [[ "$pair" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*=[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || die "--expect is <channel>=<version>"
  expected="$(jq -cn --argjson all "$expected" --arg channel "${pair%%=*}" --arg version "${pair#*=}" '$all + {($channel): $version}')"
done
for tool in curl jq lode-cli; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but was not found on PATH"
done
[ -n "${LODE_REGISTRY_TOKEN:-}" ] || die "LODE_REGISTRY_TOKEN is not set"
# The token is handed to curl in a config line, so it has to be plain.
[[ "$LODE_REGISTRY_TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || die "LODE_REGISTRY_TOKEN contains characters a token never has"
[ -n "${LODE_SIGNING_KEY:-}" ] || die "LODE_SIGNING_KEY is not set"

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# The token and the key only ever sit in files of this private directory.
printf 'header = "Authorization: Bearer %s"\n' "$LODE_REGISTRY_TOKEN" >"$tmp/curl.conf"
printf '%s\n' "$LODE_SIGNING_KEY" >"$tmp/key"

sign_args=(--into "$tmp/manifest.json" --key "$tmp/key")
[ "$expires_in" = none ] || sign_args+=(--expires-in "$expires_in")

# Two attempts: a release step between the download and the upload changes
# the manifest, and the registry answers 409.
for attempt in 1 2; do
  curl --silent --show-error --fail --config "$tmp/curl.conf" --output "$tmp/manifest.json" \
    "$origin/r/$package/manifest.json" || die "could not download the manifest of $package"
  channels="$(jq -cS '.channels | map_values(.latest)' "$tmp/manifest.json")"
  echo "sign-manifest: $package channels: $channels, $(jq '.versions | length' "$tmp/manifest.json") version(s)"
  served="$(jq -r '"\(.key_id // "") \(.sig // "")"' "$tmp/manifest.json")"
  lode-cli manifest-sign "${sign_args[@]}" >/dev/null || die "lode-cli manifest-sign failed"
  # An ed25519 signature is deterministic: the same `sig` under this key
  # means the catalog is the one signed last time.
  if [ "$served" != "$(jq -r '"\(.key_id) \(.sig)"' "$tmp/manifest.json")" ]; then
    [ "${#expect[@]}" -gt 0 ] || die "the manifest is not the one this key signed last; check its channels and pass --expect <channel>=<version> for each"
    [ "$channels" = "$(jq -cS . <<<"$expected")" ] || die "the manifest's channels are $channels, expected $(jq -cS . <<<"$expected"); not signing"
  fi
  jq '{key_id, sig} + (if .expires then {expires, expires_sig} else {} end)' "$tmp/manifest.json" >"$tmp/signature.json"

  status="$(curl --silent --show-error --config "$tmp/curl.conf" --request PUT \
    --header 'Content-Type: application/json' --data-binary "@$tmp/signature.json" \
    --output "$tmp/response.json" --write-out '%{http_code}' \
    "${registry%/}/api/registry/packages/$package/manifest-signature")"
  case "$status" in
    200)
      echo "sign-manifest: signed with key $(jq -r '.data.key_id' "$tmp/response.json"), expires $(jq -r '.data.expires // "never"' "$tmp/response.json")"
      exit 0
      ;;
    409) [ "$attempt" = 1 ] && continue ;;
  esac
  die "the registry refused the signature: HTTP $status $(jq -r '.error.code + ": " + .error.message' "$tmp/response.json" 2>/dev/null || true)"
done
