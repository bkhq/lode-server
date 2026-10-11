#!/usr/bin/env bash
# Publish one release of one package to a lode registry: create a draft
# version, upload every asset into it, then publish the version to a channel.
# Written for CI; see examples/publish/ for a GitHub Actions workflow.
#
# Usage:
#   LODE_REGISTRY_TOKEN=pat_... scripts/publish.sh \
#     --package <namespace>/<slug> --version <version> \
#     [--registry <url>] [--channel <name>] [--notes <text>] <file>...
#
#   --registry  Base URL of the registry, including a base path when it has
#               one. Default: https://lode.bk.io/u (the API is under /u).
#   --package   The package, as <namespace>/<slug>.
#   --version   The version to release, e.g. 1.4.2.
#   --channel   The channel that will point at the version (default: stable).
#   --notes     Release notes, stored when the draft is created.
#   <file>...   The assets. Each is stored under its file name, which is what
#               an operator's `[update].asset` selects.
#
# Environment:
#   LODE_REGISTRY_TOKEN  Required. A personal token with a `write` grant on
#                        the package. Read from the environment only; there
#                        is no option for it.
#   LODE_SIGNING_KEY     Optional. The key seed from `lode-cli keygen`. When
#                        set, every asset is signed with `lode-cli sign`
#                        (which must be on PATH), for the package slug as
#                        the app, and the signature is sent with the upload. Without it assets go up unsigned.
#                        The public half is derived from the seed (needs
#                        openssl) and registered for the package first, so
#                        no key has to be registered by hand.
#
# Assets up to 95 MiB are sent in one request; larger ones, up to 500 MiB,
# as a multipart upload in the part size the registry dictates.
#
# Re-running a failed job is safe: when the draft already exists the script
# continues into it and an asset uploaded again replaces the one of the same
# name. The notes of an existing draft are kept. A version that is already
# published is immutable, and releasing it again fails.
#
# Per-asset `run` / `exec` overrides are not supported.
#
# Requires: bash, curl, jq, sha256sum or shasum, dd, wc, awk; lode-cli and
# openssl when signing.

# Never trace: `bash -x` would print the Authorization header.
{ set +x; } 2>/dev/null
set -euo pipefail

SINGLE_REQUEST_MAX=99614720 # 95 MiB
ASSET_MAX=524288000         # 500 MiB
RE_NAME='^[A-Za-z0-9_][A-Za-z0-9._-]*$'

die() {
  echo "publish: $*" >&2
  exit 1
}

usage() {
  # The header comment above, without the shebang and the leading "# ".
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

registry="https://lode.bk.io/u" package="" version="" channel="stable" notes=""
files=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --registry | --package | --version | --channel | --notes)
      [ $# -ge 2 ] || die "$1 needs a value"
      case "$1" in
        --registry) registry="$2" ;;
        --package) package="$2" ;;
        --version) version="$2" ;;
        --channel) channel="$2" ;;
        --notes) notes="$2" ;;
      esac
      shift 2
      ;;
    --)
      shift
      files+=("$@")
      break
      ;;
    # Only the option name is echoed: what follows it may be a secret.
    -*) die "unknown option ${1%%=*} (see --help)" ;;
    *)
      files+=("$1")
      shift
      ;;
  esac
done

[ -n "$registry" ] || die "--registry must not be empty (see --help)"
[ -n "$package" ] || die "--package is required (see --help)"
[ -n "$version" ] || die "--version is required (see --help)"
[ "${#files[@]}" -gt 0 ] || die "no asset files given (see --help)"
[[ "$package" =~ ^[a-z][a-z0-9]*/[a-z0-9][a-z0-9-]*$ ]] || die "--package must be <namespace>/<slug>"
[[ "$version" =~ $RE_NAME ]] || die "--version may only contain A-Z a-z 0-9 . _ - and must not start with . or -"
[[ "$channel" =~ $RE_NAME ]] || die "--channel may only contain A-Z a-z 0-9 . _ - and must not start with . or -"

for tool in curl jq dd wc awk; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but was not found on PATH"
done
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "sha256sum or shasum is required but neither was found on PATH"
fi

[ -n "${LODE_REGISTRY_TOKEN:-}" ] || die "LODE_REGISTRY_TOKEN is not set"
# The token is handed to curl in a config line, so it has to be plain.
[[ "$LODE_REGISTRY_TOKEN" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || die "LODE_REGISTRY_TOKEN contains characters a token never has"
if [ -n "${LODE_SIGNING_KEY:-}" ]; then
  command -v lode-cli >/dev/null 2>&1 || die "LODE_SIGNING_KEY is set but lode-cli was not found on PATH; refusing to upload unsigned"
fi

# Everything about the files is checked before the first request.
size_of() { wc -c <"$1" | tr -d '[:space:]'; }
names=" "
for file in "${files[@]}"; do
  [ -f "$file" ] || die "not a file: $file"
  [ -r "$file" ] || die "not readable: $file"
  name="$(basename "$file")"
  [[ "$name" =~ $RE_NAME ]] || die "asset name \"$name\" may only contain A-Z a-z 0-9 . _ - and must not start with . or -"
  case "$names" in *" $name "*) die "asset name \"$name\" is given twice" ;; esac
  names="$names$name "
  size="$(size_of "$file")"
  [ "$size" -gt 0 ] || die "$name is empty"
  [ "$size" -le "$ASSET_MAX" ] || die "$name is $size bytes; the registry takes at most $ASSET_MAX (500 MiB) per asset"
done

api="${registry%/}/api/registry"
version_url="$api/packages/$package/versions/$version"
tmp="$(mktemp -d)"
upload_id=""

# Send one request with the token. The status lands in $status, the body in
# $tmp/response. The token reaches curl on stdin, as a config line: it is in
# no argument list and in no file.
request() {
  local method="$1" url="$2"
  shift 2
  status="$(printf 'header = "Authorization: Bearer %s"\n' "$LODE_REGISTRY_TOKEN" \
    | curl -q --config - --silent --show-error --request "$method" \
      --output "$tmp/response" --write-out '%{http_code}' "$@" "$url")" \
    || die "$method $url: no answer from the registry"
}

# Stop with the HTTP status and the API's error code and message.
refused() {
  local code message
  code="$(jq -r '.error.code // empty' "$tmp/response" 2>/dev/null || true)"
  message="$(jq -r '.error.message // empty' "$tmp/response" 2>/dev/null || true)"
  die "$1: HTTP $status${code:+ $code}${message:+: $message}"
}

ok() { [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; }

post_json() {
  local url="$1"
  printf '%s' "$2" >"$tmp/request.json"
  request POST "$url" --header 'Content-Type: application/json' --data-binary "@$tmp/request.json"
}

# `--upload-file` streams the file and sends its size as Content-Length.
put_file() {
  request PUT "$1" --header 'Content-Type: application/octet-stream' --header 'Expect:' --upload-file "$2"
}

cleanup() {
  # An upload still open at exit was interrupted: give it up, best effort.
  if [ -n "$upload_id" ]; then
    (request DELETE "$api/uploads/$upload_id") >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

urlencode() { jq -rn --arg value "$1" '$value | @uri'; }

# The public half of an ed25519 seed, as unpadded base64url. The seed goes
# through a pipe only: PKCS#8 header, the 32 seed bytes, then openssl.
public_key_of_seed() {
  local b64
  b64="$(printf '%s' "$1" | tr -- '-_' '+/')"
  while [ $((${#b64} % 4)) -ne 0 ]; do b64="$b64="; done
  {
    printf '\x30\x2e\x02\x01\x00\x30\x05\x06\x03\x2b\x65\x70\x04\x22\x04\x20'
    printf '%s' "$b64" | openssl base64 -d -A
  } | openssl pkey -inform DER -pubout -outform DER 2>/dev/null | tail -c 32 | openssl base64 -A | tr -- '+/' '-_' | tr -d '='
}

# Register the public key the signatures will be checked against. A second
# run finds it registered already, which is fine.
if [ -n "${LODE_SIGNING_KEY:-}" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "publish: openssl not found, not registering the signing key; it has to be registered for the package already"
  else
    public_key="$(public_key_of_seed "$LODE_SIGNING_KEY")" || public_key=""
    [ "${#public_key}" -eq 43 ] || die "LODE_SIGNING_KEY is not an ed25519 seed from lode-cli keygen"
    post_json "$api/packages/$package/keys" "$(jq -n --arg key "$public_key" --arg name "ci" '{public_key: $key, name: $name}')"
    if ok; then
      echo "publish: registered signing key $(jq -r '.data.key_id' "$tmp/response")"
    elif [ "$status" = 409 ] && [ "$(jq -r '.error.code // empty' "$tmp/response" 2>/dev/null)" = "KEY_EXISTS" ]; then
      echo "publish: signing key already registered"
    else
      refused "registering the signing key"
    fi
  fi
fi

# Prints the signature of an asset, or nothing when no key is configured.
# lode-cli reads the key from the environment itself.
signature_of() {
  [ -n "${LODE_SIGNING_KEY:-}" ] || return 0
  local sig
  sig="$(NO_COLOR=1 lode-cli sign "$1" --app "${package#*/}" --version "$version" --key-env LODE_SIGNING_KEY | awk '/^sig:/ { print $2 }')" \
    || die "lode-cli sign failed for $(basename "$1")"
  [ -n "$sig" ] || die "lode-cli sign printed no signature for $(basename "$1")"
  printf '%s' "$sig"
}

upload_single() {
  local file="$1" name="$2" sha256="$3" sig="$4"
  local query
  query="sha256=$(urlencode "$sha256")"
  [ -z "$sig" ] || query="$query&sig=$(urlencode "$sig")"
  put_file "$version_url/assets/$name?$query" "$file"
  ok || refused "upload of $name"
}

upload_multipart() {
  local file="$1" name="$2" size="$3" sha256="$4" sig="$5"
  local part_size part_count n
  post_json "$version_url/uploads" "$(jq -n --arg asset "$name" --argjson size "$size" --arg sha256 "$sha256" --arg sig "$sig" \
    '{ asset: $asset, size: $size, sha256: $sha256 } + (if $sig == "" then {} else { sig: $sig } end)')"
  ok || refused "start of the multipart upload of $name"
  upload_id="$(jq -r '.data.uploadId' "$tmp/response")"
  part_size="$(jq -r '.data.partSize' "$tmp/response")"
  part_count="$(jq -r '.data.partCount' "$tmp/response")"

  for ((n = 1; n <= part_count; n++)); do
    # One part at a time goes through a scratch file, removed with $tmp.
    dd if="$file" of="$tmp/part" bs="$part_size" skip="$((n - 1))" count=1 2>/dev/null
    put_file "$api/uploads/$upload_id/parts/$n" "$tmp/part"
    ok || refused "upload of $name, part $n/$part_count"
    echo "publish: $name: part $n/$part_count"
  done
  rm -f "$tmp/part"

  request POST "$api/uploads/$upload_id/complete"
  ok || refused "completion of the multipart upload of $name"
  upload_id=""
}

post_json "${version_url%/*}" "$(jq -n --arg version "$version" --arg notes "$notes" \
  '{ version: $version } + (if $notes == "" then {} else { notes: $notes } end)')"
if ok; then
  echo "publish: created draft $package@$version"
elif [ "$status" = 409 ] && [ "$(jq -r '.error.code // empty' "$tmp/response" 2>/dev/null)" = VERSION_EXISTS ]; then
  # A re-run: continue into the draft an earlier run left.
  request GET "$version_url"
  ok || refused "lookup of $package@$version"
  state="$(jq -r '.data.version.status' "$tmp/response")"
  [ "$state" = draft ] || die "$package@$version is already $state; a released version cannot be changed"
  echo "publish: continuing into the existing draft $package@$version"
else
  refused "creation of the draft $package@$version"
fi

for file in "${files[@]}"; do
  name="$(basename "$file")"
  size="$(size_of "$file")"
  sha256="$(sha256_of "$file")"
  sig="$(signature_of "$file")"
  echo "publish: uploading $name ($size bytes${sig:+, signed})"
  if [ "$size" -le "$SINGLE_REQUEST_MAX" ]; then
    upload_single "$file" "$name" "$sha256" "$sig"
  else
    upload_multipart "$file" "$name" "$size" "$sha256" "$sig"
  fi
done

post_json "$version_url/publish" "$(jq -n --arg channel "$channel" '{ channel: $channel }')"
ok || refused "publication of $package@$version to $channel"
echo "publish: published $package@$version to $channel"
