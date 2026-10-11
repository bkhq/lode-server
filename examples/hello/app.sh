#!/bin/sh
# The application lode runs: it reports its version, then stays up the way a
# service would.
dir="$(dirname "$0")"
echo "hello $(cat "$dir/VERSION")"
exec sleep infinity
