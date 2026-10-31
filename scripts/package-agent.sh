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

# The AppImage is what a release attaches, and what linuxdeploy makes there. It
# needs linuxdeploy on the PATH, so a checkout packages the tarball alone unless
# one is available.
if command -v linuxdeploy >/dev/null 2>&1; then
  appdir="$(mktemp -d)"
  mkdir -p "$appdir/usr/bin"
  install -m 755 desktop/target/release/saale-agent "$appdir/usr/bin/saale-agent"
  install -m 644 packaging/saale-agent.desktop "$appdir/saale-agent.desktop"
  install -m 644 packaging/saale-agent.png "$appdir/saale-agent.png"

  # libxkbcommon-x11 is opened by name at runtime, so linuxdeploy cannot see it
  # through the binary's own dependencies. Hand it over explicitly or the window
  # fails to open on a machine that does not have it installed.
  xkb="$(ldconfig -p 2>/dev/null | awk '/libxkbcommon-x11\.so\.0 /{print $NF; exit}')"
  if [ -z "$xkb" ]; then
    echo "libxkbcommon-x11 is not installed; the AppImage would not open a window" >&2
    exit 1
  fi

  APPIMAGE_EXTRACT_AND_RUN=1 LINUXDEPLOY_OUTPUT_VERSION="$version" linuxdeploy \
    --appdir "$appdir" \
    --executable "$appdir/usr/bin/saale-agent" \
    --desktop-file "$appdir/saale-agent.desktop" \
    --icon-file "$appdir/saale-agent.png" \
    --library "$xkb" \
    --output appimage
  mv ./*.AppImage "$out/saale-agent-${version}-x86_64.AppImage" 2>/dev/null || true
  rm -rf "$appdir"
  echo "Packaged $out/saale-agent-${version}-x86_64.AppImage"
fi

echo "The settings page now offers /downloads/ for this instance"
