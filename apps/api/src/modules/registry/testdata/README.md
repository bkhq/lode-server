# Signature test vectors

`vectors.json` holds artifact signatures produced by the real lode publisher
CLI. `../signature.test.ts` checks that `../signature.ts` rebuilds the same
`lode.artifact.v2` message and accepts exactly these signatures, which is what
proves the server byte-compatible with the lode client.

`manifest-vectors.json` holds two manifests signed by `lode-cli manifest-sign`;
see [Manifest vectors](#manifest-vectors) at the end.

## Provenance

- Tool: `lode-cli 0.0.1` (`lode-cli sign`, `lode-cli keygen`,
  `lode-cli manifest-sign`), a static build of `bkhq/lode` made before the
  release was published.
- Generated: 2026-10-11, with `--network none`.

## Keys

Two throwaway ed25519 keypairs were created by `lode-cli keygen` inside the
container, under its own `/tmp`. Only the public halves were copied out; the
private keys were never written to the mounted directory and were destroyed
with the container. They are used nowhere else.

- `signer` signed every vector.
- `other` signed nothing; it is the "different key" in the rejection tests.

Because the private keys no longer exist, the vectors cannot be reproduced
bit for bit. Regenerating creates new keys, so `signer`, `other` and every
`sig` / `keyId` change together; the `sha256` values stay the same.

## Commands

Run from the repository root. `gen.sh` is the script below, saved into the
scratch directory.

```sh
TMP="$PWD/.tmp/vectors-$$"
mkdir -p "$TMP"
# write gen.sh (below) to "$TMP/gen.sh"
# BIN is the directory holding the static `lode` and its `lode-cli` symlink.
docker run --rm --label ai-agent=true --network none \
  -v "$TMP:/data" -v "$BIN:/lodebin:ro" -e PATH=/lodebin:/usr/bin:/bin \
  --entrypoint /bin/sh oven/bun:1.4.2-slim /data/gen.sh
```

`gen.sh`:

```sh
set -eu
# Private keys stay on the container filesystem and vanish with the container.
lode-cli keygen --alg ed25519 --out /tmp/signer > /dev/null
lode-cli keygen --alg ed25519 --out /tmp/other > /dev/null
cp /tmp/signer.pub /tmp/other.pub /data/

mkdir -p /data/assets /data/out
sign() { # id, asset filename, version, content, extra lode-cli flags...
  id=$1; name=$2; version=$3; content=$4; shift 4
  printf '%s' "$content" > "/data/assets/$name"
  lode-cli sign "/data/assets/$name" --app tool --version "$version" --key /tmp/signer.key "$@" > "/data/out/$id.txt"
}
sign plain    demo-linux-x86_64.tar.gz 1.0.0 'lode test vector: plain asset'
sign run      demo-run.tar.gz          1.2.3 'lode test vector: asset with run'  --run './demo serve --port 8080'
sign exec     demo-exec.zip            1.2.3 'lode test vector: asset with exec' --exec './demo'
sign run-exec demo-both.tar.gz         1.2.3 'lode test vector: asset with run and exec' --run './demo serve' --exec './demo'
sign version  demo_tool-1.x.bin        2.0.0-rc.1_build-7 'lode test vector: version with dot, dash and underscore'
```

Each asset is a file whose bytes are the `content` string, with no trailing
newline; its basename is the signed `name`. Every vector is signed for the
app `tool`, so the tests upload them into a package of that slug.

## Transcription into `vectors.json`

No value is computed outside the CLI. Per vector:

| JSON field | Source |
|---|---|
| `app` | the `--app` passed to `lode-cli sign` |
| `name`, `version`, `run`, `exec` | the arguments passed to `lode-cli sign` (`null` when the flag was not passed) |
| `content` | the bytes written to the asset file |
| `sha256`, `sig`, `keyId`, `alg` | the `sha256:`, `sig:`, `key_id:`, `alg:` lines `lode-cli sign` printed to `out/<id>.txt` |

`signer` and `other` come from `signer.pub` and `other.pub`, which
`lode-cli keygen --out` writes as `<key_id> <public key>`.

## Manifest vectors

`manifest-vectors.json` holds one manifest signed twice by the real
`lode-cli manifest-sign`: `signed` without an expiry, `fresh` with
`--expires-in 30d`. `../signature.test.ts` rebuilds the canonical catalog and
both signed messages from them and checks lode's signatures verify.

- Generated in the same run as the asset vectors, with a keypair of its own
  (`manifest-signer`); only the public half was copied out, so the vectors
  cannot be reproduced bit for bit.
- The input manifest lists its channels and versions out of order, has a
  version (`1.10.0`) that sorts differently by bytes than by semver, a
  version with no assets and assets with and without `run` / `exec`. Asset
  digests are the sha256 of `a`, `b` and `c`.

```sh
lode-cli keygen --alg ed25519 --out /tmp/manifest-signer > /dev/null
cp /tmp/manifest-signer.pub /data/
cp /data/base.json /data/signed.json
lode-cli manifest-sign --into /data/signed.json --key /tmp/manifest-signer.key
cp /data/base.json /data/fresh.json
lode-cli manifest-sign --into /data/fresh.json --key /tmp/manifest-signer.key --expires-in 30d
```

`signer` is `manifest-signer.pub`; `signed` and `fresh` are the two output files,
verbatim (`manifest-sign` rewrites the file with sorted keys).
