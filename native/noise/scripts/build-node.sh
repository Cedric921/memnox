#!/bin/sh
# Builds the Node addon for this machine and drops it beside index.js, where the loader looks.
set -eu
cd "$(dirname "$0")/.."
profile="${1:-release}"
if [ "$profile" = "release" ]; then
  cargo build --release --features node
else
  cargo build --features node
fi
case "$(uname -s)" in
  Darwin) lib="libmemnox_noise.dylib" ;;
  Linux) lib="libmemnox_noise.so" ;;
  *) echo "unsupported platform $(uname -s)" >&2; exit 1 ;;
esac
triple="$(node -p 'process.platform + "-" + process.arch')"
cp "target/$profile/$lib" "memnox-noise.$triple.node"
echo "built memnox-noise.$triple.node"
