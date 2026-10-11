# hello — a package to try a release with

The smallest thing that can be published to a lode registry and run by lode:
a shell script, packed into one asset.

| File | Purpose |
|---|---|
| `app.sh` | The application: prints its version and stays up. |
| `build.sh` | Packs `app.sh` and a `VERSION` file into `dist/hello-linux-x64.tar.gz`. |
| `release.sh` | Builds, then publishes with `lode-cli publish`. |
| `lode.toml` | Operator config to run the published package with lode. |

## Publish

1. In the registry console, create a package with the slug `hello`. Note your
   namespace: the package is `<namespace>/hello`.
2. On the Access tokens page, create a token with a `write` grant on it.
3. Put both next to the scripts, in `.env.local` (ignored by git):

   ```bash
   LODE_REGISTRY_TOKEN=pat_...
   LODE_PACKAGE=<namespace>/hello
   # LODE_REGISTRY_URL=http://127.0.0.1:3000   # another registry; include its base path
   # LODE_SIGNING_KEY=<seed>                   # sign the release
   ```

4. Put `lode-cli` on your `PATH`. It is the `lode` binary under another
   name; copy it out of the image:

   ```bash
   cid=$(docker create docker.io/bkhq/lode:latest)
   docker cp "$cid:/usr/bin/lode" ~/.local/bin/lode-cli && docker rm "$cid"
   ```

5. Release:

   ```bash
   ./release.sh 1.0.0
   ./release.sh 1.1.0          # a later version; hosts on `stable` move to it
   ./release.sh 2.0.0-rc.1 beta
   ```

A version can be published once. To try again, use a new version number.

## Run

Fill in `lode.toml` and start lode with it. It installs the version the
channel points at, runs `app.sh`, and switches over when a newer version is
published — try `./release.sh 1.1.0` while it is running.

For a private package, add a token with a `read` grant:

```toml
[http]
headers = ["Authorization: Bearer ${LODE_REGISTRY_TOKEN}"]
```
