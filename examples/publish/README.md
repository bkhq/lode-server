# Publishing from GitHub Actions

`publish.yml` is a workflow for a **package publisher's own repository**. On
a published GitHub release (or a manual run with a version) it builds the
assets and releases them to a lode registry with `lode-cli publish`: draft →
upload → publish to a channel. It is an example and does not run here.

## Set up

1. Copy `publish.yml` to `.github/workflows/publish.yml` in your repository.
2. Replace the **Build release assets** step with your build. It has to leave
   the assets in `dist/`; each file is published under its file name.
3. Pin `LODE_IMAGE` (where `lode-cli` comes from) to a version you have
   reviewed. The `-mini` tags (`v0.4.0-mini`, `latest-mini`) hold only the
   binary, which is all the workflow copies out.
4. Configure the repository (Settings → Secrets and variables → Actions):

| Kind | Name | Value |
|---|---|---|
| Secret | `LODE_REGISTRY_TOKEN` | A registry token with a `write` grant on `<namespace>/<slug>` and nothing else. |
| Secret | `LODE_SIGNING_KEY` | Optional. The private key seed from `lode-cli keygen`. `lode-cli publish` registers its public half for the package, then signs every asset. Without it the assets are published unsigned. |
| Variable | `LODE_REGISTRY_URL` | Optional. Base URL of another registry; unset, the release goes to `https://lode.bk.io/u`. Give the URL up to and including the registry's base path. |
| Variable | `LODE_PACKAGE` | The package, as `<namespace>/<slug>`. |

## Behaviour worth knowing

- The version is the release tag without its leading `v`; a release goes to
  the `stable` channel, a manual run to the channel it is given.
- A failed run can be started again for the same version: the command
  continues into the existing draft and re-uploaded assets replace the
  earlier ones. A version that is already published cannot be released again.
- Assets up to 95 MiB go up in one request, larger ones (up to 500 MiB) as a
  multipart upload.

## Signing the manifest

`sign-manifest.yml` is optional. Copy it next to `publish.yml` when your
operators want `[trust].require_manifest`: it downloads the manifest the
registry generates, signs it with `lode-cli manifest-sign` and sends the
signature back — after every run of the publish workflow, once a week, and
on demand. It uses the same secrets and variables as `publish.yml`;
`LODE_SIGNING_KEY` is required here. The signature is valid for 30 days, so
the weekly run renews it with room to spare.

It signs a changed manifest only when the channels are the expected ones:
after a publish started by a GitHub release, `stable` at that release's
version. The weekly run renews a manifest nothing has changed in, and fails
otherwise. After a publish started by hand, a channel move, a yank or a
restore, start it by hand and give every channel in `expect`
(`stable=1.4.2 beta=1.5.0-rc1`). A package with more channels than `stable`
always needs that.

`lode-cli publish --help` lists every option. Where `lode-cli` cannot be
installed, [`scripts/publish.sh`](../../scripts/publish.sh) does the same
release with `bash`, `curl`, `jq` and `openssl`.
