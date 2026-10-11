#!/bin/sh
# Copyright (C) 2026 Nick Germaine
# SPDX-License-Identifier: GPL-3.0-only
#
# BitFrost is free software: you can share and change it under the GNU General
# Public License, version 3 only. It comes with no warranty. See LICENSE.

# Builds dist/bitfrost-<version>.tar.gz, its .sha256, and dist/install.sh
# stamped to install that version. Also builds this machine's config screen
# next to them, so install.sh --from picks it up; --no-tui skips that.
set -eu

tui=1
[ "${1:-}" != --no-tui ] || tui=

cd "$(dirname "$0")/.."

# Reproducible archives need GNU tar; Homebrew installs it as gtar.
archive_tar=
for candidate in gtar tar; do
  if "$candidate" --version 2>/dev/null | grep -q 'GNU tar'; then
    archive_tar=$candidate
    break
  fi
done
if [ -z "$archive_tar" ]; then
  echo "build.sh: GNU tar is required (on macOS: brew install gnu-tar)" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then sum="sha256sum"; else sum="shasum -a 256"; fi

version=$(node -p 'JSON.parse(require("fs").readFileSync("plugins/bitfrost/.claude-plugin/plugin.json", "utf8")).version')
name=bitfrost-$version
out=dist/$name

rm -rf "$out" "dist/$name.tar.gz" "dist/$name.tar.gz.sha256" dist/install.sh
mkdir -p "$out/.claude-plugin" "$out/plugins"
cp LICENSE README.md "$out/"
cp -R plugins/bitfrost "$out/plugins/"
rm -rf "$out/plugins/bitfrost/daemon/test" \
  "$out/plugins/bitfrost/hooks/register.test.ts" \
  "$out/plugins/bitfrost/.claude-plugin/types" \
  "$out/plugins/bitfrost/tsconfig.json"

node -e '
  const fs = require("fs")
  const m = JSON.parse(fs.readFileSync(".claude-plugin/marketplace.json", "utf8"))
  m.plugins = m.plugins.filter((p) => p.name === "bitfrost")
  if (m.plugins.length !== 1) throw new Error("marketplace.json has no bitfrost plugin")
  fs.writeFileSync(process.argv[1], JSON.stringify(m, null, 2) + "\n")
' "$out/.claude-plugin/marketplace.json"

# Fixed order, owner and times make the build repeatable.
mtime=$(git log -1 --format=%cI 2>/dev/null || echo 2026-01-01T00:00:00Z)
# No pipe: sh would only see gzip's exit status.
"$archive_tar" --sort=name --owner=0 --group=0 --numeric-owner --mtime="$mtime" \
  -C dist -cf "dist/$name.tar" "$name"
gzip -n "dist/$name.tar"
(cd dist && $sum "$name.tar.gz" >"$name.tar.gz.sha256")
rm -rf "$out"

sed "s/^RELEASE=\$/RELEASE=$version/" release/install.sh >dist/install.sh
grep -qx "RELEASE=$version" dist/install.sh || { echo "build.sh: couldn't stamp install.sh" >&2; exit 1; }

# Named the way install.sh looks for it. CI builds the shipped ones itself.
case "$(uname -s) $(uname -m)" in
  "Linux x86_64") platform=linux-x64 ;;
  "Linux aarch64") platform=linux-arm64 ;;
  Darwin\ *) platform=darwin-universal ;;
  *) platform= ;;
esac
if [ -n "$tui" ] && [ -n "$platform" ]; then
  if command -v cmake >/dev/null 2>&1; then
    asset=bitfrost-tui-$version-$platform
    release/build-tui.sh "dist/$asset" >&2
    (cd dist && $sum "$asset" >"$asset.sha256")
  else
    echo "build.sh: no cmake, so the config screen wasn't built" >&2
  fi
fi
echo "$version"
