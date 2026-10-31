#!/bin/sh
# Package the desktop agent into public/downloads/, so this instance offers a
# download of its own instead of a release asset that may not exist yet.
#
#   npm run agent:package
#
# The release workflow builds the same tarball from the same sources and
# attaches it to the tag, so a checkout and a release ship the same thing.
set -eu

cd "$(git rev-parse --show-toplevel)"

version="$(node -p 'require("./package.json").version')"
out="public/downloads"
asset="saale-agent-${version}-x86_64-linux.tar.gz"

if command -v cargo >/dev/null 2>&1; then
  SAALE_AGENT_VERSION="$version" cargo build --release --manifest-path desktop/Cargo.toml
else
  cargo_bin="$HOME/.cargo/bin/cargo"
  if [ -x "$cargo_bin" ]; then
    SAALE_AGENT_VERSION="$version" "$cargo_bin" build --release --manifest-path desktop/Cargo.toml
  else
    echo "cargo is not installed; see https://rustup.rs" >&2
    exit 1
  fi
fi

mkdir -p "$out" staging
cp desktop/target/release/saale-agent staging/saale-agent
cp desktop/README.md staging/README.md
tar -czf "$out/$asset" -C staging saale-agent README.md
rm -rf staging

echo "Packaged $out/$asset"
echo "The settings page now offers /downloads/$asset"
